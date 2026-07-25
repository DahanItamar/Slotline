import type {
  CreateUserRequest,
  CreateUserResponse,
  MembershipRole,
  UpdateUserRequest,
  UserDto,
} from '@slotline/shared';
import type { UserRow } from '../db/types.js';
import { withTenant, type TenantTransaction } from '../db/with-tenant.js';
import { conflict, forbidden, isPostgresError, notFound, PG_ERROR } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { generateTemporaryPassword, hashPassword } from '../lib/password.js';
import { destroyAllSessionsForUser } from './auth-service.js';

/**
 * Managing the people in a workspace. SPEC §9.
 *
 * Runs on the tenant-scoped connection, so RLS decides which users exist as far as this
 * service is concerned — an id from another organisation simply is not found. Contrast
 * `auth-service`, which necessarily works before any tenant context exists.
 */

const toUserDto = (row: UserRow): UserDto => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  role: row.role,
  isActive: row.is_active,
  mustChangePassword: row.must_change_password,
});

export async function listUsers(tenantId: string): Promise<UserDto[]> {
  const rows = await withTenant(tenantId, (trx) =>
    trx.selectFrom('users').selectAll().orderBy('display_name').execute(),
  );
  return rows.map(toUserDto);
}

export async function createUser(
  tenantId: string,
  actor: { id: string; role: MembershipRole },
  request: CreateUserRequest,
): Promise<CreateUserResponse> {
  // Only an owner hands out owner or admin: an admin who could mint another admin can
  // escalate sideways indefinitely, which is the same hole as editing your own role.
  if (request.role !== 'member' && actor.role !== 'owner') {
    throw forbidden('Only an owner can create administrators.');
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  try {
    const row = await withTenant(tenantId, (trx) =>
      trx
        .insertInto('users')
        .values({
          id: newId(),
          tenant_id: tenantId,
          email: request.email,
          password_hash: passwordHash,
          display_name: request.displayName,
          role: request.role,
          must_change_password: true,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
    return { user: toUserDto(row), temporaryPassword };
  } catch (error) {
    if (isPostgresError(error, PG_ERROR.UNIQUE_VIOLATION)) {
      throw conflict('EMAIL_TAKEN', 'Someone in this workspace already uses that address.');
    }
    throw error;
  }
}

/** Owners still standing after a hypothetical change. Guards the last one. */
async function activeOwnerCount(trx: TenantTransaction, excludingUserId: string): Promise<number> {
  const rows = await trx
    .selectFrom('users')
    .select('id')
    .where('role', '=', 'owner')
    .where('is_active', '=', true)
    .where('id', '!=', excludingUserId)
    .execute();
  return rows.length;
}

export async function updateUser(
  tenantId: string,
  actor: { id: string; role: MembershipRole },
  targetUserId: string,
  request: UpdateUserRequest,
): Promise<UserDto> {
  if (request.role !== undefined && actor.role !== 'owner') {
    throw forbidden('Only an owner can change roles.');
  }

  const { user, deactivated } = await withTenant(tenantId, async (trx) => {
    const target = await trx
      .selectFrom('users')
      .selectAll()
      .where('id', '=', targetUserId)
      .executeTakeFirst();
    if (!target) throw notFound('User');

    // Nobody edits their own role, whatever it is. This is the privilege-escalation
    // check that matters most: without it, "admin" is advisory.
    if (target.id === actor.id && request.role !== undefined) {
      throw conflict('CANNOT_DEMOTE_SELF', 'You cannot change your own role.');
    }
    if (target.id === actor.id && request.isActive === false) {
      throw conflict('CANNOT_DEMOTE_SELF', 'You cannot deactivate your own account.');
    }

    // Losing the last owner leaves a workspace nobody can administer, and there is no
    // support desk to undo it.
    const losesOwnership =
      target.role === 'owner' &&
      ((request.role !== undefined && request.role !== 'owner') || request.isActive === false);
    if (losesOwnership && (await activeOwnerCount(trx, target.id)) === 0) {
      throw conflict('LAST_OWNER', 'A workspace must keep at least one active owner.');
    }

    const updated = await trx
      .updateTable('users')
      .set({
        ...(request.role !== undefined ? { role: request.role } : {}),
        ...(request.isActive !== undefined ? { is_active: request.isActive } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', targetUserId)
      .returningAll()
      .executeTakeFirstOrThrow();

    return { user: updated, deactivated: request.isActive === false };
  });

  // Revocation is immediate: a deactivated account must not keep working until its
  // cookie happens to expire. SPEC §9.
  if (deactivated) await destroyAllSessionsForUser(targetUserId);

  return toUserDto(user);
}

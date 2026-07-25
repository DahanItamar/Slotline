import { createHash, randomBytes } from 'node:crypto';
import {
  type ChangePasswordRequest,
  type LoginRequest,
  SESSION_TTL_DAYS,
  type SessionDto,
  type SignupRequest,
  type TenantDto,
  type UserDto,
} from '@slotline/shared';
import { authDb } from '../db/index.js';
import type { TenantRow, UserRow } from '../db/types.js';
import { isValidTimeZone } from '../domain/time.js';
import { AppError, conflict, isPostgresError, PG_ERROR, unprocessable } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { burnPasswordComparison, hashPassword, verifyPassword } from '../lib/password.js';

/**
 * The ONLY module permitted to use `authDb()`. Every query below runs before a tenant
 * context exists — a login has to find the tenant before it can scope to it — which is
 * exactly why this connection is separate and granted on three tables. SPEC §9.
 */

const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
/** Only rewrite `expires_at` once the session has aged a day, to keep logins write-light. */
const SLIDING_REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export type IssuedSession = SessionDto & { token: string };

const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active,
    mustChangePassword: row.must_change_password,
  };
}

function toTenantDto(row: TenantRow): TenantDto {
  return { id: row.id, slug: row.slug, name: row.name, timezone: row.timezone };
}

const invalidCredentials = (): AppError =>
  new AppError('INVALID_CREDENTIALS', 401, 'Those sign-in details are not right.');

async function issueSession(tenantId: string, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await authDb()
    .insertInto('sessions')
    .values({
      token_hash: hashToken(token),
      tenant_id: tenantId,
      user_id: userId,
      expires_at: new Date(Date.now() + SESSION_TTL_MS),
    })
    .execute();
  return token;
}

export async function signup(request: SignupRequest): Promise<IssuedSession> {
  if (!isValidTimeZone(request.timezone)) {
    throw unprocessable('INVALID_TIMEZONE', `"${request.timezone}" is not a known time zone.`);
  }

  const passwordHash = await hashPassword(request.password);
  const tenantId = newId();
  const userId = newId();

  try {
    const { tenant, user } = await authDb()
      .transaction()
      .execute(async (trx) => {
        const insertedTenant = await trx
          .insertInto('tenants')
          .values({
            id: tenantId,
            slug: request.tenantSlug,
            name: request.tenantName,
            timezone: request.timezone,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        const insertedUser = await trx
          .insertInto('users')
          .values({
            id: userId,
            tenant_id: tenantId,
            email: request.email,
            password_hash: passwordHash,
            display_name: request.displayName,
            role: 'owner',
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        return { tenant: insertedTenant, user: insertedUser };
      });

    const token = await issueSession(tenant.id, user.id);
    return { token, user: toUserDto(user), tenant: toTenantDto(tenant) };
  } catch (error) {
    if (isPostgresError(error, PG_ERROR.UNIQUE_VIOLATION)) {
      throw conflict('SLUG_TAKEN', 'That workspace address is already taken.');
    }
    throw error;
  }
}

export async function login(request: LoginRequest): Promise<IssuedSession> {
  const tenant = await authDb()
    .selectFrom('tenants')
    .selectAll()
    .where('slug', '=', request.tenantSlug)
    .executeTakeFirst();

  if (!tenant) {
    // Equalise timing so a missing workspace is indistinguishable from a wrong password.
    await burnPasswordComparison();
    throw invalidCredentials();
  }

  const user = await authDb()
    .selectFrom('users')
    .selectAll()
    .where('tenant_id', '=', tenant.id)
    .where('email', '=', request.email)
    .executeTakeFirst();

  if (!user) {
    await burnPasswordComparison();
    throw invalidCredentials();
  }

  const passwordMatches = await verifyPassword(user.password_hash, request.password);
  // Deactivated users fail identically to a wrong password: the endpoint never confirms
  // that an address exists, whatever the reason for the refusal. SPEC §8.
  if (!passwordMatches || !user.is_active) throw invalidCredentials();

  const token = await issueSession(tenant.id, user.id);
  return { token, user: toUserDto(user), tenant: toTenantDto(tenant) };
}

export type ResolvedSession = SessionDto & { tokenHash: Buffer };

/** Called on every authenticated request. Returns null for absent, unknown, or expired. */
export async function resolveSession(token: string): Promise<ResolvedSession | null> {
  const tokenHash = hashToken(token);

  const row = await authDb()
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .innerJoin('tenants', 'tenants.id', 'sessions.tenant_id')
    .select([
      'sessions.expires_at as expires_at',
      'users.id as user_id',
      'users.email as email',
      'users.display_name as display_name',
      'users.role as role',
      'users.is_active as is_active',
      'users.must_change_password as must_change_password',
      'tenants.id as tenant_id',
      'tenants.slug as tenant_slug',
      'tenants.name as tenant_name',
      'tenants.timezone as tenant_timezone',
    ])
    .where('sessions.token_hash', '=', tokenHash)
    .executeTakeFirst();

  if (!row) return null;

  const expiresAt = new Date(row.expires_at).getTime();
  if (expiresAt <= Date.now() || !row.is_active) {
    await destroySession(token);
    return null;
  }

  if (expiresAt - Date.now() < SESSION_TTL_MS - SLIDING_REFRESH_THRESHOLD_MS) {
    await authDb()
      .updateTable('sessions')
      .set({ expires_at: new Date(Date.now() + SESSION_TTL_MS) })
      .where('token_hash', '=', tokenHash)
      .execute();
  }

  return {
    tokenHash,
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      isActive: row.is_active,
      mustChangePassword: row.must_change_password,
    },
    tenant: {
      id: row.tenant_id,
      slug: row.tenant_slug,
      name: row.tenant_name,
      timezone: row.tenant_timezone,
    },
  };
}

export async function destroySession(token: string): Promise<void> {
  await authDb().deleteFrom('sessions').where('token_hash', '=', hashToken(token)).execute();
}

/** Revocation is immediate: deactivating a user or changing a password drops every session. */
export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  await authDb().deleteFrom('sessions').where('user_id', '=', userId).execute();
}

export async function changePassword(
  userId: string,
  request: ChangePasswordRequest,
): Promise<void> {
  const user = await authDb()
    .selectFrom('users')
    .selectAll()
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) throw invalidCredentials();

  if (!(await verifyPassword(user.password_hash, request.currentPassword))) {
    throw invalidCredentials();
  }

  await authDb()
    .updateTable('users')
    .set({
      password_hash: await hashPassword(request.newPassword),
      must_change_password: false,
      updated_at: new Date(),
    })
    .where('id', '=', userId)
    .execute();

  await destroyAllSessionsForUser(userId);
}

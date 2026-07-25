import type {
  CreateResourceRequest,
  ListResourcesQuery,
  ResourceDto,
  UpdateResourceRequest,
} from '@slotline/shared';
import type { ResourceRow } from '../db/types.js';
import { withTenant } from '../db/with-tenant.js';
import { conflict, isPostgresError, notFound, PG_ERROR } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

/**
 * All access goes through `withTenant`, so RLS scopes every statement. Note that nothing
 * below writes `WHERE tenant_id = …` by hand — that is the point: it cannot be forgotten,
 * because the database applies it. SPEC §9.
 */

/** The tenant's zone is the fallback; `resources.timezone` is unexposed in v1 (Assumption 9). */
export function toResourceDto(row: ResourceRow, tenantTimeZone: string): ResourceDto {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    timezone: row.timezone ?? tenantTimeZone,
    userId: row.user_id,
    capacity: row.capacity,
    minMinutes: row.min_minutes,
    maxMinutes: row.max_minutes,
    isActive: row.is_active,
  };
}

export async function listResources(
  tenantId: string,
  tenantTimeZone: string,
  query: ListResourcesQuery,
): Promise<ResourceDto[]> {
  const rows = await withTenant(tenantId, async (trx) => {
    let builder = trx.selectFrom('resources').selectAll().orderBy('kind').orderBy('name');
    if (query.kind) builder = builder.where('kind', '=', query.kind);
    if (!query.includeInactive) builder = builder.where('is_active', '=', true);
    return builder.execute();
  });
  return rows.map((row) => toResourceDto(row, tenantTimeZone));
}

export async function getResource(
  tenantId: string,
  tenantTimeZone: string,
  resourceId: string,
): Promise<ResourceDto> {
  const row = await withTenant(tenantId, (trx) =>
    trx.selectFrom('resources').selectAll().where('id', '=', resourceId).executeTakeFirst(),
  );
  if (!row) throw notFound('Resource');
  return toResourceDto(row, tenantTimeZone);
}

export async function createResource(
  tenantId: string,
  tenantTimeZone: string,
  request: CreateResourceRequest,
): Promise<ResourceDto> {
  try {
    const row = await withTenant(tenantId, (trx) =>
      trx
        .insertInto('resources')
        .values({
          id: newId(),
          tenant_id: tenantId,
          kind: request.kind,
          name: request.name,
          description: request.description,
          capacity: request.capacity,
          user_id: request.userId,
          min_minutes: request.minMinutes,
          max_minutes: request.maxMinutes,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
    return toResourceDto(row, tenantTimeZone);
  } catch (error) {
    if (isPostgresError(error, PG_ERROR.UNIQUE_VIOLATION)) {
      throw conflict('NAME_TAKEN', `A ${request.kind} called "${request.name}" already exists.`);
    }
    if (isPostgresError(error, PG_ERROR.FOREIGN_KEY_VIOLATION)) {
      throw notFound('Linked user');
    }
    throw error;
  }
}

export async function updateResource(
  tenantId: string,
  tenantTimeZone: string,
  resourceId: string,
  request: UpdateResourceRequest,
): Promise<ResourceDto> {
  try {
    const row = await withTenant(tenantId, (trx) =>
      trx
        .updateTable('resources')
        .set({
          ...(request.name !== undefined ? { name: request.name } : {}),
          ...(request.description !== undefined ? { description: request.description } : {}),
          ...(request.capacity !== undefined ? { capacity: request.capacity } : {}),
          ...(request.userId !== undefined ? { user_id: request.userId } : {}),
          ...(request.minMinutes !== undefined ? { min_minutes: request.minMinutes } : {}),
          ...(request.maxMinutes !== undefined ? { max_minutes: request.maxMinutes } : {}),
          ...(request.isActive !== undefined ? { is_active: request.isActive } : {}),
          updated_at: new Date(),
        })
        .where('id', '=', resourceId)
        .returningAll()
        .executeTakeFirst(),
    );
    if (!row) throw notFound('Resource');
    return toResourceDto(row, tenantTimeZone);
  } catch (error) {
    if (isPostgresError(error, PG_ERROR.UNIQUE_VIOLATION)) {
      throw conflict('NAME_TAKEN', `Another resource is already called "${request.name ?? ''}".`);
    }
    throw error;
  }
}

/**
 * Hard delete only. `bookings.resource_id ON DELETE RESTRICT` turns a resource with any
 * history into a foreign key violation, which becomes a 409 telling the admin to
 * deactivate instead — deleting would silently take the bookings with it. SPEC §8.
 */
export async function deleteResource(tenantId: string, resourceId: string): Promise<void> {
  try {
    const result = await withTenant(tenantId, (trx) =>
      trx.deleteFrom('resources').where('id', '=', resourceId).executeTakeFirst(),
    );
    if (result.numDeletedRows === 0n) throw notFound('Resource');
  } catch (error) {
    if (isPostgresError(error, PG_ERROR.FOREIGN_KEY_VIOLATION)) {
      throw conflict(
        'RESOURCE_HAS_BOOKINGS',
        'This resource has bookings and cannot be deleted. Deactivate it instead.',
      );
    }
    throw error;
  }
}

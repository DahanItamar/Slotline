import type {
  AvailabilityExceptionDto,
  AvailabilityRuleDto,
  BookingDto,
  CreateAvailabilityExceptionRequest,
  ListExceptionsQuery,
  ReplaceAvailabilityRulesResponse,
  ResourceAvailabilityDto,
} from '@slotline/shared';
import type { TenantTransaction } from '../db/with-tenant.js';
import { withTenant } from '../db/with-tenant.js';
import { hasOverlappingRules, isWithinAvailability } from '../domain/availability.js';
import { conflict, isPostgresError, notFound, PG_ERROR, unprocessable } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { selectBookingsWithCreator, toBookingDto } from './booking-queries.js';

type ExceptionRow = {
  id: string;
  local_date: string;
  is_available: boolean;
  start_minute: number | null;
  end_minute: number | null;
  reason: string;
};

const toExceptionDto = (row: ExceptionRow): AvailabilityExceptionDto => ({
  id: row.id,
  // `date` comes back from pg as a plain string; keep it a calendar date, never an instant.
  localDate: row.local_date.slice(0, 10),
  isAvailable: row.is_available,
  startMinute: row.start_minute,
  endMinute: row.end_minute,
  reason: row.reason,
});

async function loadResourceOrThrow(
  trx: TenantTransaction,
  resourceId: string,
  tenantTimeZone: string,
): Promise<{ id: string; timezone: string }> {
  const resource = await trx
    .selectFrom('resources')
    .select(['id', 'timezone'])
    .where('id', '=', resourceId)
    .executeTakeFirst();
  if (!resource) throw notFound('Resource');
  return { id: resource.id, timezone: resource.timezone ?? tenantTimeZone };
}

function selectRules(trx: TenantTransaction, resourceId: string) {
  return trx
    .selectFrom('availability_rules')
    .select(['weekday', 'start_minute', 'end_minute'])
    .where('resource_id', '=', resourceId)
    .orderBy('weekday')
    .orderBy('start_minute');
}

function selectExceptions(trx: TenantTransaction, resourceId: string) {
  return trx
    .selectFrom('availability_exceptions')
    .select(['id', 'local_date', 'is_available', 'start_minute', 'end_minute', 'reason'])
    .where('resource_id', '=', resourceId)
    .orderBy('local_date');
}

export async function getAvailability(
  tenantId: string,
  tenantTimeZone: string,
  resourceId: string,
): Promise<ResourceAvailabilityDto> {
  return withTenant(tenantId, async (trx) => {
    const resource = await loadResourceOrThrow(trx, resourceId, tenantTimeZone);
    const [rules, exceptions] = await Promise.all([
      selectRules(trx, resourceId).execute(),
      selectExceptions(trx, resourceId).execute(),
    ]);

    return {
      resourceId,
      timezone: resource.timezone,
      rules: rules.map((rule) => ({
        weekday: rule.weekday,
        startMinute: rule.start_minute,
        endMinute: rule.end_minute,
      })),
      exceptions: exceptions.map(toExceptionDto),
    };
  });
}

/**
 * Replaces the whole weekly set in one transaction, so the rules are never observable
 * half-applied. Existing bookings that fall outside the new hours are **kept** and
 * returned to the caller: cancelling someone's meeting as a side effect of an admin
 * editing opening hours would be a surprise, and an unenforceable rule is at least
 * visible. SPEC §8, Open Question 3.
 */
export async function replaceAvailabilityRules(
  tenantId: string,
  tenantTimeZone: string,
  resourceId: string,
  rules: AvailabilityRuleDto[],
): Promise<ReplaceAvailabilityRulesResponse> {
  if (hasOverlappingRules(rules)) {
    throw unprocessable(
      'OVERLAPPING_RULES',
      'Two opening windows on the same day overlap. Merge them into one.',
    );
  }

  return withTenant(tenantId, async (trx) => {
    const resource = await loadResourceOrThrow(trx, resourceId, tenantTimeZone);

    await trx.deleteFrom('availability_rules').where('resource_id', '=', resourceId).execute();
    if (rules.length > 0) {
      await trx
        .insertInto('availability_rules')
        .values(
          rules.map((rule) => ({
            id: newId(),
            tenant_id: tenantId,
            resource_id: resourceId,
            weekday: rule.weekday,
            start_minute: rule.startMinute,
            end_minute: rule.endMinute,
          })),
        )
        .execute();
    }

    const exceptions = (await selectExceptions(trx, resourceId).execute()).map(toExceptionDto);
    const conflictingBookings = await findBookingsOutside(trx, {
      resourceId,
      timeZone: resource.timezone,
      rules,
      exceptions,
    });

    return { rules, conflictingBookings };
  });
}

/** Future confirmed bookings this resource can no longer honour under the given rules. */
async function findBookingsOutside(
  trx: TenantTransaction,
  against: {
    resourceId: string;
    timeZone: string;
    rules: readonly AvailabilityRuleDto[];
    exceptions: readonly AvailabilityExceptionDto[];
  },
): Promise<BookingDto[]> {
  const upcoming = await selectBookingsWithCreator(trx)
    .where('bookings.resource_id', '=', against.resourceId)
    .where('bookings.status', '=', 'confirmed')
    .where('bookings.ends_at', '>', new Date())
    .orderBy('bookings.starts_at')
    .execute();

  return upcoming
    .filter(
      (row) =>
        !isWithinAvailability({
          startsAt: new Date(row.starts_at),
          endsAt: new Date(row.ends_at),
          timeZone: against.timeZone,
          rules: against.rules,
          exceptions: against.exceptions,
        }),
    )
    .map(toBookingDto);
}

export async function listExceptions(
  tenantId: string,
  resourceId: string,
  query: ListExceptionsQuery,
): Promise<AvailabilityExceptionDto[]> {
  const rows = await withTenant(tenantId, (trx) =>
    selectExceptions(trx, resourceId)
      .where('local_date', '>=', query.from)
      .where('local_date', '<=', query.to)
      .execute(),
  );
  return rows.map(toExceptionDto);
}

export async function createException(
  tenantId: string,
  tenantTimeZone: string,
  resourceId: string,
  request: CreateAvailabilityExceptionRequest,
): Promise<AvailabilityExceptionDto> {
  try {
    const row = await withTenant(tenantId, async (trx) => {
      await loadResourceOrThrow(trx, resourceId, tenantTimeZone);
      return trx
        .insertInto('availability_exceptions')
        .values({
          id: newId(),
          tenant_id: tenantId,
          resource_id: resourceId,
          local_date: request.localDate,
          is_available: request.isAvailable,
          start_minute: request.startMinute,
          end_minute: request.endMinute,
          reason: request.reason,
        })
        .returning(['id', 'local_date', 'is_available', 'start_minute', 'end_minute', 'reason'])
        .executeTakeFirstOrThrow();
    });
    return toExceptionDto(row);
  } catch (error) {
    if (isPostgresError(error, PG_ERROR.UNIQUE_VIOLATION)) {
      throw conflict(
        'EXCEPTION_EXISTS',
        'This resource already has an override on that date. Remove it first.',
      );
    }
    throw error;
  }
}

export async function deleteException(tenantId: string, exceptionId: string): Promise<void> {
  const result = await withTenant(tenantId, (trx) =>
    trx.deleteFrom('availability_exceptions').where('id', '=', exceptionId).executeTakeFirst(),
  );
  if (result.numDeletedRows === 0n) throw notFound('Availability override');
}

import { sql } from 'kysely';
import type {
  AvailabilityExceptionDto,
  AvailabilityRuleDto,
  BookingDto,
  SlotTakenDetails,
} from '@slotline/shared';
import type { TenantTransaction } from '../db/with-tenant.js';
import { withTenant } from '../db/with-tenant.js';
import { conflict } from '../lib/errors.js';

/**
 * The reads and shapes every booking path shares. Split out so creating a booking and
 * changing one can live in separate files without either importing the other, and so
 * `availability-service` can ask "which bookings no longer fit?" without pulling in the
 * whole booking machinery.
 */

export type BookingWithCreator = {
  id: string;
  resource_id: string;
  created_by_user_id: string;
  display_name: string;
  title: string;
  notes: string;
  starts_at: Date;
  ends_at: Date;
  status: 'confirmed' | 'cancelled';
  version: number;
};

export const toBookingDto = (row: BookingWithCreator): BookingDto => ({
  id: row.id,
  resourceId: row.resource_id,
  createdByUserId: row.created_by_user_id,
  createdByDisplayName: row.display_name,
  title: row.title,
  notes: row.notes,
  startsAt: new Date(row.starts_at).toISOString(),
  endsAt: new Date(row.ends_at).toISOString(),
  status: row.status,
  version: row.version,
});

export function selectBookingsWithCreator(trx: TenantTransaction) {
  return trx
    .selectFrom('bookings')
    .innerJoin('users', 'users.id', 'bookings.created_by_user_id')
    .select([
      'bookings.id as id',
      'bookings.resource_id as resource_id',
      'bookings.created_by_user_id as created_by_user_id',
      'users.display_name as display_name',
      'bookings.title as title',
      'bookings.notes as notes',
      'bookings.starts_at as starts_at',
      'bookings.ends_at as ends_at',
      'bookings.status as status',
      'bookings.version as version',
    ]);
}

/**
 * Only the booking's own local date matters, so the exception query stays a point lookup
 * however many years of holidays a resource accumulates.
 */
export async function loadAvailabilityForDay(
  trx: TenantTransaction,
  resourceId: string,
  localDate: string,
): Promise<{ rules: AvailabilityRuleDto[]; exceptions: AvailabilityExceptionDto[] }> {
  const [ruleRows, exceptionRows] = await Promise.all([
    trx
      .selectFrom('availability_rules')
      .select(['weekday', 'start_minute', 'end_minute'])
      .where('resource_id', '=', resourceId)
      .execute(),
    trx
      .selectFrom('availability_exceptions')
      .select(['id', 'local_date', 'is_available', 'start_minute', 'end_minute', 'reason'])
      .where('resource_id', '=', resourceId)
      .where('local_date', '=', localDate)
      .execute(),
  ]);

  return {
    rules: ruleRows.map((rule) => ({
      weekday: rule.weekday,
      startMinute: rule.start_minute,
      endMinute: rule.end_minute,
    })),
    exceptions: exceptionRows.map((exception) => ({
      id: exception.id,
      localDate: exception.local_date.slice(0, 10),
      isAvailable: exception.is_available,
      startMinute: exception.start_minute,
      endMinute: exception.end_minute,
      reason: exception.reason,
    })),
  };
}

/**
 * Builds the 409 for an exclusion violation. Runs in a fresh transaction because the one
 * that raised 23P01 has already rolled back and can no longer be read from.
 *
 * Reports the window that won and nothing about who booked it (Open Question 1).
 */
export async function slotTaken(
  tenantId: string,
  resourceId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<Error> {
  const winner = await withTenant(tenantId, (trx) =>
    trx
      .selectFrom('bookings')
      .select(['starts_at', 'ends_at'])
      .where('resource_id', '=', resourceId)
      .where('status', '=', 'confirmed')
      .where(sql<boolean>`period && tstzrange(${startsAt}, ${endsAt}, '[)')`)
      .executeTakeFirst(),
  );

  const details: SlotTakenDetails | undefined = winner
    ? {
        conflictingStartsAt: new Date(winner.starts_at).toISOString(),
        conflictingEndsAt: new Date(winner.ends_at).toISOString(),
      }
    : undefined;

  return conflict('SLOT_TAKEN', 'That time was just booked by someone else.', details);
}

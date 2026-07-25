import { sql } from 'kysely';
import type { BookingDto, MembershipRole, UpdateBookingRequest } from '@slotline/shared';
import { withTenant, type TenantTransaction } from '../db/with-tenant.js';
import { assertWithinAvailability } from '../domain/availability.js';
import { assertValidBookingWindow } from '../domain/booking-rules.js';
import { localDateOf } from '../domain/time.js';
import {
  AppError,
  conflict,
  forbidden,
  isPostgresError,
  notFound,
  PG_ERROR,
} from '../lib/errors.js';
import { recordBookingEvent } from './booking-events.js';
import {
  loadAvailabilityForDay,
  selectBookingsWithCreator,
  slotTaken,
  toBookingDto,
} from './booking-queries.js';

/**
 * Changing a booking after it exists: cancelling and rescheduling. SPEC §7 Flow C.
 */

export type BookingActor = {
  tenantId: string;
  tenantTimeZone: string;
  userId: string;
  role: MembershipRole;
};

/**
 * Members may touch only what they created; admins and owners may touch anything in the
 * workspace. Enforced here rather than in a route guard because the answer depends on
 * the row, which the route has not loaded. SPEC §9.
 */
function assertMayModify(actor: BookingActor, booking: { created_by_user_id: string }): void {
  if (actor.role === 'member' && booking.created_by_user_id !== actor.userId) {
    throw forbidden('You can only change bookings you made.');
  }
}

export async function cancelBooking(actor: BookingActor, bookingId: string): Promise<BookingDto> {
  return withTenant(actor.tenantId, async (trx) => {
    const existing = await trx
      .selectFrom('bookings')
      .select(['id', 'status', 'created_by_user_id'])
      .where('id', '=', bookingId)
      .executeTakeFirst();

    if (!existing) throw notFound('Booking');
    assertMayModify(actor, existing);
    if (existing.status === 'cancelled') {
      throw conflict('ALREADY_CANCELLED', 'That booking is already cancelled.');
    }

    // The slot is freed by this alone: `bookings_no_overlap` is partial on
    // `status = 'confirmed'`, so a cancelled row leaves the index and the window opens.
    await trx
      .updateTable('bookings')
      .set({
        status: 'cancelled',
        cancelled_at: new Date(),
        cancelled_by_user_id: actor.userId,
        version: sql<number>`version + 1`,
        updated_at: new Date(),
      })
      .where('id', '=', bookingId)
      .execute();

    const updated = await selectBookingsWithCreator(trx)
      .where('bookings.id', '=', bookingId)
      .executeTakeFirstOrThrow();
    const cancelled = toBookingDto(updated);

    await recordBookingEvent(trx, {
      tenantId: actor.tenantId,
      type: 'booking.cancelled',
      actorUserId: actor.userId,
      booking: cancelled,
    });

    return cancelled;
  });
}

/**
 * Move or retitle a booking.
 *
 * `expectedVersion` comes from the client's `If-Match`, and is checked in the UPDATE's
 * own WHERE clause rather than by reading first and writing after — a read-then-write
 * leaves a window in which someone else's change is silently overwritten.
 */
export async function rescheduleBooking(
  actor: BookingActor,
  bookingId: string,
  request: UpdateBookingRequest,
  expectedVersion: number,
): Promise<BookingDto> {
  const startsAt = request.startsAt ? new Date(request.startsAt) : null;
  const endsAt = request.endsAt ? new Date(request.endsAt) : null;

  try {
    return await withTenant(actor.tenantId, async (trx) => {
      const existing = await trx
        .selectFrom('bookings')
        .select(['id', 'status', 'created_by_user_id', 'resource_id', 'version'])
        .where('id', '=', bookingId)
        .executeTakeFirst();

      if (!existing) throw notFound('Booking');
      assertMayModify(actor, existing);
      if (existing.status === 'cancelled') {
        throw conflict('ALREADY_CANCELLED', 'A cancelled booking cannot be changed.');
      }

      if (startsAt && endsAt) {
        await assertMovable(trx, existing.resource_id, actor.tenantTimeZone, { startsAt, endsAt });
      }

      const result = await trx
        .updateTable('bookings')
        .set({
          ...(startsAt && endsAt ? { starts_at: startsAt, ends_at: endsAt } : {}),
          ...(request.title !== undefined ? { title: request.title } : {}),
          ...(request.notes !== undefined ? { notes: request.notes } : {}),
          version: sql<number>`version + 1`,
          updated_at: new Date(),
        })
        .where('id', '=', bookingId)
        .where('version', '=', expectedVersion)
        .executeTakeFirst();

      if (result.numUpdatedRows === 0n) {
        throw new AppError(
          'VERSION_CONFLICT',
          412,
          'Someone else changed this booking. Reload and try again.',
          { currentVersion: existing.version },
        );
      }

      const updated = await selectBookingsWithCreator(trx)
        .where('bookings.id', '=', bookingId)
        .executeTakeFirstOrThrow();
      const moved = toBookingDto(updated);

      await recordBookingEvent(trx, {
        tenantId: actor.tenantId,
        type: 'booking.rescheduled',
        actorUserId: actor.userId,
        booking: moved,
      });

      return moved;
    });
  } catch (error) {
    // Same guarantee as creation: the constraint, not a prior read, is what decides.
    // The transaction above has rolled back, so the resource is re-read on a fresh one
    // rather than carried out of the closure.
    if (isPostgresError(error, PG_ERROR.EXCLUSION_VIOLATION) && startsAt && endsAt) {
      const resourceId = await resourceIdOf(actor.tenantId, bookingId);
      if (resourceId) throw await slotTaken(actor.tenantId, resourceId, startsAt, endsAt);
    }
    throw error;
  }
}

async function resourceIdOf(tenantId: string, bookingId: string): Promise<string | null> {
  const row = await withTenant(tenantId, (trx) =>
    trx.selectFrom('bookings').select('resource_id').where('id', '=', bookingId).executeTakeFirst(),
  );
  return row?.resource_id ?? null;
}

/** Window shape plus availability, for a move. The overlap check is the UPDATE itself. */
async function assertMovable(
  trx: TenantTransaction,
  resourceId: string,
  tenantTimeZone: string,
  window: { startsAt: Date; endsAt: Date },
): Promise<void> {
  const resource = await trx
    .selectFrom('resources')
    .select(['is_active', 'timezone', 'min_minutes', 'max_minutes'])
    .where('id', '=', resourceId)
    .executeTakeFirstOrThrow();

  if (!resource.is_active) {
    throw conflict('RESOURCE_INACTIVE', 'This resource is not taking bookings.');
  }

  const timeZone = resource.timezone ?? tenantTimeZone;
  assertValidBookingWindow(window, {
    timeZone,
    minMinutes: resource.min_minutes,
    maxMinutes: resource.max_minutes,
    now: new Date(),
  });

  const { rules, exceptions } = await loadAvailabilityForDay(
    trx,
    resourceId,
    localDateOf(window.startsAt, timeZone),
  );
  assertWithinAvailability({ ...window, timeZone, rules, exceptions });
}

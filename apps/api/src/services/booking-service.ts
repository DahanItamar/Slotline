import {
  type BookingDto,
  type CreateBookingRequest,
  type ListBookingsQuery,
  MAX_QUERY_RANGE_DAYS,
} from '@slotline/shared';
import { withTenant } from '../db/with-tenant.js';
import { assertWithinAvailability } from '../domain/availability.js';
import { assertValidBookingWindow } from '../domain/booking-rules.js';
import { localDateOf } from '../domain/time.js';
import {
  conflict,
  constraintName,
  isPostgresError,
  notFound,
  PG_ERROR,
  unprocessable,
} from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { recordBookingEvent } from './booking-events.js';
import {
  loadAvailabilityForDay,
  selectBookingsWithCreator,
  slotTaken,
  toBookingDto,
} from './booking-queries.js';

/**
 * Creating and reading bookings. SPEC §7 Flow A.
 *
 * The overlap check is the INSERT itself. There is deliberately no `SELECT … WHERE
 * overlaps` before it: that read tells you what was true a moment ago, and two requests
 * arriving together both read "free" and both insert. `bookings_no_overlap` is evaluated
 * by Postgres at write time, so the second one fails with 23P01 no matter how close
 * together they arrive.
 *
 * Changing an existing booking lives in `booking-lifecycle-service.ts`.
 */

export type CreateBookingResult = {
  booking: BookingDto;
  /** True when an Idempotency-Key replay returned the original booking. */
  replayed: boolean;
};

export async function listBookings(
  tenantId: string,
  query: ListBookingsQuery,
): Promise<BookingDto[]> {
  const from = new Date(query.from);
  const to = new Date(query.to);

  if (to.getTime() <= from.getTime()) {
    throw unprocessable('INVALID_RANGE', 'The end of the range must follow its start.');
  }
  const spanDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
  if (spanDays > MAX_QUERY_RANGE_DAYS) {
    throw unprocessable(
      'RANGE_TOO_WIDE',
      `Ask for at most ${MAX_QUERY_RANGE_DAYS} days at a time.`,
      {
        maxDays: MAX_QUERY_RANGE_DAYS,
      },
    );
  }

  const rows = await withTenant(tenantId, async (trx) => {
    let builder = selectBookingsWithCreator(trx)
      .where('bookings.status', '=', 'confirmed')
      // Half-open on both sides: a booking touching the edge of the window is included
      // only if it actually overlaps it.
      .where('bookings.starts_at', '<', to)
      .where('bookings.ends_at', '>', from)
      .orderBy('bookings.starts_at');

    if (query.resourceId && query.resourceId.length > 0) {
      builder = builder.where('bookings.resource_id', 'in', query.resourceId);
    }
    return builder.execute();
  });

  return rows.map(toBookingDto);
}

export async function listMyBookings(
  tenantId: string,
  userId: string,
  query: { from: string; to: string },
): Promise<BookingDto[]> {
  const rows = await withTenant(tenantId, (trx) =>
    selectBookingsWithCreator(trx)
      .where('bookings.created_by_user_id', '=', userId)
      .where('bookings.status', '=', 'confirmed')
      .where('bookings.starts_at', '<', new Date(query.to))
      .where('bookings.ends_at', '>', new Date(query.from))
      .orderBy('bookings.starts_at')
      .execute(),
  );
  return rows.map(toBookingDto);
}

export async function createBooking(
  context: { tenantId: string; tenantTimeZone: string; userId: string },
  request: CreateBookingRequest,
  idempotencyKey: string,
): Promise<CreateBookingResult> {
  const { tenantId, tenantTimeZone, userId } = context;
  const startsAt = new Date(request.startsAt);
  const endsAt = new Date(request.endsAt);
  const bookingId = newId();

  try {
    const booking = await withTenant(tenantId, async (trx) => {
      const resource = await trx
        .selectFrom('resources')
        .select(['id', 'is_active', 'timezone', 'min_minutes', 'max_minutes'])
        .where('id', '=', request.resourceId)
        .executeTakeFirst();

      if (!resource) throw notFound('Resource');
      if (!resource.is_active) {
        throw conflict('RESOURCE_INACTIVE', 'This resource is not taking bookings.');
      }

      const timeZone = resource.timezone ?? tenantTimeZone;

      // Shape of the window first: this establishes it sits on one local day, which is
      // what makes a single date and minute range meaningful to the availability check.
      assertValidBookingWindow(
        { startsAt, endsAt },
        {
          timeZone,
          minMinutes: resource.min_minutes,
          maxMinutes: resource.max_minutes,
          now: new Date(),
        },
      );

      const { rules, exceptions } = await loadAvailabilityForDay(
        trx,
        request.resourceId,
        localDateOf(startsAt, timeZone),
      );
      assertWithinAvailability({ startsAt, endsAt, timeZone, rules, exceptions });

      // The line that either succeeds or raises 23P01. Nothing else guards the slot.
      await trx
        .insertInto('bookings')
        .values({
          id: bookingId,
          tenant_id: tenantId,
          resource_id: request.resourceId,
          created_by_user_id: userId,
          title: request.title,
          notes: request.notes,
          starts_at: startsAt,
          ends_at: endsAt,
          idempotency_key: idempotencyKey,
        })
        .execute();

      const inserted = await selectBookingsWithCreator(trx)
        .where('bookings.id', '=', bookingId)
        .executeTakeFirstOrThrow();
      const dto = toBookingDto(inserted);

      // Logged and announced inside the same transaction as the booking, so neither the
      // event log nor any connected client can learn about a booking that rolled back.
      await recordBookingEvent(trx, {
        tenantId,
        type: 'booking.created',
        actorUserId: userId,
        booking: dto,
      });

      return dto;
    });

    return { booking, replayed: false };
  } catch (error) {
    const isExclusion = isPostgresError(error, PG_ERROR.EXCLUSION_VIOLATION);
    const isIdempotencyClash =
      isPostgresError(error, PG_ERROR.UNIQUE_VIOLATION) &&
      constraintName(error) === 'bookings_idempotency_idx';

    if (!isExclusion && !isIdempotencyClash) throw error;

    // The transaction has already rolled back, so everything below needs a fresh one —
    // nothing can be read on an aborted connection.
    //
    // The replay check comes first, and the ordering is load-bearing. A retry of a
    // request that already succeeded overlaps *its own* earlier booking, so Postgres
    // raises 23P01 before it ever reaches the idempotency index. Handling the exclusion
    // violation first would make every retry look like someone else took the slot.
    const existing = await findByIdempotencyKey(tenantId, idempotencyKey);
    if (existing) return replayOf(existing, request);

    if (isExclusion) throw await slotTaken(tenantId, request.resourceId, startsAt, endsAt);
    throw conflict('IDEMPOTENCY_KEY_REUSED', 'This request key is already in use.');
  }
}

async function findByIdempotencyKey(
  tenantId: string,
  idempotencyKey: string,
): Promise<BookingDto | null> {
  const row = await withTenant(tenantId, (trx) =>
    selectBookingsWithCreator(trx)
      .where('bookings.idempotency_key', '=', idempotencyKey)
      .executeTakeFirst(),
  );
  return row ? toBookingDto(row) : null;
}

/**
 * A retried request must return the original booking, not a second one. A key reused
 * with different arguments is a client bug, and saying so is more useful than silently
 * handing back an unrelated booking.
 */
function replayOf(existing: BookingDto, request: CreateBookingRequest): CreateBookingResult {
  const sameRequest =
    existing.resourceId === request.resourceId &&
    existing.startsAt === new Date(request.startsAt).toISOString() &&
    existing.endsAt === new Date(request.endsAt).toISOString();

  if (!sameRequest) {
    throw conflict(
      'IDEMPOTENCY_KEY_REUSED',
      'This request key was already used for a different booking.',
    );
  }

  return { booking: existing, replayed: true };
}

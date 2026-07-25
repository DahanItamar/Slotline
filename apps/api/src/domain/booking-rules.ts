import { MAX_FUTURE_DAYS, PAST_GRACE_MINUTES } from '@slotline/shared';
import { unprocessable } from '../lib/errors.js';
import { elapsedMinutes, endsAtLocalMidnight, localDateOf, sameLocalDay } from './time.js';

/**
 * Everything a booking window must satisfy before it reaches the database. Pure: no I/O,
 * no framework, no `pg`. Testable with nothing running. SPEC §4, §7 Flow A step 5.
 *
 * These checks are *not* what prevents double-booking — that is the exclusion constraint,
 * and it is the only thing that can be trusted under concurrency. These rules cover the
 * questions a constraint cannot answer: is the window sane, is it in the past, is it
 * within this resource's limits.
 */

export type BookingWindow = {
  startsAt: Date;
  endsAt: Date;
};

export type WindowConstraints = {
  /** The resource's effective zone: its own, or the tenant's. */
  timeZone: string;
  minMinutes: number;
  maxMinutes: number;
  /** Server time. Passed in rather than read, so tests are deterministic. */
  now: Date;
};

export function assertValidBookingWindow(
  window: BookingWindow,
  constraints: WindowConstraints,
): void {
  const { startsAt, endsAt } = window;
  const { timeZone, minMinutes, maxMinutes, now } = constraints;

  if (!(endsAt.getTime() > startsAt.getTime())) {
    throw unprocessable('INVALID_RANGE', 'A booking must end after it starts.');
  }

  const duration = elapsedMinutes(startsAt, endsAt);
  if (duration < minMinutes || duration > maxMinutes) {
    throw unprocessable(
      'DURATION_OUT_OF_BOUNDS',
      `This resource takes bookings between ${minMinutes} and ${maxMinutes} minutes long.`,
      { minMinutes, maxMinutes, requestedMinutes: duration },
    );
  }

  // Assumption 4: one local calendar day. An end exactly on local midnight belongs to
  // the day it closes, so 22:00-00:00 is a same-day booking, not a spanning one.
  const endsOnBoundary = endsAtLocalMidnight(endsAt, timeZone);
  if (!endsOnBoundary && !sameLocalDay(startsAt, endsAt, timeZone)) {
    throw unprocessable(
      'SPANS_MIDNIGHT',
      'A booking must start and end on the same day. Multi-day bookings are not supported yet.',
      { startsOn: localDateOf(startsAt, timeZone), endsOn: localDateOf(endsAt, timeZone) },
    );
  }

  // The server is the sole authority for "now" — a client with a wrong clock cannot
  // talk its way into the past. The grace window keeps "book this slot now" working.
  if (elapsedMinutes(startsAt, now) > PAST_GRACE_MINUTES) {
    throw unprocessable('IN_THE_PAST', 'That time has already passed.');
  }

  const daysAhead = elapsedMinutes(now, startsAt) / (60 * 24);
  if (daysAhead > MAX_FUTURE_DAYS) {
    throw unprocessable(
      'TOO_FAR_AHEAD',
      `Bookings can be made up to ${MAX_FUTURE_DAYS} days in advance.`,
      { maxFutureDays: MAX_FUTURE_DAYS },
    );
  }
}

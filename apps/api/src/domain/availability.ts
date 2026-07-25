import {
  type AvailabilityExceptionDto,
  type AvailabilityRuleDto,
  containsWindow,
  MINUTES_IN_DAY,
  windowsForLocalDate,
} from '@slotline/shared';
import { unprocessable } from '../lib/errors.js';
import { endsAtLocalMidnight, inZone, localDateOf, wallClockMinutes } from './time.js';

/**
 * The instant-to-wall-clock half of availability. The window arithmetic itself lives in
 * `@slotline/shared` so the calendar shades exactly what this refuses — see the note
 * there. Pure: no I/O, no framework, Luxon only.
 *
 * Everything is compared in wall-clock minutes in the resource's own zone. That is the
 * whole trick to being DST-correct: a rule saying "Mondays 09:00-17:00" is a claim about
 * what the clock on the wall reads, so it is compared against what the clock on the wall
 * reads. The conversion happens once, here, and never in reverse.
 */

export {
  containsWindow,
  hasOverlappingRules,
  mergeWindows,
  windowsForLocalDate,
} from '@slotline/shared';

export type AvailabilityCheck = {
  startsAt: Date;
  endsAt: Date;
  /** The resource's effective zone: its own, or the tenant's. */
  timeZone: string;
  rules: readonly AvailabilityRuleDto[];
  exceptions: readonly AvailabilityExceptionDto[];
};

/**
 * Where a booking sits on the wall clock. Callers must already have established that it
 * falls on a single local day (`assertValidBookingWindow`) — that is what makes one date
 * and one minute range a complete description of it.
 */
export function bookingWallClock(
  startsAt: Date,
  endsAt: Date,
  timeZone: string,
): { localDate: string; weekday: number; startMinute: number; endMinute: number } {
  return {
    localDate: localDateOf(startsAt, timeZone),
    weekday: inZone(startsAt, timeZone).weekday,
    startMinute: wallClockMinutes(startsAt, timeZone),
    // An end on local midnight closes its own day rather than opening the next one.
    endMinute: endsAtLocalMidnight(endsAt, timeZone)
      ? MINUTES_IN_DAY
      : wallClockMinutes(endsAt, timeZone),
  };
}

function openWindowsFor(check: AvailabilityCheck) {
  const { localDate, weekday } = bookingWallClock(check.startsAt, check.endsAt, check.timeZone);
  return {
    localDate,
    open: windowsForLocalDate(localDate, weekday, check.rules, check.exceptions),
  };
}

export function isWithinAvailability(check: AvailabilityCheck): boolean {
  const { startMinute, endMinute } = bookingWallClock(check.startsAt, check.endsAt, check.timeZone);
  return containsWindow(openWindowsFor(check).open, startMinute, endMinute);
}

export function assertWithinAvailability(check: AvailabilityCheck): void {
  if (isWithinAvailability(check)) return;

  const { localDate, open } = openWindowsFor(check);
  throw unprocessable(
    'OUTSIDE_AVAILABILITY',
    open.length === 0
      ? 'This resource is not open that day.'
      : 'That time falls outside this resource’s opening hours.',
    { localDate, openWindows: open },
  );
}

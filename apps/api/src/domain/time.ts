import { DateTime } from 'luxon';

/**
 * Every time question in the system, answered in one place. Pure — no I/O, no framework.
 *
 * The rule the rest of the codebase depends on: instants are absolute and stored in UTC;
 * availability is wall-clock and interpreted in the *resource's* zone. Conversions go
 * one way only, at the moment of comparison. A room is in a place, so "Tuesday 09:00"
 * means what the room's occupants mean by it. SPEC §3.
 */

export function isValidTimeZone(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid;
}

export function inZone(instant: Date, zone: string): DateTime {
  return DateTime.fromJSDate(instant, { zone });
}

/** The calendar date this instant falls on, in the given zone: "2026-08-03". */
export function localDateOf(instant: Date, zone: string): string {
  return inZone(instant, zone).toISODate() ?? '';
}

/**
 * Wall-clock minutes since local midnight — 09:00 is always 540, on a DST changeover
 * day as much as on any other. Availability rules are wall-clock, so this is the number
 * they must be compared against; the count of *real* elapsed minutes is a different
 * question and is not what a "Mon 09:00-17:00" rule is asserting.
 */
export function wallClockMinutes(instant: Date, zone: string): number {
  const local = inZone(instant, zone);
  return local.hour * 60 + local.minute;
}

export function sameLocalDay(a: Date, b: Date, zone: string): boolean {
  return localDateOf(a, zone) === localDateOf(b, zone);
}

/** Real elapsed minutes between two instants. Unaffected by wall-clock jumps. */
export function elapsedMinutes(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60_000;
}

/**
 * An end instant that lands exactly on local midnight closes the day it belongs to,
 * not the one it opens: a 22:00-24:00 booking ends on its own date, because the stored
 * range is half-open `[start, end)` and never includes the following midnight.
 */
export function endsAtLocalMidnight(instant: Date, zone: string): boolean {
  const local = inZone(instant, zone);
  return local.hour === 0 && local.minute === 0 && local.second === 0 && local.millisecond === 0;
}

/**
 * A note on nonexistent local times (02:30 on a spring-forward night):
 *
 * They cannot reach this module. The wire format is an absolute instant, and every
 * absolute instant has exactly one valid local representation in any zone — so there is
 * nothing here to reject, and no `INVALID_LOCAL_TIME` is ever raised server-side. The
 * real hazard lives in the client: a grid that offers a 02:30 slot on that night will
 * have Luxon resolve it forward to 03:30, and the user books an hour they did not pick.
 * The calendar is responsible for not drawing skipped hours (M2, when it draws
 * availability at all). Documented here because this is where a reader will look.
 */

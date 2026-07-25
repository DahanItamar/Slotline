import { z } from 'zod';
import type { BookingDto } from './bookings.js';

/**
 * Availability is wall-clock, expressed in minutes from local midnight in the resource's
 * own time zone. Never an instant: "Mondays 09:00-17:00" means 09:00 to whoever is
 * standing next to the room, on every Monday, including the ones where the clocks move.
 */

/** ISO-8601 weekday: 1 = Monday ... 7 = Sunday, matching Luxon's `weekday`. */
export const weekdaySchema = z.number().int().min(1).max(7);

/** 0 = local midnight, 1440 = the following local midnight (a valid *end* only). */
export const minuteOfDaySchema = z.number().int().min(0).max(1440);

export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export const availabilityRuleSchema = z
  .object({
    weekday: weekdaySchema,
    startMinute: minuteOfDaySchema,
    endMinute: minuteOfDaySchema,
  })
  .refine((rule) => rule.startMinute < rule.endMinute, {
    message: 'a window must end after it starts',
    path: ['endMinute'],
  });

export type AvailabilityRuleDto = z.infer<typeof availabilityRuleSchema>;

/**
 * Replaces the entire weekly set in one transaction. There is deliberately no
 * partial-update path: the rules can then never be observed half-applied, and the caller
 * never has to reason about which of five requests failed.
 */
export const replaceAvailabilityRulesSchema = z.object({
  rules: z.array(availabilityRuleSchema).max(50),
});
export type ReplaceAvailabilityRulesRequest = z.infer<typeof replaceAvailabilityRulesSchema>;

export type ReplaceAvailabilityRulesResponse = {
  rules: AvailabilityRuleDto[];
  /**
   * Future confirmed bookings that now fall outside the new hours. They are NOT
   * cancelled — the admin decides. SPEC §8 and Open Question 3.
   */
  conflictingBookings: BookingDto[];
};

/** A calendar date in the resource's zone: "2026-12-25". A holiday has no timezone. */
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const createAvailabilityExceptionSchema = z
  .object({
    localDate: localDateSchema,
    isAvailable: z.boolean(),
    startMinute: minuteOfDaySchema.nullable().default(null),
    endMinute: minuteOfDaySchema.nullable().default(null),
    reason: z.string().max(200).default(''),
  })
  .refine(
    (value) =>
      value.isAvailable
        ? value.startMinute !== null &&
          value.endMinute !== null &&
          value.startMinute < value.endMinute
        : value.startMinute === null && value.endMinute === null,
    {
      message: 'a closure carries no window; a one-off opening needs startMinute before endMinute',
      path: ['startMinute'],
    },
  );
export type CreateAvailabilityExceptionRequest = z.infer<typeof createAvailabilityExceptionSchema>;

export type AvailabilityExceptionDto = {
  id: string;
  localDate: string;
  /** false = closed all day. true = open ONLY in the window below, replacing that day's rules. */
  isAvailable: boolean;
  startMinute: number | null;
  endMinute: number | null;
  reason: string;
};

export const listExceptionsQuerySchema = z.object({
  from: localDateSchema,
  to: localDateSchema,
});
export type ListExceptionsQuery = z.infer<typeof listExceptionsQuerySchema>;

/** What the calendar needs to shade a week without asking per-day. */
export type ResourceAvailabilityDto = {
  resourceId: string;
  timezone: string;
  /** Empty means the resource is bookable around the clock — the right default for equipment. */
  rules: AvailabilityRuleDto[];
  exceptions: AvailabilityExceptionDto[];
};

// ---------------------------------------------------------------------------
// Window arithmetic
//
// This lives in `shared` rather than in the API's domain layer for one reason: the
// calendar shades closed hours and the server refuses bookings outside them, and those
// two answers must never disagree. Two implementations of the same rule eventually do.
// It is pure minute arithmetic — no dates, no zones, no I/O. Converting an instant into
// a local date and a minute-of-day is the API's job, because only it has Luxon.
// ---------------------------------------------------------------------------

export type AvailabilityWindow = {
  startMinute: number;
  endMinute: number;
};

/** Half-open: a booking ending exactly at local midnight ends at 1440, never at 0. */
export const MINUTES_IN_DAY = 1440;

/**
 * The windows a resource is open on one local date.
 *
 * Precedence, highest first:
 *   1. A dated exception replaces that day entirely — a closure yields nothing, and a
 *      one-off opening yields exactly its own window, ignoring the weekly rules.
 *   2. The weekly rules for that weekday.
 *   3. A resource with no weekly rules at all is open around the clock. That is the
 *      right default for equipment, which mostly has no opening hours. A resource that
 *      *has* rules but none on this weekday is closed — the right answer for a room on
 *      a Monday-to-Friday week.
 */
export function windowsForLocalDate(
  localDate: string,
  weekday: number,
  rules: readonly AvailabilityRuleDto[],
  exceptions: readonly AvailabilityExceptionDto[],
): AvailabilityWindow[] {
  const exception = exceptions.find((candidate) => candidate.localDate === localDate);

  if (exception) {
    if (!exception.isAvailable) return [];
    if (exception.startMinute === null || exception.endMinute === null) return [];
    return [{ startMinute: exception.startMinute, endMinute: exception.endMinute }];
  }

  if (rules.length === 0) return [{ startMinute: 0, endMinute: MINUTES_IN_DAY }];

  return mergeWindows(
    rules
      .filter((rule) => rule.weekday === weekday)
      .map((rule) => ({ startMinute: rule.startMinute, endMinute: rule.endMinute })),
  );
}

/**
 * Merges overlapping and touching windows. Without this, a resource open 09:00-12:00 and
 * 12:00-17:00 would refuse an 11:00-13:00 booking despite being open the whole time.
 */
export function mergeWindows(windows: readonly AvailabilityWindow[]): AvailabilityWindow[] {
  const sorted = [...windows].sort((a, b) => a.startMinute - b.startMinute);
  const merged: AvailabilityWindow[] = [];

  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.startMinute <= last.endMinute) {
      last.endMinute = Math.max(last.endMinute, window.endMinute);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

/** True when two windows on the same weekday overlap. Rejected at write time. */
export function hasOverlappingRules(rules: readonly AvailabilityRuleDto[]): boolean {
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const sameDay = rules
      .filter((rule) => rule.weekday === weekday)
      .sort((a, b) => a.startMinute - b.startMinute);
    for (let index = 1; index < sameDay.length; index += 1) {
      const previous = sameDay[index - 1];
      const current = sameDay[index];
      if (previous && current && current.startMinute < previous.endMinute) return true;
    }
  }
  return false;
}

/** Whether a wall-clock range sits entirely inside one of the open windows. */
export function containsWindow(
  open: readonly AvailabilityWindow[],
  startMinute: number,
  endMinute: number,
): boolean {
  return open.some((window) => startMinute >= window.startMinute && endMinute <= window.endMinute);
}

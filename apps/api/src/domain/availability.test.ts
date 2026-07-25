import { describe, expect, it } from 'vitest';
import type { AvailabilityExceptionDto, AvailabilityRuleDto } from '@slotline/shared';
import { AppError } from '../lib/errors.js';
import {
  assertWithinAvailability,
  hasOverlappingRules,
  isWithinAvailability,
  mergeWindows,
  windowsForLocalDate,
} from './availability.js';

const BERLIN = 'Europe/Berlin';
const at = (iso: string): Date => new Date(iso);

/** Monday to Friday, 09:00-17:00 local. */
const OFFICE_HOURS: AvailabilityRuleDto[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 9 * 60,
  endMinute: 17 * 60,
}));

const closure = (localDate: string, reason = 'Holiday'): AvailabilityExceptionDto => ({
  id: `exception-${localDate}`,
  localDate,
  isAvailable: false,
  startMinute: null,
  endMinute: null,
  reason,
});

const opening = (
  localDate: string,
  startMinute: number,
  endMinute: number,
): AvailabilityExceptionDto => ({
  id: `exception-${localDate}`,
  localDate,
  isAvailable: true,
  startMinute,
  endMinute,
  reason: 'Special opening',
});

/** Reads as the question the tests are actually asking. */
const fits = (
  startsAt: string,
  endsAt: string,
  rules: readonly AvailabilityRuleDto[],
  exceptions: readonly AvailabilityExceptionDto[] = [],
): boolean =>
  isWithinAvailability({
    startsAt: at(startsAt),
    endsAt: at(endsAt),
    timeZone: BERLIN,
    rules,
    exceptions,
  });

describe('windowsForLocalDate', () => {
  it('treats a resource with no rules as open around the clock', () => {
    expect(windowsForLocalDate('2026-08-03', 1, [], [])).toEqual([
      { startMinute: 0, endMinute: 1440 },
    ]);
  });

  it('closes a day the weekly rules do not cover', () => {
    // Saturday, against a Monday-to-Friday week.
    expect(windowsForLocalDate('2026-08-08', 6, OFFICE_HOURS, [])).toEqual([]);
  });

  it('returns the rule window for a covered weekday', () => {
    expect(windowsForLocalDate('2026-08-03', 1, OFFICE_HOURS, [])).toEqual([
      { startMinute: 540, endMinute: 1020 },
    ]);
  });

  it('lets a closure exception override the weekly rules', () => {
    expect(windowsForLocalDate('2026-08-03', 1, OFFICE_HOURS, [closure('2026-08-03')])).toEqual([]);
  });

  it('lets an opening exception replace the weekly rules entirely', () => {
    // Saturday, normally closed, opened 10:00-14:00 for one day.
    expect(
      windowsForLocalDate('2026-08-08', 6, OFFICE_HOURS, [opening('2026-08-08', 600, 840)]),
    ).toEqual([{ startMinute: 600, endMinute: 840 }]);
  });

  it('narrows rather than widens when an opening exception is shorter than the rules', () => {
    expect(
      windowsForLocalDate('2026-08-03', 1, OFFICE_HOURS, [opening('2026-08-03', 600, 660)]),
    ).toEqual([{ startMinute: 600, endMinute: 660 }]);
  });

  it('ignores exceptions dated on other days', () => {
    expect(windowsForLocalDate('2026-08-03', 1, OFFICE_HOURS, [closure('2026-08-04')])).toEqual([
      { startMinute: 540, endMinute: 1020 },
    ]);
  });
});

describe('mergeWindows', () => {
  it('joins two windows that touch', () => {
    expect(
      mergeWindows([
        { startMinute: 540, endMinute: 720 },
        { startMinute: 720, endMinute: 1020 },
      ]),
    ).toEqual([{ startMinute: 540, endMinute: 1020 }]);
  });

  it('joins two windows that overlap', () => {
    expect(
      mergeWindows([
        { startMinute: 540, endMinute: 780 },
        { startMinute: 720, endMinute: 1020 },
      ]),
    ).toEqual([{ startMinute: 540, endMinute: 1020 }]);
  });

  it('keeps a genuine lunch break as two windows', () => {
    expect(
      mergeWindows([
        { startMinute: 540, endMinute: 720 },
        { startMinute: 780, endMinute: 1020 },
      ]),
    ).toHaveLength(2);
  });
});

describe('hasOverlappingRules', () => {
  it('accepts a split day with a break', () => {
    expect(
      hasOverlappingRules([
        { weekday: 1, startMinute: 540, endMinute: 720 },
        { weekday: 1, startMinute: 780, endMinute: 1020 },
      ]),
    ).toBe(false);
  });

  it('accepts identical windows on different weekdays', () => {
    expect(
      hasOverlappingRules([
        { weekday: 1, startMinute: 540, endMinute: 1020 },
        { weekday: 2, startMinute: 540, endMinute: 1020 },
      ]),
    ).toBe(false);
  });

  it('rejects two windows overlapping on one weekday', () => {
    expect(
      hasOverlappingRules([
        { weekday: 1, startMinute: 540, endMinute: 780 },
        { weekday: 1, startMinute: 720, endMinute: 1020 },
      ]),
    ).toBe(true);
  });
});

describe('isWithinAvailability', () => {
  // Monday 3 August 2026, Berlin on CEST (UTC+2).
  it('accepts a booking inside opening hours', () => {
    // 10:00-11:00 local.
    expect(fits('2026-08-03T08:00:00Z', '2026-08-03T09:00:00Z', OFFICE_HOURS)).toBe(true);
  });

  it('rejects a booking starting before opening', () => {
    // 08:00-09:30 local.
    expect(fits('2026-08-03T06:00:00Z', '2026-08-03T07:30:00Z', OFFICE_HOURS)).toBe(false);
  });

  it('rejects a booking that runs past closing', () => {
    // 16:30-17:30 local.
    expect(fits('2026-08-03T14:30:00Z', '2026-08-03T15:30:00Z', OFFICE_HOURS)).toBe(false);
  });

  it('accepts a booking that exactly fills the window', () => {
    // 09:00-17:00 local.
    expect(fits('2026-08-03T07:00:00Z', '2026-08-03T15:00:00Z', OFFICE_HOURS)).toBe(true);
  });

  it('rejects any booking on a closed day', () => {
    expect(
      fits('2026-08-03T08:00:00Z', '2026-08-03T09:00:00Z', OFFICE_HOURS, [closure('2026-08-03')]),
    ).toBe(false);
  });

  it('accepts a booking inside a one-off opening on a normally closed day', () => {
    // Saturday 8 August, opened 10:00-14:00 local; booking 11:00-12:00.
    expect(
      fits('2026-08-08T09:00:00Z', '2026-08-08T10:00:00Z', OFFICE_HOURS, [
        opening('2026-08-08', 600, 840),
      ]),
    ).toBe(true);
  });

  it('judges the day in the resource zone, not UTC', () => {
    // 2026-08-03T23:30Z is 01:30 on Tuesday 4 August in Berlin. Read as UTC it would be
    // Monday, and Monday-versus-Tuesday is the difference between open and closed as
    // soon as the two days carry different rules.
    const tuesdayOnly: AvailabilityRuleDto[] = [{ weekday: 2, startMinute: 0, endMinute: 1440 }];
    expect(fits('2026-08-03T23:30:00Z', '2026-08-04T00:30:00Z', tuesdayOnly)).toBe(true);
  });

  it('accepts a booking ending exactly at local midnight', () => {
    const lateShift: AvailabilityRuleDto[] = [{ weekday: 1, startMinute: 1200, endMinute: 1440 }];
    // 22:00-00:00 local on Monday 3 August.
    expect(fits('2026-08-03T20:00:00Z', '2026-08-03T22:00:00Z', lateShift)).toBe(true);
  });

  it('accepts a booking spanning two contiguous rules', () => {
    const splitDay: AvailabilityRuleDto[] = [
      { weekday: 1, startMinute: 540, endMinute: 720 },
      { weekday: 1, startMinute: 720, endMinute: 1020 },
    ];
    // 11:00-13:00 local, straddling the 12:00 seam.
    expect(fits('2026-08-03T09:00:00Z', '2026-08-03T11:00:00Z', splitDay)).toBe(true);
  });

  it('rejects a booking spanning a genuine break', () => {
    const lunchBreak: AvailabilityRuleDto[] = [
      { weekday: 1, startMinute: 540, endMinute: 720 },
      { weekday: 1, startMinute: 780, endMinute: 1020 },
    ];
    // 11:00-14:00 local, across the 12:00-13:00 gap.
    expect(fits('2026-08-03T09:00:00Z', '2026-08-03T12:00:00Z', lunchBreak)).toBe(false);
  });

  describe('daylight saving time', () => {
    // Berlin springs forward at 02:00 local on Sunday 2027-03-28; 02:00-03:00 never happens.
    // It falls back at 03:00 local on Sunday 2027-10-31; 02:00-03:00 happens twice.
    const allSunday: AvailabilityRuleDto[] = [{ weekday: 7, startMinute: 0, endMinute: 1440 }];
    const sundayMornings: AvailabilityRuleDto[] = [
      { weekday: 7, startMinute: 9 * 60, endMinute: 12 * 60 },
    ];

    it('reads a rule as wall-clock across a spring-forward, not as elapsed time', () => {
      // 09:00-11:00 local on the changeover Sunday is 07:00Z-09:00Z, the day already
      // being on summer time by 09:00. A 09:00-12:00 rule still covers it.
      expect(fits('2027-03-28T07:00:00Z', '2027-03-28T09:00:00Z', sundayMornings)).toBe(true);
    });

    it('covers the skipped hour when the day is open around the clock', () => {
      // 01:30 local to 03:30 local: one real hour, two wall-clock hours.
      expect(fits('2027-03-28T00:30:00Z', '2027-03-28T01:30:00Z', allSunday)).toBe(true);
    });

    it('reads a rule as wall-clock across a fall-back', () => {
      // 09:00-11:00 local is 08:00Z-10:00Z, the day being back on winter time.
      expect(fits('2027-10-31T08:00:00Z', '2027-10-31T10:00:00Z', sundayMornings)).toBe(true);
    });

    it('covers both passes of a repeated local hour', () => {
      // 02:00-03:00 local on the second pass, after the clocks went back: 01:00Z-02:00Z.
      expect(fits('2027-10-31T01:00:00Z', '2027-10-31T02:00:00Z', allSunday)).toBe(true);
    });

    it('still refuses a spring-forward booking outside the rule', () => {
      // 04:00-05:00 local, past a 09:00-12:00 rule's reach in the other direction.
      expect(fits('2027-03-28T02:00:00Z', '2027-03-28T03:00:00Z', sundayMornings)).toBe(false);
    });
  });
});

describe('assertWithinAvailability', () => {
  it('passes silently when the booking fits', () => {
    expect(() => {
      assertWithinAvailability({
        startsAt: at('2026-08-03T08:00:00Z'),
        endsAt: at('2026-08-03T09:00:00Z'),
        timeZone: BERLIN,
        rules: OFFICE_HOURS,
        exceptions: [],
      });
    }).not.toThrow();
  });

  it('reports OUTSIDE_AVAILABILITY with the windows that are open', () => {
    try {
      assertWithinAvailability({
        startsAt: at('2026-08-03T06:00:00Z'),
        endsAt: at('2026-08-03T07:00:00Z'),
        timeZone: BERLIN,
        rules: OFFICE_HOURS,
        exceptions: [],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('OUTSIDE_AVAILABILITY');
      expect((error as AppError).details).toMatchObject({
        localDate: '2026-08-03',
        openWindows: [{ startMinute: 540, endMinute: 1020 }],
      });
      return;
    }
    throw new Error('expected OUTSIDE_AVAILABILITY, but nothing was thrown');
  });

  it('says the resource is shut, not merely outside hours, on a closed day', () => {
    try {
      assertWithinAvailability({
        startsAt: at('2026-08-03T08:00:00Z'),
        endsAt: at('2026-08-03T09:00:00Z'),
        timeZone: BERLIN,
        rules: OFFICE_HOURS,
        exceptions: [closure('2026-08-03')],
      });
    } catch (error) {
      expect((error as AppError).details).toMatchObject({ openWindows: [] });
      return;
    }
    throw new Error('expected OUTSIDE_AVAILABILITY, but nothing was thrown');
  });
});

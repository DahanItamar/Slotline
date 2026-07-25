import { describe, expect, it } from 'vitest';
import { AppError } from '../lib/errors.js';
import { assertValidBookingWindow, type WindowConstraints } from './booking-rules.js';

const BERLIN: WindowConstraints = {
  timeZone: 'Europe/Berlin',
  minMinutes: 15,
  maxMinutes: 480,
  now: new Date('2026-08-01T08:00:00Z'),
};

const at = (iso: string): Date => new Date(iso);

/** Asserts the failure carries the expected typed code — never a message match. */
function expectCode(fn: () => void, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

describe('assertValidBookingWindow', () => {
  it('accepts an ordinary one-hour window', () => {
    expect(() =>
      assertValidBookingWindow(
        { startsAt: at('2026-08-03T09:00:00Z'), endsAt: at('2026-08-03T10:00:00Z') },
        BERLIN,
      ),
    ).not.toThrow();
  });

  it('rejects an end that precedes its start', () => {
    expectCode(
      () =>
        assertValidBookingWindow(
          { startsAt: at('2026-08-03T10:00:00Z'), endsAt: at('2026-08-03T09:00:00Z') },
          BERLIN,
        ),
      'INVALID_RANGE',
    );
  });

  it('rejects a zero-length window', () => {
    expectCode(
      () =>
        assertValidBookingWindow(
          { startsAt: at('2026-08-03T09:00:00Z'), endsAt: at('2026-08-03T09:00:00Z') },
          BERLIN,
        ),
      'INVALID_RANGE',
    );
  });

  it('rejects a window shorter than the resource minimum', () => {
    expectCode(
      () =>
        assertValidBookingWindow(
          { startsAt: at('2026-08-03T09:00:00Z'), endsAt: at('2026-08-03T09:05:00Z') },
          BERLIN,
        ),
      'DURATION_OUT_OF_BOUNDS',
    );
  });

  it('rejects a window longer than the resource maximum', () => {
    expectCode(
      () =>
        assertValidBookingWindow(
          { startsAt: at('2026-08-03T06:00:00Z'), endsAt: at('2026-08-03T15:00:00Z') },
          BERLIN,
        ),
      'DURATION_OUT_OF_BOUNDS',
    );
  });

  it('rejects a window crossing local midnight', () => {
    // 22:00-01:00 Berlin on 3-4 August.
    expectCode(
      () =>
        assertValidBookingWindow(
          { startsAt: at('2026-08-03T20:00:00Z'), endsAt: at('2026-08-03T23:00:00Z') },
          BERLIN,
        ),
      'SPANS_MIDNIGHT',
    );
  });

  it('allows a window ending exactly at local midnight', () => {
    // 22:00-00:00 Berlin: the end closes the day it belongs to, so this is same-day.
    expect(() =>
      assertValidBookingWindow(
        { startsAt: at('2026-08-03T20:00:00Z'), endsAt: at('2026-08-03T22:00:00Z') },
        BERLIN,
      ),
    ).not.toThrow();
  });

  it('judges the local day in the resource zone, not UTC', () => {
    // 01:00-02:00 Berlin on 4 August is 23:00-00:00 UTC on 3 August. Same local day,
    // two different UTC days — a UTC-based check would wrongly reject this.
    expect(() =>
      assertValidBookingWindow(
        { startsAt: at('2026-08-03T23:00:00Z'), endsAt: at('2026-08-04T00:00:00Z') },
        BERLIN,
      ),
    ).not.toThrow();
  });

  it('rejects a start in the past beyond the grace window', () => {
    expectCode(
      () =>
        assertValidBookingWindow(
          { startsAt: at('2026-08-01T07:00:00Z'), endsAt: at('2026-08-01T07:30:00Z') },
          BERLIN,
        ),
      'IN_THE_PAST',
    );
  });

  it('tolerates a start slightly in the past, so "book it now" still works', () => {
    expect(() =>
      assertValidBookingWindow(
        { startsAt: at('2026-08-01T07:58:00Z'), endsAt: at('2026-08-01T08:30:00Z') },
        BERLIN,
      ),
    ).not.toThrow();
  });

  it('rejects a start more than a year ahead', () => {
    expectCode(
      () =>
        assertValidBookingWindow(
          { startsAt: at('2027-09-01T09:00:00Z'), endsAt: at('2027-09-01T10:00:00Z') },
          BERLIN,
        ),
      'TOO_FAR_AHEAD',
    );
  });

  describe('daylight saving time', () => {
    // Europe/Berlin springs forward at 02:00 local on 2027-03-28: 01:00Z becomes 03:00 local.
    const springForward: WindowConstraints = { ...BERLIN, now: at('2027-03-01T00:00:00Z') };

    it('counts a window spanning the skipped hour by real elapsed minutes', () => {
      // 01:30-03:30 local = 00:30Z-01:30Z: one real hour, not two.
      expect(() =>
        assertValidBookingWindow(
          { startsAt: at('2027-03-28T00:30:00Z'), endsAt: at('2027-03-28T01:30:00Z') },
          springForward,
        ),
      ).not.toThrow();
    });

    it('keeps a spring-forward booking on one local day', () => {
      expect(() =>
        assertValidBookingWindow(
          { startsAt: at('2027-03-28T08:00:00Z'), endsAt: at('2027-03-28T10:00:00Z') },
          springForward,
        ),
      ).not.toThrow();
    });

    // Berlin falls back at 03:00 local on 2027-10-31: 01:30 local happens twice.
    const fallBack: WindowConstraints = { ...BERLIN, now: at('2027-10-01T00:00:00Z') };

    it('treats both passes of a repeated local hour as the same local day', () => {
      // 02:00-03:00 local on the second pass = 01:00Z-02:00Z.
      expect(() =>
        assertValidBookingWindow(
          { startsAt: at('2027-10-31T01:00:00Z'), endsAt: at('2027-10-31T02:00:00Z') },
          fallBack,
        ),
      ).not.toThrow();
    });

    it('still rejects a fall-back window that reaches into the next local day', () => {
      // 23:00 local 31 Oct to 01:00 local 1 Nov.
      expectCode(
        () =>
          assertValidBookingWindow(
            { startsAt: at('2027-10-31T22:00:00Z'), endsAt: at('2027-11-01T00:00:00Z') },
            fallBack,
          ),
        'SPANS_MIDNIGHT',
      );
    });
  });
});

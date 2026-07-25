import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  AvailabilityExceptionDto,
  AvailabilityRuleDto,
  BookingDto,
  ReplaceAvailabilityRulesResponse,
  ResourceAvailabilityDto,
  ResourceDto,
} from '@slotline/shared';
import { closeDatabases } from '../src/db/index.js';
import {
  bookRequest,
  createRoom,
  createTestApp,
  futureLocalWindow,
  signUpWorkspace,
  type Workspace,
} from './helpers/app.js';
import {
  closeTestDatabase,
  hasDatabase,
  resetDatabase,
  setupDatabase,
} from './helpers/database.js';

const ZONE = 'Europe/Berlin';
/** Monday to Friday, 09:00-17:00. */
const OFFICE_HOURS: AvailabilityRuleDto[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 9 * 60,
  endMinute: 17 * 60,
}));

describe.skipIf(!hasDatabase)('availability (integration)', () => {
  let app: FastifyInstance;
  let workspace: Workspace;
  let room: ResourceDto;

  const errorCode = (body: string): string =>
    (JSON.parse(body) as { error: { code: string } }).error.code;

  const setRules = (rules: AvailabilityRuleDto[]) =>
    app.inject({
      method: 'PUT',
      url: `/api/resources/${room.id}/availability-rules`,
      headers: { cookie: workspace.cookie },
      payload: { rules },
    });

  const book = (window: { start: string; end: string }) =>
    app.inject(
      bookRequest(workspace, {
        resourceId: room.id,
        startsAt: window.start,
        endsAt: window.end,
        idempotencyKey: randomUUID(),
      }),
    );

  beforeAll(async () => {
    await setupDatabase();
    app = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase();
    workspace = await signUpWorkspace(app, { timezone: ZONE });
    room = await createRoom(app, workspace);
  });

  afterAll(async () => {
    await app.close();
    await closeDatabases();
    await closeTestDatabase();
  });

  describe('weekly opening hours', () => {
    it('starts a resource with no rules, bookable around the clock', async () => {
      const availability = await app.inject({
        method: 'GET',
        url: `/api/resources/${room.id}/availability`,
        headers: { cookie: workspace.cookie },
      });
      expect(availability.json<ResourceAvailabilityDto>().rules).toEqual([]);

      // 03:00 on a Sunday: no rules means open, which is the right default for equipment.
      const response = await book(futureLocalWindow({ zone: ZONE, weekday: 7, hour: 3 }));
      expect(response.statusCode).toBe(201);
    });

    it('accepts a booking inside the hours once they are set', async () => {
      await setRules(OFFICE_HOURS);
      const response = await book(futureLocalWindow({ zone: ZONE, weekday: 3, hour: 10 }));
      expect(response.statusCode).toBe(201);
    });

    it('refuses a booking before opening', async () => {
      await setRules(OFFICE_HOURS);
      const response = await book(futureLocalWindow({ zone: ZONE, weekday: 3, hour: 7 }));
      expect(response.statusCode).toBe(422);
      expect(errorCode(response.body)).toBe('OUTSIDE_AVAILABILITY');
    });

    it('refuses a booking that runs past closing', async () => {
      await setRules(OFFICE_HOURS);
      // 16:30-17:30 local.
      const window = futureLocalWindow({ zone: ZONE, weekday: 3, hour: 16 });
      const start = new Date(new Date(window.start).getTime() + 30 * 60_000).toISOString();
      const end = new Date(new Date(window.end).getTime() + 30 * 60_000).toISOString();
      const response = await book({ start, end });

      expect(response.statusCode).toBe(422);
      expect(errorCode(response.body)).toBe('OUTSIDE_AVAILABILITY');
    });

    it('refuses a booking on a weekday the rules do not cover', async () => {
      await setRules(OFFICE_HOURS);
      // Saturday at 10:00, inside the hours but not on a covered day.
      const response = await book(futureLocalWindow({ zone: ZONE, weekday: 6, hour: 10 }));
      expect(response.statusCode).toBe(422);
      expect(errorCode(response.body)).toBe('OUTSIDE_AVAILABILITY');
    });

    it('refuses two overlapping windows on one weekday', async () => {
      const response = await setRules([
        { weekday: 1, startMinute: 540, endMinute: 780 },
        { weekday: 1, startMinute: 720, endMinute: 1020 },
      ]);
      expect(response.statusCode).toBe(422);
      expect(errorCode(response.body)).toBe('OVERLAPPING_RULES');
    });

    it('replaces the whole set rather than merging into it', async () => {
      await setRules(OFFICE_HOURS);
      await setRules([{ weekday: 1, startMinute: 600, endMinute: 660 }]);

      const availability = await app.inject({
        method: 'GET',
        url: `/api/resources/${room.id}/availability`,
        headers: { cookie: workspace.cookie },
      });
      expect(availability.json<ResourceAvailabilityDto>().rules).toEqual([
        { weekday: 1, startMinute: 600, endMinute: 660 },
      ]);
    });
  });

  describe('date overrides', () => {
    it('closes a normally-open day', async () => {
      await setRules(OFFICE_HOURS);
      const window = futureLocalWindow({ zone: ZONE, weekday: 3, hour: 10 });

      const created = await app.inject({
        method: 'POST',
        url: `/api/resources/${room.id}/availability-exceptions`,
        headers: { cookie: workspace.cookie },
        payload: { localDate: window.localDate, isAvailable: false, reason: 'Maintenance' },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json<AvailabilityExceptionDto>().localDate).toBe(window.localDate);

      const response = await book(window);
      expect(response.statusCode).toBe(422);
      expect(errorCode(response.body)).toBe('OUTSIDE_AVAILABILITY');
    });

    it('opens a normally-closed day, for that window only', async () => {
      await setRules(OFFICE_HOURS);
      const saturday = futureLocalWindow({ zone: ZONE, weekday: 6, hour: 11 });

      await app.inject({
        method: 'POST',
        url: `/api/resources/${room.id}/availability-exceptions`,
        headers: { cookie: workspace.cookie },
        payload: {
          localDate: saturday.localDate,
          isAvailable: true,
          startMinute: 10 * 60,
          endMinute: 14 * 60,
          reason: 'Open day',
        },
      });

      // 11:00-12:00 sits inside the override.
      expect((await book(saturday)).statusCode).toBe(201);

      // 16:00-17:00 on the same Saturday does not.
      const late = futureLocalWindow({ zone: ZONE, weekday: 6, hour: 16 });
      const rejected = await book(late);
      expect(rejected.statusCode).toBe(422);
      expect(errorCode(rejected.body)).toBe('OUTSIDE_AVAILABILITY');
    });

    it('refuses a second override on the same date', async () => {
      const window = futureLocalWindow({ zone: ZONE, weekday: 3, hour: 10 });
      const payload = { localDate: window.localDate, isAvailable: false };
      const url = `/api/resources/${room.id}/availability-exceptions`;

      await app.inject({ method: 'POST', url, headers: { cookie: workspace.cookie }, payload });
      const second = await app.inject({
        method: 'POST',
        url,
        headers: { cookie: workspace.cookie },
        payload,
      });

      expect(second.statusCode).toBe(409);
      expect(errorCode(second.body)).toBe('EXCEPTION_EXISTS');
    });

    it('restores the weekly hours when an override is removed', async () => {
      await setRules(OFFICE_HOURS);
      const window = futureLocalWindow({ zone: ZONE, weekday: 3, hour: 10 });

      const created = await app.inject({
        method: 'POST',
        url: `/api/resources/${room.id}/availability-exceptions`,
        headers: { cookie: workspace.cookie },
        payload: { localDate: window.localDate, isAvailable: false },
      });
      expect((await book(window)).statusCode).toBe(422);

      await app.inject({
        method: 'DELETE',
        url: `/api/availability-exceptions/${created.json<AvailabilityExceptionDto>().id}`,
        headers: { cookie: workspace.cookie },
      });

      expect((await book(window)).statusCode).toBe(201);
    });
  });

  describe('narrowing hours under existing bookings', () => {
    it('reports the bookings that no longer fit, and keeps every one of them', async () => {
      const window = futureLocalWindow({ zone: ZONE, weekday: 3, hour: 10 });
      const booked = await book(window);
      expect(booked.statusCode).toBe(201);

      // Wednesday afternoons only, which the 10:00 booking now falls outside.
      const narrowed = await setRules([{ weekday: 3, startMinute: 13 * 60, endMinute: 17 * 60 }]);
      expect(narrowed.statusCode).toBe(200);

      const body = narrowed.json<ReplaceAvailabilityRulesResponse>();
      expect(body.conflictingBookings).toHaveLength(1);
      expect(body.conflictingBookings[0]?.id).toBe(booked.json<BookingDto>().id);

      // Kept, not cancelled: an hours change must not quietly delete someone's meeting.
      const listed = await app.inject({
        method: 'GET',
        url: `/api/bookings?from=${window.start}&to=${window.end}`,
        headers: { cookie: workspace.cookie },
      });
      expect(listed.json<{ bookings: BookingDto[] }>().bookings).toHaveLength(1);
    });

    it('reports nothing when every booking still fits', async () => {
      await book(futureLocalWindow({ zone: ZONE, weekday: 3, hour: 10 }));
      const response = await setRules(OFFICE_HOURS);

      expect(response.json<ReplaceAvailabilityRulesResponse>().conflictingBookings).toEqual([]);
    });
  });

  describe('tenant isolation', () => {
    it('will not read another tenant availability', async () => {
      const other = await signUpWorkspace(app);
      const response = await app.inject({
        method: 'GET',
        url: `/api/resources/${room.id}/availability`,
        headers: { cookie: other.cookie },
      });
      expect(response.statusCode).toBe(404);
    });

    it('will not set another tenant opening hours', async () => {
      const other = await signUpWorkspace(app);
      const response = await app.inject({
        method: 'PUT',
        url: `/api/resources/${room.id}/availability-rules`,
        headers: { cookie: other.cookie },
        payload: { rules: OFFICE_HOURS },
      });
      expect(response.statusCode).toBe(404);
    });
  });
});

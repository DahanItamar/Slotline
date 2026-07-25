import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BookingDto, SlotTakenDetails } from '@slotline/shared';
import { closeDatabases } from '../src/db/index.js';
import {
  bookRequest,
  createRoom,
  createTestApp,
  futureWindow,
  signUpWorkspace,
  type Workspace,
} from './helpers/app.js';
import {
  closeTestDatabase,
  hasDatabase,
  resetDatabase,
  setupDatabase,
} from './helpers/database.js';

/**
 * These run against a real Postgres. The two things they exist to prove — that the GiST
 * exclusion constraint holds under concurrency, and that row-level security actually
 * separates tenants — have no meaning against a mock. SPEC §10 M1.
 */
describe.skipIf(!hasDatabase)('bookings (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupDatabase();
    app = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await app.close();
    await closeDatabases();
    await closeTestDatabase();
  });

  describe('double-booking prevention', () => {
    it('lets exactly one of two simultaneous requests take the same slot', async () => {
      const workspace = await signUpWorkspace(app);
      const room = await createRoom(app, workspace);
      const { start, end } = futureWindow();

      // Fired together, not awaited in sequence: this is the race the exclusion
      // constraint exists for, and a check-then-insert would let both through.
      const [first, second] = await Promise.all([
        app.inject(
          bookRequest(workspace, {
            resourceId: room.id,
            startsAt: start,
            endsAt: end,
            idempotencyKey: randomUUID(),
          }),
        ),
        app.inject(
          bookRequest(workspace, {
            resourceId: room.id,
            startsAt: start,
            endsAt: end,
            idempotencyKey: randomUUID(),
          }),
        ),
      ]);

      const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);

      const loser = first.statusCode === 409 ? first : second;
      expect(loser.json<{ error: { code: string } }>().error.code).toBe('SLOT_TAKEN');

      const listed = await app.inject({
        method: 'GET',
        url: `/api/bookings?from=${start}&to=${end}`,
        headers: { cookie: workspace.cookie },
      });
      expect(listed.json<{ bookings: BookingDto[] }>().bookings).toHaveLength(1);
    });

    it('reports the window that won, so the grid can highlight it', async () => {
      const workspace = await signUpWorkspace(app);
      const room = await createRoom(app, workspace);
      const { start, end } = futureWindow();

      await app.inject(
        bookRequest(workspace, {
          resourceId: room.id,
          startsAt: start,
          endsAt: end,
          idempotencyKey: randomUUID(),
        }),
      );

      // Overlaps the second half of the existing booking.
      const overlapStart = new Date(new Date(start).getTime() + 30 * 60_000).toISOString();
      const overlapEnd = new Date(new Date(end).getTime() + 30 * 60_000).toISOString();
      const rejected = await app.inject(
        bookRequest(workspace, {
          resourceId: room.id,
          startsAt: overlapStart,
          endsAt: overlapEnd,
          idempotencyKey: randomUUID(),
        }),
      );

      expect(rejected.statusCode).toBe(409);
      const body = rejected.json<{ error: { code: string; details: SlotTakenDetails } }>();
      expect(body.error.code).toBe('SLOT_TAKEN');
      expect(body.error.details.conflictingStartsAt).toBe(start);
      expect(body.error.details.conflictingEndsAt).toBe(end);
    });

    it('treats back-to-back bookings as not overlapping', async () => {
      const workspace = await signUpWorkspace(app);
      const room = await createRoom(app, workspace);
      const first = futureWindow(0, 1);
      const second = futureWindow(1, 1);
      expect(first.end).toBe(second.start);

      const responses = await Promise.all([
        app.inject(
          bookRequest(workspace, {
            resourceId: room.id,
            startsAt: first.start,
            endsAt: first.end,
            idempotencyKey: randomUUID(),
          }),
        ),
        app.inject(
          bookRequest(workspace, {
            resourceId: room.id,
            startsAt: second.start,
            endsAt: second.end,
            idempotencyKey: randomUUID(),
          }),
        ),
      ]);

      // `[)` bounds: 10:00-11:00 and 11:00-12:00 share an instant but not an interval.
      expect(responses.map((response) => response.statusCode)).toEqual([201, 201]);
    });

    it('lets two resources hold the same window', async () => {
      const workspace = await signUpWorkspace(app);
      const roomA = await createRoom(app, workspace, 'Room A');
      const roomB = await createRoom(app, workspace, 'Room B');
      const { start, end } = futureWindow();

      for (const room of [roomA, roomB]) {
        const response = await app.inject(
          bookRequest(workspace, {
            resourceId: room.id,
            startsAt: start,
            endsAt: end,
            idempotencyKey: randomUUID(),
          }),
        );
        expect(response.statusCode).toBe(201);
      }
    });
  });

  describe('idempotency', () => {
    it('returns the original booking when a request is retried', async () => {
      const workspace = await signUpWorkspace(app);
      const room = await createRoom(app, workspace);
      const { start, end } = futureWindow();
      const key = randomUUID();

      const first = await app.inject(
        bookRequest(workspace, {
          resourceId: room.id,
          startsAt: start,
          endsAt: end,
          idempotencyKey: key,
        }),
      );
      const retry = await app.inject(
        bookRequest(workspace, {
          resourceId: room.id,
          startsAt: start,
          endsAt: end,
          idempotencyKey: key,
        }),
      );

      expect(first.statusCode).toBe(201);
      // 200, not 201: nothing was created this time.
      expect(retry.statusCode).toBe(200);
      expect(retry.json<BookingDto>().id).toBe(first.json<BookingDto>().id);
    });

    it('refuses a key reused for a different window', async () => {
      const workspace = await signUpWorkspace(app);
      const room = await createRoom(app, workspace);
      const first = futureWindow(0);
      const second = futureWindow(3);
      const key = randomUUID();

      await app.inject(
        bookRequest(workspace, {
          resourceId: room.id,
          startsAt: first.start,
          endsAt: first.end,
          idempotencyKey: key,
        }),
      );
      const reused = await app.inject(
        bookRequest(workspace, {
          resourceId: room.id,
          startsAt: second.start,
          endsAt: second.end,
          idempotencyKey: key,
        }),
      );

      expect(reused.statusCode).toBe(409);
      expect(reused.json<{ error: { code: string } }>().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('rejects a request with no Idempotency-Key at all', async () => {
      const workspace = await signUpWorkspace(app);
      const room = await createRoom(app, workspace);
      const { start, end } = futureWindow();

      const response = await app.inject({
        method: 'POST',
        url: '/api/bookings',
        headers: { cookie: workspace.cookie },
        payload: { resourceId: room.id, startsAt: start, endsAt: end, title: 'Standup' },
      });

      expect(response.statusCode).toBe(422);
    });
  });

  describe('tenant isolation', () => {
    let alpha: Workspace;
    let beta: Workspace;

    beforeEach(async () => {
      alpha = await signUpWorkspace(app);
      beta = await signUpWorkspace(app);
    });

    it('hides one tenant’s resources from another', async () => {
      await createRoom(app, alpha, 'Alpha Room');
      const response = await app.inject({
        method: 'GET',
        url: '/api/resources',
        headers: { cookie: beta.cookie },
      });
      expect(response.json<{ resources: unknown[] }>().resources).toHaveLength(0);
    });

    it('refuses a booking against another tenant’s resource, by id', async () => {
      const alphaRoom = await createRoom(app, alpha, 'Alpha Room');
      const { start, end } = futureWindow();

      // The id is correct and exists — RLS is the only thing standing in the way.
      const response = await app.inject(
        bookRequest(beta, {
          resourceId: alphaRoom.id,
          startsAt: start,
          endsAt: end,
          idempotencyKey: randomUUID(),
        }),
      );

      expect(response.statusCode).toBe(404);
    });

    it('hides one tenant’s bookings from another', async () => {
      const alphaRoom = await createRoom(app, alpha, 'Alpha Room');
      const { start, end } = futureWindow();
      await app.inject(
        bookRequest(alpha, {
          resourceId: alphaRoom.id,
          startsAt: start,
          endsAt: end,
          idempotencyKey: randomUUID(),
        }),
      );

      const response = await app.inject({
        method: 'GET',
        url: `/api/bookings?from=${start}&to=${end}`,
        headers: { cookie: beta.cookie },
      });
      expect(response.json<{ bookings: BookingDto[] }>().bookings).toHaveLength(0);
    });
  });

  describe('window validation', () => {
    it('refuses a booking in the past', async () => {
      const workspace = await signUpWorkspace(app);
      const room = await createRoom(app, workspace);
      const start = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      const end = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      const response = await app.inject(
        bookRequest(workspace, {
          resourceId: room.id,
          startsAt: start,
          endsAt: end,
          idempotencyKey: randomUUID(),
        }),
      );

      expect(response.statusCode).toBe(422);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('IN_THE_PAST');
    });

    it('refuses a booking on an inactive resource', async () => {
      const workspace = await signUpWorkspace(app);
      const room = await createRoom(app, workspace);
      await app.inject({
        method: 'PATCH',
        url: `/api/resources/${room.id}`,
        headers: { cookie: workspace.cookie },
        payload: { isActive: false },
      });

      const { start, end } = futureWindow();
      const response = await app.inject(
        bookRequest(workspace, {
          resourceId: room.id,
          startsAt: start,
          endsAt: end,
          idempotencyKey: randomUUID(),
        }),
      );

      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('RESOURCE_INACTIVE');
    });

    it('caps how wide a calendar query may be', async () => {
      const workspace = await signUpWorkspace(app);
      const from = new Date('2026-01-01T00:00:00Z').toISOString();
      const to = new Date('2026-12-31T00:00:00Z').toISOString();

      const response = await app.inject({
        method: 'GET',
        url: `/api/bookings?from=${from}&to=${to}`,
        headers: { cookie: workspace.cookie },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('RANGE_TOO_WIDE');
    });
  });

  describe('authentication', () => {
    it('refuses an unauthenticated booking list', async () => {
      const { start, end } = futureWindow();
      const response = await app.inject({
        method: 'GET',
        url: `/api/bookings?from=${start}&to=${end}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('ends the session on logout', async () => {
      const workspace = await signUpWorkspace(app);
      await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: workspace.cookie },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: workspace.cookie },
      });
      expect(response.statusCode).toBe(401);
    });

    it('gives the same answer for a wrong password and an unknown workspace', async () => {
      const unknownWorkspace = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { tenantSlug: 'no-such-place', email: 'a@b.test', password: 'whatever-at-all' },
      });
      const workspace = await signUpWorkspace(app);
      const wrongPassword = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          tenantSlug: workspace.session.tenant.slug,
          email: workspace.session.user.email,
          password: 'not-the-right-password',
        },
      });

      expect(unknownWorkspace.statusCode).toBe(401);
      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownWorkspace.json()).toEqual(wrongPassword.json());
    });
  });
});

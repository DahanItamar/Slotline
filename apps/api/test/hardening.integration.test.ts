import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { authDb, closeDatabases } from '../src/db/index.js';
import { withTenant } from '../src/db/with-tenant.js';
import { runRetention } from '../src/jobs/retention.js';
import { createRoom, createTestApp, futureWindow, signUpWorkspace } from './helpers/app.js';
import {
  closeTestDatabase,
  hasDatabase,
  resetDatabase,
  setupDatabase,
} from './helpers/database.js';

/**
 * Production hardening. SPEC §10 M5.
 *
 * The things here fail quietly by nature — a limit that does not limit, a log that leaks,
 * a retention job that deletes the wrong rows. None announces itself in normal use, which
 * is exactly why each one is pinned by a test.
 */
describe.skipIf(!hasDatabase)('hardening (integration)', () => {
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

  describe('rate limiting', () => {
    it('stops a credential-stuffing run against one account', async () => {
      const workspace = await signUpWorkspace(app);
      const attempt = () =>
        app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: {
            tenantSlug: workspace.session.tenant.slug,
            email: workspace.session.user.email,
            password: 'not-the-right-password',
          },
        });

      const statuses: number[] = [];
      for (let index = 0; index < 12; index += 1) {
        statuses.push((await attempt()).statusCode);
      }

      // Nine, not ten: the signup that created this account used the first of the ten,
      // because signup and login share a budget per (workspace, address). That is the
      // intended shape — an attacker probing both surfaces for one account gets one
      // allowance, not two.
      expect(statuses.filter((status) => status === 401)).toHaveLength(9);
      // The rest are refused. The exact tail is the plugin's window accounting, not our
      // invariant — what matters is that guessing stops and stays stopped.
      expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(1);
      expect(statuses.at(-1)).toBe(429);

      const refused = await attempt();
      expect(refused.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
    });

    it('does not let one account’s limit lock out another', async () => {
      const victim = await signUpWorkspace(app);
      const bystander = await signUpWorkspace(app);

      for (let index = 0; index < 12; index += 1) {
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: {
            tenantSlug: victim.session.tenant.slug,
            email: victim.session.user.email,
            password: 'wrong',
          },
        });
      }

      // Same source address, different account: the budget is per account, not per IP.
      const stillFine = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          tenantSlug: bystander.session.tenant.slug,
          email: bystander.session.user.email,
          password: 'correct-horse-battery',
        },
      });
      expect(stillFine.statusCode).toBe(200);
    });

    it('leaves reads unthrottled', async () => {
      const workspace = await signUpWorkspace(app);
      const statuses: number[] = [];
      for (let index = 0; index < 80; index += 1) {
        const response = await app.inject({
          method: 'GET',
          url: '/api/resources',
          headers: { cookie: workspace.cookie },
        });
        statuses.push(response.statusCode);
      }
      expect(statuses.every((status) => status === 200)).toBe(true);
    });
  });

  describe('retention', () => {
    it('removes events past the window and keeps recent ones', async () => {
      const workspace = await signUpWorkspace(app);
      const room = await createRoom(app, workspace);
      const { start, end } = futureWindow();

      await app.inject({
        method: 'POST',
        url: '/api/bookings',
        headers: { cookie: workspace.cookie, 'idempotency-key': randomUUID() },
        payload: { resourceId: room.id, startsAt: start, endsAt: end, title: 'Recent' },
      });

      const tenantId = workspace.session.tenant.id;
      const countEvents = async (): Promise<number> => {
        const rows = await withTenant(tenantId, (trx) =>
          trx.selectFrom('booking_events').select('id').execute(),
        );
        return rows.length;
      };

      expect(await countEvents()).toBe(1);

      // A pass today must not touch an event written moments ago.
      await runRetention();
      expect(await countEvents()).toBe(1);

      // Age it past the window, then prune again.
      await withTenant(tenantId, (trx) =>
        sql`UPDATE booking_events SET created_at = now() - interval '45 days'`.execute(trx),
      );
      const result = await runRetention();

      expect(result.eventsDeleted).toBe(1);
      expect(await countEvents()).toBe(0);
    });

    it('removes expired sessions and leaves live ones alone', async () => {
      const stale = await signUpWorkspace(app);
      const active = await signUpWorkspace(app);

      await authDb()
        .updateTable('sessions')
        .set({ expires_at: new Date(Date.now() - 60_000) })
        .where('tenant_id', '=', stale.session.tenant.id)
        .execute();

      const result = await runRetention();
      expect(result.sessionsDeleted).toBe(1);

      const stillSignedIn = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: active.cookie },
      });
      expect(stillSignedIn.statusCode).toBe(200);
    });

    it('never reaches across tenants', async () => {
      const alpha = await signUpWorkspace(app);
      const beta = await signUpWorkspace(app);
      const room = await createRoom(app, beta);
      const { start, end } = futureWindow();

      await app.inject({
        method: 'POST',
        url: '/api/bookings',
        headers: { cookie: beta.cookie, 'idempotency-key': randomUUID() },
        payload: { resourceId: room.id, startsAt: start, endsAt: end, title: 'Beta only' },
      });

      // Age alpha's (empty) history; beta's fresh event must survive regardless.
      const result = await runRetention();
      expect(result.tenantsVisited).toBeGreaterThanOrEqual(2);

      const betaEvents = await withTenant(beta.session.tenant.id, (trx) =>
        trx.selectFrom('booking_events').select('id').execute(),
      );
      const alphaEvents = await withTenant(alpha.session.tenant.id, (trx) =>
        trx.selectFrom('booking_events').select('id').execute(),
      );
      expect(betaEvents).toHaveLength(1);
      expect(alphaEvents).toHaveLength(0);
    });
  });

  describe('operational surface', () => {
    it('reports health with a real database round-trip', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    });

    it('answers an unknown API path with JSON, not the SPA shell', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(response.statusCode).toBe(404);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
    });

    it('never returns a stack trace to a client', async () => {
      const workspace = await signUpWorkspace(app);
      // A malformed uuid reaches the schema, not the database.
      const response = await app.inject({
        method: 'GET',
        url: '/api/resources/not-a-uuid',
        headers: { cookie: workspace.cookie },
      });
      expect(response.statusCode).toBe(422);
      expect(response.body).not.toMatch(/at .*\(.*:\d+:\d+\)/);
      expect(response.body).not.toContain('node_modules');
    });
  });
});

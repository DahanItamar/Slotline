import type { FastifyInstance, InjectOptions } from 'fastify';
import { DateTime } from 'luxon';
import type { ResourceDto, SessionDto } from '@slotline/shared';
import { buildApp } from '../../src/app.js';

/** A signed-in tenant, ready to make requests. */
export type Workspace = {
  cookie: string;
  session: SessionDto;
};

let counter = 0;
const uniqueSlug = (): string => `acme-${String(++counter).padStart(4, '0')}`;

export async function createTestApp(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.ready();
  return app;
}

export async function signUpWorkspace(
  app: FastifyInstance,
  overrides: Partial<{ slug: string; timezone: string; email: string }> = {},
): Promise<Workspace> {
  const slug = overrides.slug ?? uniqueSlug();
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: {
      tenantName: 'Acme',
      tenantSlug: slug,
      timezone: overrides.timezone ?? 'Europe/Berlin',
      email: overrides.email ?? `owner@${slug}.test`,
      password: 'correct-horse-battery',
      displayName: 'Ada Owner',
    },
  });

  if (response.statusCode !== 201) {
    throw new Error(`signup failed: ${response.statusCode} ${response.body}`);
  }

  const setCookie = response.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error('signup returned no session cookie');

  return {
    cookie: raw.split(';')[0] ?? '',
    session: response.json<SessionDto>(),
  };
}

export async function createRoom(
  app: FastifyInstance,
  workspace: Workspace,
  name = 'Room A',
): Promise<ResourceDto> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/resources',
    headers: { cookie: workspace.cookie },
    payload: { kind: 'room', name, minMinutes: 15, maxMinutes: 480 },
  });
  if (response.statusCode !== 201) {
    throw new Error(`resource creation failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<ResourceDto>();
}

export type BookingAttempt = {
  resourceId: string;
  startsAt: string;
  endsAt: string;
  title?: string;
  idempotencyKey: string;
};

export function bookRequest(workspace: Workspace, attempt: BookingAttempt): InjectOptions {
  return {
    method: 'POST',
    url: '/api/bookings',
    headers: {
      cookie: workspace.cookie,
      'idempotency-key': attempt.idempotencyKey,
    },
    payload: {
      resourceId: attempt.resourceId,
      startsAt: attempt.startsAt,
      endsAt: attempt.endsAt,
      title: attempt.title ?? 'Standup',
    },
  };
}

/**
 * A future window pinned to a wall-clock hour on a chosen weekday in a chosen zone —
 * what availability tests actually need, since a rule is a claim about local time.
 */
export function futureLocalWindow(options: {
  zone: string;
  /** ISO-8601: 1 = Monday ... 7 = Sunday. */
  weekday: number;
  hour: number;
  durationHours?: number;
}): { start: string; end: string; localDate: string } {
  let day = DateTime.now().setZone(options.zone).plus({ days: 2 }).startOf('day');
  while (day.weekday !== options.weekday) day = day.plus({ days: 1 });

  const start = day.set({ hour: options.hour });
  const end = start.plus({ hours: options.durationHours ?? 1 });

  return {
    start: start.toUTC().toISO() ?? '',
    end: end.toUTC().toISO() ?? '',
    localDate: day.toISODate() ?? '',
  };
}

/** A fixed future window, safely inside the 365-day horizon and never in the past. */
export function futureWindow(offsetHours = 0, durationHours = 1): { start: string; end: string } {
  const base = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  base.setUTCMinutes(0, 0, 0);
  base.setUTCHours(9 + offsetHours);
  const end = new Date(base.getTime() + durationHours * 60 * 60 * 1000);
  return { start: base.toISOString(), end: end.toISOString() };
}

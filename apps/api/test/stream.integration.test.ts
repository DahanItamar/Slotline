import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BookingDto, ResourceDto, SessionDto } from '@slotline/shared';
import { closeDatabases } from '../src/db/index.js';
import { createTestApp, futureWindow } from './helpers/app.js';
import {
  closeTestDatabase,
  hasDatabase,
  resetDatabase,
  setupDatabase,
} from './helpers/database.js';
import { SseClient } from './helpers/sse.js';

/**
 * Live push, over real HTTP against a really listening server. SPEC §10 M3.
 *
 * The property under test is the one a user actually feels: someone else books, and my
 * grid knows within a second without my touching it — and if I was away, I find out what
 * I missed rather than quietly holding a stale calendar.
 */
describe.skipIf(!hasDatabase)('booking stream (integration)', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let openClients: SseClient[] = [];

  type Workspace = { cookie: string; session: SessionDto };

  async function post<T>(path: string, cookie: string, body: unknown, headers = {}): Promise<T> {
    const response = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path} -> ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }

  async function signUp(): Promise<Workspace> {
    const slug = `stream-${randomUUID().slice(0, 8)}`;
    const response = await fetch(`${baseUrl}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantName: 'Stream Co',
        tenantSlug: slug,
        timezone: 'UTC',
        email: `a@${slug}.test`,
        password: 'correct-horse-battery',
        displayName: 'Ada Owner',
      }),
    });
    if (response.status !== 201) throw new Error(`signup -> ${await response.text()}`);
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    return { cookie, session: (await response.json()) as SessionDto };
  }

  const createRoom = (workspace: Workspace, name = 'Room A') =>
    post<ResourceDto>('/api/resources', workspace.cookie, { kind: 'room', name });

  const book = (workspace: Workspace, roomId: string, offsetHours = 0) => {
    const { start, end } = futureWindow(offsetHours);
    return post<BookingDto>(
      '/api/bookings',
      workspace.cookie,
      { resourceId: roomId, startsAt: start, endsAt: end, title: `Meeting ${offsetHours}` },
      { 'idempotency-key': randomUUID() },
    );
  };

  async function openStream(workspace: Workspace, lastEventId?: string): Promise<SseClient> {
    const client = await SseClient.open(baseUrl, workspace.cookie, lastEventId);
    openClients.push(client);
    return client;
  }

  beforeAll(async () => {
    await setupDatabase();
    app = await createTestApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    for (const client of openClients) client.close();
    openClients = [];
    await resetDatabase();
  });

  afterAll(async () => {
    for (const client of openClients) client.close();
    await app.close();
    await closeDatabases();
    await closeTestDatabase();
  });

  it('pushes a booking to a stream that was already open', async () => {
    const workspace = await signUp();
    const room = await createRoom(workspace);
    const stream = await openStream(workspace);

    const booking = await book(workspace, room.id);
    const frame = await stream.waitFor((candidate) => candidate.event === 'booking.created');

    expect(frame.id).toBeDefined();
    const payload = JSON.parse(frame.data ?? '{}') as { booking: BookingDto };
    expect(payload.booking.id).toBe(booking.id);
    expect(payload.booking.title).toBe(booking.title);
  });

  it('reaches a second viewer, not only the person who booked', async () => {
    const workspace = await signUp();
    const room = await createRoom(workspace);
    const watcher = await openStream(workspace);
    const other = await openStream(workspace);

    await book(workspace, room.id);

    await watcher.waitFor((frame) => frame.event === 'booking.created');
    await other.waitFor((frame) => frame.event === 'booking.created');
  });

  it('never leaks one tenant’s events to another', async () => {
    const alpha = await signUp();
    const beta = await signUp();
    const alphaRoom = await createRoom(alpha);

    const betaStream = await openStream(beta);
    const alphaStream = await openStream(alpha);

    await book(alpha, alphaRoom.id);

    await alphaStream.waitFor((frame) => frame.event === 'booking.created');
    await betaStream.settle();
    expect(betaStream.frames.filter((frame) => frame.event === 'booking.created')).toHaveLength(0);
  });

  describe('reconnection', () => {
    it('replays what was missed while disconnected', async () => {
      const workspace = await signUp();
      const room = await createRoom(workspace);

      const first = await openStream(workspace);
      const seen = await book(workspace, room.id, 0);
      const frame = await first.waitFor((candidate) => candidate.event === 'booking.created');
      const lastEventId = frame.id ?? '';

      // The client goes away — a closed laptop, a restarted server, a dropped network.
      first.close();

      const missedA = await book(workspace, room.id, 2);
      const missedB = await book(workspace, room.id, 4);

      // Exactly what the browser's EventSource sends on its own when it reconnects.
      const resumed = await openStream(workspace, lastEventId);
      await resumed.waitFor((candidate) => {
        const payload = JSON.parse(candidate.data ?? '{}') as { booking?: BookingDto };
        return payload.booking?.id === missedB.id;
      });

      const replayed = resumed.frames
        .filter((candidate) => candidate.event === 'booking.created')
        .map(
          (candidate) => (JSON.parse(candidate.data ?? '{}') as { booking: BookingDto }).booking.id,
        );

      expect(replayed).toEqual([missedA.id, missedB.id]);
      // The one it already had is not sent twice.
      expect(replayed).not.toContain(seen.id);
    });

    it('sends nothing at all to a client that missed nothing', async () => {
      const workspace = await signUp();
      const room = await createRoom(workspace);

      const first = await openStream(workspace);
      await book(workspace, room.id);
      const frame = await first.waitFor((candidate) => candidate.event === 'booking.created');
      first.close();

      const resumed = await openStream(workspace, frame.id);
      await resumed.settle();
      expect(resumed.frames.filter((candidate) => candidate.event === 'booking.created')).toEqual(
        [],
      );
    });

    it('tells a client with an impossible position to resync', async () => {
      const workspace = await signUp();
      const stream = await openStream(workspace, '999999999');

      const frame = await stream.waitFor((candidate) => candidate.event === 'resync');
      expect(JSON.parse(frame.data ?? '{}')).toMatchObject({ reason: 'unknown_event_id' });
      // A resync carries no id: it is not a position to resume from later.
      expect(frame.id).toBeUndefined();
    });

    it('ignores a malformed Last-Event-ID rather than failing the connection', async () => {
      const workspace = await signUp();
      const room = await createRoom(workspace);
      const stream = await openStream(workspace, 'not-a-number');

      expect(stream.status).toBe(200);
      await book(workspace, room.id);
      await stream.waitFor((frame) => frame.event === 'booking.created');
    });
  });

  describe('limits', () => {
    it('refuses a fourth concurrent stream for one account', async () => {
      const workspace = await signUp();
      for (let index = 0; index < 3; index += 1) {
        const client = await openStream(workspace);
        expect(client.status).toBe(200);
      }

      const fourth = await openStream(workspace);
      expect(fourth.status).toBe(409);
    });

    it('frees a slot when a stream closes', async () => {
      const workspace = await signUp();
      const clients = [await openStream(workspace), await openStream(workspace)];
      const third = await openStream(workspace);
      expect(third.status).toBe(200);

      third.close();
      // The server learns of the close asynchronously.
      await clients[0]?.settle(300);

      const replacement = await openStream(workspace);
      expect(replacement.status).toBe(200);
    });
  });

  it('refuses an unauthenticated stream', async () => {
    const response = await fetch(`${baseUrl}/api/stream`, {
      headers: { accept: 'text/event-stream' },
    });
    expect(response.status).toBe(401);
    await response.text();
  });
});

import type { FastifyInstance, FastifyReply } from 'fastify';
import { newId } from '../lib/ids.js';
import {
  closeAll,
  formatEventFrame,
  formatResyncFrame,
  HEARTBEAT_FRAME,
  MAX_STREAMS_PER_PROCESS,
  MAX_STREAMS_PER_USER,
  streamsForUser,
  subscribe,
  subscriberCount,
  type Subscriber,
} from '../realtime/hub.js';
import {
  latestEventId,
  MAX_REPLAY_EVENTS,
  parseEventId,
  readEventsAfter,
} from '../services/event-service.js';
import { requireAuth, sessionOf } from './plugins/auth.js';

/**
 * `GET /api/stream` — the live update channel. SPEC §6.
 *
 * SSE rather than WebSockets because the traffic is one-way: the server tells clients
 * what changed and clients never push back. That buys automatic browser reconnection and
 * `Last-Event-ID` replay for free, instead of hand-rolling both.
 */

const HEARTBEAT_INTERVAL_MS = 25_000;

/** What to send a reconnecting client. */
type Resume =
  | { kind: 'replay'; events: Awaited<ReturnType<typeof readEventsAfter>>; from: bigint }
  | { kind: 'resync'; reason: string; from: bigint }
  | { kind: 'fresh'; from: bigint };

/**
 * A client that has been away longer than the log can cover cannot be caught up frame by
 * frame, so it is told to throw its cache away and refetch. Silently sending a partial
 * history would leave a gap the user never sees.
 */
async function resolveResume(tenantId: string, lastEventId: bigint | null): Promise<Resume> {
  const latest = await latestEventId(tenantId);
  if (lastEventId === null) return { kind: 'fresh', from: latest };

  // An id ahead of our newest means a different database, a restore, or a stale tab.
  if (lastEventId > latest) return { kind: 'resync', reason: 'unknown_event_id', from: latest };

  // Read one more than the cap: if it comes back, the client is further behind than a
  // replay can honestly cover.
  const events = await readEventsAfter(tenantId, lastEventId, MAX_REPLAY_EVENTS + 1);
  if (events.length > MAX_REPLAY_EVENTS) {
    return { kind: 'resync', reason: 'event_horizon', from: latest };
  }
  return { kind: 'replay', events, from: lastEventId };
}

function openStream(reply: FastifyReply): (frame: string) => void {
  // Fastify must not try to send its own response for this route.
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Tells nginx-style proxies not to buffer, which would defeat the whole point.
    'x-accel-buffering': 'no',
  });
  reply.raw.flushHeaders();

  return (frame: string) => {
    if (!reply.raw.writableEnded) reply.raw.write(frame);
  };
}

export function registerStreamRoutes(app: FastifyInstance): void {
  app.get('/api/stream', { preHandler: requireAuth }, async (request, reply) => {
    const { tenant, user } = sessionOf(request);

    if (subscriberCount() >= MAX_STREAMS_PER_PROCESS) {
      return reply.status(503).send({
        error: { code: 'INTERNAL', message: 'Too many open streams. Try again shortly.' },
      });
    }
    if (streamsForUser(tenant.id, user.id) >= MAX_STREAMS_PER_USER) {
      return reply.status(409).send({
        error: { code: 'INTERNAL', message: 'This account already has three open streams.' },
      });
    }

    const lastEventId = parseEventId(
      typeof request.headers['last-event-id'] === 'string'
        ? request.headers['last-event-id']
        : undefined,
    );
    const resume = await resolveResume(tenant.id, lastEventId);

    const send = openStream(reply);

    // Replay before subscribing, so the watermark is current by the time the listener
    // can reach this subscriber — no event is sent twice and none is skipped.
    let watermark = resume.from;
    if (resume.kind === 'resync') send(formatResyncFrame(resume.reason));
    if (resume.kind === 'replay') {
      for (const event of resume.events) {
        send(formatEventFrame(event));
        watermark = BigInt(event.id);
      }
    }

    const subscriber: Subscriber = {
      id: newId(),
      tenantId: tenant.id,
      userId: user.id,
      lastSentId: watermark,
      send,
      close: () => {
        if (!reply.raw.writableEnded) reply.raw.end();
      },
    };

    const unsubscribe = subscribe(subscriber);
    const heartbeat = setInterval(() => {
      send(HEARTBEAT_FRAME);
    }, HEARTBEAT_INTERVAL_MS);

    const teardown = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on('close', teardown);
    request.raw.on('error', teardown);

    request.log.info({ tenantId: tenant.id, userId: user.id }, 'stream opened');
    return reply;
  });

  app.addHook('onClose', (_instance, done) => {
    closeAll();
    done();
  });
}

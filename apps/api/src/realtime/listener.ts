import pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env.js';
import { describeUnknown } from '../lib/errors.js';
import { NOTIFY_CHANNEL, parseNotification } from '../services/booking-events.js';
import { readEventsAfter } from '../services/event-service.js';
import { dispatch, hasSubscribers, lowestWatermark } from './hub.js';

/**
 * One dedicated connection holding `LISTEN booking_events`, and the catch-up read that
 * turns a notification into frames. SPEC §3, §7 Flow B.
 *
 * This is the only long-lived raw `pg` client in the codebase. It exists because a
 * pooled connection cannot hold a LISTEN — the pool would hand it to someone else.
 *
 * There is no RLS bypass here. The notification carries a tenant id; the events are read
 * under that tenant's own scope via `withTenant`, and tenants with nobody connected are
 * skipped without a query at all.
 */

const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 10_000];
/** Cap on a single catch-up read, so one busy tenant cannot monopolise the listener. */
const FANOUT_BATCH = 500;

type ListenerState = {
  client: pg.Client | null;
  stopped: boolean;
  attempt: number;
  timer: NodeJS.Timeout | null;
};

const state: ListenerState = { client: null, stopped: false, attempt: 0, timer: null };

async function handleNotification(payload: string | undefined, log: FastifyBaseLogger) {
  if (!payload) return;
  const notification = parseNotification(payload);
  if (!notification) {
    log.warn({ payload }, 'unparseable booking event notification');
    return;
  }

  // The cheap exit: nobody from this tenant is watching, so nothing is read at all.
  if (!hasSubscribers(notification.tenantId)) return;

  const since = lowestWatermark(notification.tenantId);
  if (since === null) return;

  try {
    const events = await readEventsAfter(notification.tenantId, since, FANOUT_BATCH);
    dispatch(notification.tenantId, events);
  } catch (error) {
    // A failed read is recoverable: the next notification reads from the same watermark
    // and picks up whatever this one missed.
    log.error({ err: error, tenantId: notification.tenantId }, 'booking event fan-out failed');
  }
}

function scheduleReconnect(log: FastifyBaseLogger): void {
  if (state.stopped) return;
  const delay =
    RECONNECT_DELAYS_MS[Math.min(state.attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 10_000;
  state.attempt += 1;
  log.warn({ delayMs: delay, attempt: state.attempt }, 'booking event listener reconnecting');
  state.timer = setTimeout(() => {
    void connect(log);
  }, delay);
}

async function connect(log: FastifyBaseLogger): Promise<void> {
  if (state.stopped) return;

  const client = new pg.Client({
    connectionString: env().APP_DATABASE_URL,
    application_name: 'slotline-listener',
  });

  // A connection-level error must never take the process down; it means reconnect.
  client.on('error', (error) => {
    log.error({ err: error }, 'booking event listener connection error');
    state.client = null;
    client.end().catch(() => undefined);
    scheduleReconnect(log);
  });

  client.on('notification', (message) => {
    void handleNotification(message.payload, log);
  });

  try {
    await client.connect();
    await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
    state.client = client;
    state.attempt = 0;
    log.info('booking event listener connected');
  } catch (error) {
    log.error({ err: describeUnknown(error) }, 'booking event listener failed to connect');
    await client.end().catch(() => undefined);
    scheduleReconnect(log);
  }
}

export async function startEventListener(log: FastifyBaseLogger): Promise<void> {
  state.stopped = false;
  state.attempt = 0;
  await connect(log);
}

export async function stopEventListener(): Promise<void> {
  state.stopped = true;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const client = state.client;
  state.client = null;
  if (client) await client.end().catch(() => undefined);
}

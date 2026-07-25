import type { BookingEventRecord } from '../services/event-service.js';

/**
 * Holds the open SSE responses and fans events out to them. SPEC §6, §7 Flow B.
 *
 * Deliberately knows nothing about HTTP: a subscriber is anything that can be handed a
 * frame and closed. That keeps the route thin and makes the hub testable on its own.
 */

/** SPEC §6: three streams per user, five hundred per process. */
export const MAX_STREAMS_PER_USER = 3;
export const MAX_STREAMS_PER_PROCESS = 500;

export type Subscriber = {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  /** Highest event id this particular subscriber has been sent. */
  lastSentId: bigint;
  send: (frame: string) => void;
  close: () => void;
};

const byTenant = new Map<string, Set<Subscriber>>();

export function subscriberCount(): number {
  let total = 0;
  for (const set of byTenant.values()) total += set.size;
  return total;
}

export function streamsForUser(tenantId: string, userId: string): number {
  const set = byTenant.get(tenantId);
  if (!set) return 0;
  let count = 0;
  for (const subscriber of set) if (subscriber.userId === userId) count += 1;
  return count;
}

export function subscribe(subscriber: Subscriber): () => void {
  let set = byTenant.get(subscriber.tenantId);
  if (!set) {
    set = new Set();
    byTenant.set(subscriber.tenantId, set);
  }
  set.add(subscriber);

  return () => {
    const current = byTenant.get(subscriber.tenantId);
    if (!current) return;
    current.delete(subscriber);
    if (current.size === 0) byTenant.delete(subscriber.tenantId);
  };
}

export function hasSubscribers(tenantId: string): boolean {
  return (byTenant.get(tenantId)?.size ?? 0) > 0;
}

/**
 * The lowest watermark across a tenant's subscribers — how far back the listener has to
 * read to satisfy everyone. A subscriber that just replayed is already current, so this
 * is usually the newest id and the read returns one row.
 */
export function lowestWatermark(tenantId: string): bigint | null {
  const set = byTenant.get(tenantId);
  if (!set || set.size === 0) return null;
  let lowest: bigint | null = null;
  for (const subscriber of set) {
    if (lowest === null || subscriber.lastSentId < lowest) lowest = subscriber.lastSentId;
  }
  return lowest;
}

export function formatEventFrame(event: BookingEventRecord): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({ booking: event.booking })}\n\n`;
}

/** No id: a resync is not a position the client should later resume from. */
export function formatResyncFrame(reason: string): string {
  return `event: resync\ndata: ${JSON.stringify({ reason })}\n\n`;
}

/** A comment frame. Keeps proxies from closing an idle stream. */
export const HEARTBEAT_FRAME = ': keepalive\n\n';

/**
 * Sends each subscriber only what it has not already seen, then advances its watermark.
 * Events arrive ordered by id, so a partial failure cannot leave a gap behind a success.
 */
export function dispatch(tenantId: string, events: readonly BookingEventRecord[]): void {
  const set = byTenant.get(tenantId);
  if (!set || events.length === 0) return;

  for (const subscriber of set) {
    for (const event of events) {
      const eventId = BigInt(event.id);
      if (eventId <= subscriber.lastSentId) continue;
      subscriber.send(formatEventFrame(event));
      subscriber.lastSentId = eventId;
    }
  }
}

/** Closes every stream. Called on shutdown so clients reconnect rather than hang. */
export function closeAll(): void {
  for (const set of byTenant.values()) {
    for (const subscriber of set) subscriber.close();
  }
  byTenant.clear();
}

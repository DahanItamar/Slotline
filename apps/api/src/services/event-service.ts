import type { BookingDto } from '@slotline/shared';
import type { BookingEventType } from '../db/types.js';
import { withTenant } from '../db/with-tenant.js';

/**
 * Reading the booking event log — for SSE fan-out and for `Last-Event-ID` replay.
 *
 * Every read goes through `withTenant`, so there is no RLS bypass anywhere in the
 * realtime path: the listener groups notifications by tenant and reads each tenant's
 * events under that tenant's own scope. SPEC §7 Flow B.
 */

export type BookingEventRecord = {
  /** bigint as a string — it is an opaque cursor to the client, not arithmetic. */
  id: string;
  type: BookingEventType;
  booking: BookingDto;
};

/** Cap on a single fan-out or replay read. Beyond this, the client is told to resync. */
export const MAX_REPLAY_EVENTS = 2000;

export async function readEventsAfter(
  tenantId: string,
  afterId: bigint,
  limit = MAX_REPLAY_EVENTS,
): Promise<BookingEventRecord[]> {
  const rows = await withTenant(tenantId, (trx) =>
    trx
      .selectFrom('booking_events')
      .select(['id', 'type', 'payload'])
      .where('id', '>', afterId.toString())
      .orderBy('id')
      .limit(limit)
      .execute(),
  );

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    booking: row.payload as BookingDto,
  }));
}

/** The tenant's newest event id, or 0n when it has no history yet. */
export async function latestEventId(tenantId: string): Promise<bigint> {
  const row = await withTenant(tenantId, (trx) =>
    trx.selectFrom('booking_events').select('id').orderBy('id', 'desc').limit(1).executeTakeFirst(),
  );
  return row ? BigInt(row.id) : 0n;
}

/** `Last-Event-ID` is client-supplied: anything unparseable is treated as absent. */
export function parseEventId(value: string | undefined): bigint | null {
  if (value === undefined || !/^\d{1,19}$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

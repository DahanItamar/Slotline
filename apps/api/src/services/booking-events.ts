import { sql } from 'kysely';
import type { BookingDto } from '@slotline/shared';
import type { BookingEventType } from '../db/types.js';
import type { TenantTransaction } from '../db/with-tenant.js';

/**
 * The append-only booking log, and the notification that drives live updates. SPEC §3.
 *
 * Both the row and the `pg_notify` happen inside the caller's transaction. Postgres holds
 * a NOTIFY until commit, so a client can never be told about a booking that then rolled
 * back — which is exactly the failure a fire-and-forget publish after the commit would
 * produce on its bad day.
 */

export const NOTIFY_CHANNEL = 'booking_events';

/**
 * Deliberately carries identifiers only. NOTIFY payloads are capped at 8000 bytes and a
 * booking with a 2000-character note would crowd that; the listener reads the row itself,
 * and skips the read entirely when no one from that tenant is connected.
 */
export type BookingEventNotification = {
  tenantId: string;
  eventId: string;
};

export async function recordBookingEvent(
  trx: TenantTransaction,
  event: {
    tenantId: string;
    type: BookingEventType;
    actorUserId: string | null;
    booking: BookingDto;
  },
): Promise<string> {
  const inserted = await trx
    .insertInto('booking_events')
    .values({
      tenant_id: event.tenantId,
      booking_id: event.booking.id,
      resource_id: event.booking.resourceId,
      type: event.type,
      actor_user_id: event.actorUserId,
      payload: JSON.stringify(event.booking),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const notification: BookingEventNotification = {
    tenantId: event.tenantId,
    eventId: inserted.id,
  };
  await sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify(notification)})`.execute(trx);

  return inserted.id;
}

export function parseNotification(payload: string): BookingEventNotification | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'tenantId' in parsed &&
      'eventId' in parsed &&
      typeof parsed.tenantId === 'string' &&
      typeof parsed.eventId === 'string'
    ) {
      return { tenantId: parsed.tenantId, eventId: parsed.eventId };
    }
    return null;
  } catch {
    // A malformed payload is not worth crashing the listener over; the catch-up read on
    // the next notification will pick up anything this one would have carried.
    return null;
  }
}

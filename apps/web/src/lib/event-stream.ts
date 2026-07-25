import type { BookingDto } from '@slotline/shared';

/**
 * The browser's own `EventSource`, wrapped so callers deal in typed events.
 *
 * `EventSource` reconnects on its own and replays `Last-Event-ID` without being asked,
 * which is most of why SSE was chosen over WebSockets — that behaviour would otherwise
 * be ours to write and ours to get wrong. SPEC §3.
 */

export type BookingStreamEvent =
  | { kind: 'booking.created'; booking: BookingDto }
  | { kind: 'booking.rescheduled'; booking: BookingDto }
  | { kind: 'booking.cancelled'; booking: BookingDto }
  /** The server could not catch us up frame by frame. Drop the cache and refetch. */
  | { kind: 'resync'; reason: string };

const BOOKING_EVENTS = ['booking.created', 'booking.rescheduled', 'booking.cancelled'] as const;

function parseBooking(raw: string): BookingDto | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'booking' in parsed) {
      return parsed.booking as BookingDto;
    }
    return null;
  } catch {
    return null;
  }
}

export function openBookingStream(handlers: {
  onEvent: (event: BookingStreamEvent) => void;
  onStatusChange?: (connected: boolean) => void;
}): () => void {
  const source = new EventSource('/api/stream', { withCredentials: true });

  source.onopen = () => {
    handlers.onStatusChange?.(true);
  };

  // Fires on every disconnect too, at which point EventSource is already retrying. The
  // one case worth acting on is a session that expired, which surfaces as a reconnect
  // that keeps failing; the next API call will 401 and route to login anyway.
  source.onerror = () => {
    handlers.onStatusChange?.(false);
  };

  for (const kind of BOOKING_EVENTS) {
    source.addEventListener(kind, (message: MessageEvent<string>) => {
      const booking = parseBooking(message.data);
      if (booking) handlers.onEvent({ kind, booking });
    });
  }

  source.addEventListener('resync', (message: MessageEvent<string>) => {
    let reason = 'unknown';
    try {
      const parsed: unknown = JSON.parse(message.data);
      if (typeof parsed === 'object' && parsed !== null && 'reason' in parsed) {
        reason = String(parsed.reason);
      }
    } catch {
      // Reason is for the log only; the action is the same either way.
    }
    handlers.onEvent({ kind: 'resync', reason });
  });

  return () => {
    source.close();
  };
}

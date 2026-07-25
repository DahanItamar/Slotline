import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { BookingDto } from '@slotline/shared';
import { ALL_RESOURCES } from '../features/calendar/useBookings';
import { openBookingStream, type BookingStreamEvent } from '../lib/event-stream';

/**
 * Keeps every open calendar current. SPEC §7 Flow B.
 *
 * Patches the cached booking lists in place rather than refetching per event: a refetch
 * for every booking would turn one person's busy afternoon into a request storm across
 * every connected tab.
 */

/** Matches every cached booking list. Entries are keyed ['bookings', resourceId, from, to]. */
const BOOKINGS_KEY = ['bookings'] as const;

type BookingsQueryKey = readonly [string, string, string, string];

function isBookingsKey(key: readonly unknown[]): key is BookingsQueryKey {
  return key.length === 4 && key[0] === 'bookings' && key.every((part) => typeof part === 'string');
}

/**
 * Whether a booking belongs in the window a given cache entry holds. Read from the query
 * key rather than guessed from the entry's contents — an entry for an empty week has
 * nothing to infer from, and guessing there would scatter bookings into other resources'
 * calendars.
 */
function belongsIn(key: BookingsQueryKey, booking: BookingDto): boolean {
  const [, resourceId, from, to] = key;
  // '*' is the day view across every resource; anything else is one resource's calendar.
  if (resourceId !== ALL_RESOURCES && resourceId !== booking.resourceId) return false;
  // Half-open on both sides, matching the API's own range query.
  return booking.startsAt < to && booking.endsAt > from;
}

function applyEvent(existing: readonly BookingDto[], event: BookingStreamEvent): BookingDto[] {
  if (event.kind === 'resync') return [...existing];

  const without = existing.filter((booking) => booking.id !== event.booking.id);
  if (event.kind === 'booking.cancelled') return without;

  // The version guard matters because an optimistic local block and a stream frame can
  // describe the same booking; the stream must never roll back newer local state.
  const current = existing.find((booking) => booking.id === event.booking.id);
  if (current && current.version > event.booking.version) return [...existing];

  return [...without, event.booking];
}

export function useEventStream(enabled: boolean): { connected: boolean } {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;

    return openBookingStream({
      onStatusChange: setConnected,
      onEvent: (event) => {
        if (event.kind === 'resync') {
          // Further behind than the log can replay: the cache cannot be trusted at all.
          void queryClient.invalidateQueries({ queryKey: BOOKINGS_KEY });
          return;
        }

        for (const query of queryClient.getQueryCache().findAll({ queryKey: BOOKINGS_KEY })) {
          const key = query.queryKey;
          if (!isBookingsKey(key) || !belongsIn(key, event.booking)) continue;
          queryClient.setQueryData<BookingDto[]>(key, (existing) =>
            applyEvent(existing ?? [], event),
          );
        }
      },
    });
  }, [enabled, queryClient]);

  return { connected };
}

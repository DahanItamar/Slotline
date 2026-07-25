import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BookingDto, MembershipRole } from '@slotline/shared';
import { api } from '../../lib/api-client';

/**
 * Cancel and reschedule. Both invalidate rather than patch the cache by hand: the SSE
 * stream delivers the authoritative version moments later anyway, and a hand-patched
 * cache that disagrees with it is worse than a brief refetch.
 */

const BOOKINGS_KEY = ['bookings'] as const;

export function useCancelBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (booking: BookingDto) =>
      api<BookingDto>(`/api/bookings/${booking.id}/cancel`, { method: 'POST' }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: BOOKINGS_KEY });
    },
  });
}

export type RescheduleInput = {
  booking: BookingDto;
  startsAt?: string;
  endsAt?: string;
  title?: string;
};

export function useRescheduleBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ booking, ...changes }: RescheduleInput) =>
      api<BookingDto>(`/api/bookings/${booking.id}`, {
        method: 'PATCH',
        body: changes,
        // The version we believe we are editing. A mismatch comes back as 412 rather
        // than silently overwriting whatever someone else did in the meantime.
        headers: { 'if-match': `"${booking.version}"` },
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: BOOKINGS_KEY });
    },
  });
}

/** Whether the viewer may change this booking. For enabling UI only — never a control. */
export function canModify(
  booking: BookingDto,
  viewer: { id: string; role: MembershipRole },
): boolean {
  return viewer.role !== 'member' || booking.createdByUserId === viewer.id;
}

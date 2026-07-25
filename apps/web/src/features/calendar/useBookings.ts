import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { BookingDto, CreateBookingRequest } from '@slotline/shared';
import { api } from '../../lib/api-client';

export type BookingRange = {
  from: string;
  to: string;
};

/**
 * `'*'` means every resource — what the day view across resources asks for. Keeping it in
 * the key rather than in a separate cache shape lets the event stream decide membership
 * from the key alone.
 */
export const ALL_RESOURCES = '*';

export const bookingsQueryKey = (range: BookingRange, resourceId: string): QueryKey => [
  'bookings',
  resourceId,
  range.from,
  range.to,
];

export function useBookings(range: BookingRange, resourceId: string | null) {
  return useQuery({
    queryKey: bookingsQueryKey(range, resourceId ?? ''),
    enabled: resourceId !== null,
    queryFn: async () => {
      const search = new URLSearchParams({ from: range.from, to: range.to });
      if (resourceId !== null && resourceId !== ALL_RESOURCES) {
        search.set('resourceId', resourceId);
      }
      const { bookings } = await api<{ bookings: BookingDto[] }>(
        `/api/bookings?${search.toString()}`,
      );
      return bookings;
    },
  });
}

/** Marks a block the server has not confirmed yet, so the grid can style it as pending. */
const PENDING_PREFIX = 'pending:';
export const isPending = (booking: BookingDto): boolean => booking.id.startsWith(PENDING_PREFIX);

export function useCreateBooking(range: BookingRange, resourceId: string | null) {
  const queryClient = useQueryClient();
  const key = bookingsQueryKey(range, resourceId ?? '');

  return useMutation({
    mutationFn: async (request: CreateBookingRequest) =>
      api<BookingDto>('/api/bookings', {
        method: 'POST',
        body: request,
        // Required by the API: a retried request must not become a second booking.
        headers: { 'idempotency-key': crypto.randomUUID() },
      }),

    onMutate: async (request) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<BookingDto[]>(key) ?? [];
      const optimistic: BookingDto = {
        id: `${PENDING_PREFIX}${crypto.randomUUID()}`,
        resourceId: request.resourceId,
        createdByUserId: '',
        createdByDisplayName: 'You',
        title: request.title,
        notes: request.notes,
        startsAt: request.startsAt,
        endsAt: request.endsAt,
        status: 'confirmed',
        version: 0,
      };
      queryClient.setQueryData<BookingDto[]>(key, [...previous, optimistic]);
      return { previous };
    },

    // The server rejected it — most often because someone else took the slot in the
    // milliseconds since the drag. Put the grid back exactly as it was.
    onError: (_error, _request, context) => {
      if (context) queryClient.setQueryData(key, context.previous);
    },

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

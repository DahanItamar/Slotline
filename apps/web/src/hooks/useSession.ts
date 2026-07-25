import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings } from 'luxon';
import { useEffect } from 'react';
import type { SessionDto } from '@slotline/shared';
import { api, ApiError } from '../lib/api-client';

export const SESSION_QUERY_KEY = ['session'] as const;

export function useSession(): {
  session: SessionDto | null;
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async () => {
      try {
        return await api<SessionDto>('/api/me');
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  const timezone = query.data?.tenant.timezone;

  /**
   * Every calendar in the app renders in the tenant's zone, not the viewer's. A room is
   * in a place: a colleague in another country must read "Room A, Tuesday 09:00" as the
   * room's occupants mean it. SPEC §3.
   */
  useEffect(() => {
    if (timezone) Settings.defaultZone = timezone;
  }, [timezone]);

  return { session: query.data ?? null, isLoading: query.isLoading };
}

export function useClearSession(): () => void {
  const queryClient = useQueryClient();
  return () => {
    queryClient.setQueryData(SESSION_QUERY_KEY, null);
    void queryClient.invalidateQueries();
  };
}

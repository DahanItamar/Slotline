import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AvailabilityExceptionDto,
  AvailabilityRuleDto,
  CreateAvailabilityExceptionRequest,
  ReplaceAvailabilityRulesResponse,
  ResourceAvailabilityDto,
} from '@slotline/shared';
import { api } from '../../lib/api-client';

export const availabilityQueryKey = (resourceId: string) => ['availability', resourceId] as const;

export function useAvailability(resourceId: string | null) {
  return useQuery({
    queryKey: availabilityQueryKey(resourceId ?? ''),
    enabled: resourceId !== null,
    queryFn: () => api<ResourceAvailabilityDto>(`/api/resources/${resourceId ?? ''}/availability`),
  });
}

export function useReplaceRules(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rules: AvailabilityRuleDto[]) =>
      api<ReplaceAvailabilityRulesResponse>(`/api/resources/${resourceId}/availability-rules`, {
        method: 'PUT',
        body: { rules },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: availabilityQueryKey(resourceId) });
    },
  });
}

export function useCreateException(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateAvailabilityExceptionRequest) =>
      api<AvailabilityExceptionDto>(`/api/resources/${resourceId}/availability-exceptions`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: availabilityQueryKey(resourceId) });
    },
  });
}

export function useDeleteException(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (exceptionId: string) =>
      api<undefined>(`/api/availability-exceptions/${exceptionId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: availabilityQueryKey(resourceId) });
    },
  });
}

/** "09:00" <-> 540. The editor speaks clock time; the API speaks minutes. */
export function minutesToClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function clockToMinutes(clock: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  return total > 1440 ? null : total;
}

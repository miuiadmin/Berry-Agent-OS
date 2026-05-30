import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import type { Session } from '../lib/types';

export function useSessions(agentId: string | null) {
  return useQuery({
    queryKey: ['sessions', agentId],
    queryFn: () => apiFetch<Session[]>(`/sessions?agentId=${agentId}`),
    enabled: !!agentId,
  });
}

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { agentId: string; title?: string; sessionType?: string }) =>
      apiFetch<Session>('/sessions', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['sessions', variables.agentId] });
    },
  });
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import type { Agent } from '../lib/types';

export function useAgents(workspaceId: string) {
  return useQuery({
    queryKey: ['agents', workspaceId],
    queryFn: () => apiFetch<Agent[]>(`/agents?workspaceId=${workspaceId}`),
    enabled: !!workspaceId,
  });
}

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      workspaceId: string;
      orgNodeId?: string;
      superiorId?: string;
      userId: string;
      name: string;
      roleDescription?: string;
      provider: string;
      config: Record<string, unknown>;
      thinkingLevel?: string;
      l2Capabilities?: string[];
    }) =>
      apiFetch<Agent>('/agents', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['agents', variables.workspaceId] });
    },
  });
}

export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string; workspaceId: string; updates: Record<string, unknown> }) =>
      apiFetch(`/agents/${data.id}`, {
        method: 'PATCH',
        body: JSON.stringify(data.updates),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['agents', variables.workspaceId] });
    },
  });
}

export function useArchiveAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string; userId: string; workspaceId: string }) =>
      apiFetch(`/agents/${data.id}/archive?userId=${data.userId}`, { method: 'POST' }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['agents', variables.workspaceId] });
    },
  });
}

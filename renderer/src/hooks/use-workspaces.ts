import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import type { Workspace } from '../lib/types';

export function useWorkspaces(ownerId: string) {
  return useQuery({
    queryKey: ['workspaces', ownerId],
    queryFn: () => apiFetch<Workspace[]>(`/workspaces?ownerId=${ownerId}`),
  });
}

export function useWorkspace(id: string) {
  return useQuery({
    queryKey: ['workspace', id],
    queryFn: () => apiFetch<Workspace>(`/workspaces/${id}`),
    enabled: !!id,
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { ownerId: string; name: string; slug: string; description?: string }) =>
      apiFetch<Workspace>('/workspaces', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });
}

export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/workspaces/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });
}

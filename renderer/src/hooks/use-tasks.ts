import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import type { Task } from '../lib/types';

export function useTasks(projectId: string | null) {
  return useQuery({
    queryKey: ['tasks', projectId],
    queryFn: () => apiFetch<Task[]>(`/tasks?projectId=${projectId}`),
    enabled: !!projectId,
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      projectId: string;
      workspaceId: string;
      columnId: string;
      title: string;
      description?: string;
      priority?: string;
      creatorType: string;
      creatorId: string;
    }) => apiFetch<Task>('/tasks', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['tasks', vars.projectId] });
    },
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; title?: string; description?: string; priority?: string; columnId?: string }) =>
      apiFetch(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useMoveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, columnId, position }: { id: string; columnId: string; position?: number }) =>
      apiFetch(`/tasks/${id}/move`, { method: 'POST', body: JSON.stringify({ columnId, position }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

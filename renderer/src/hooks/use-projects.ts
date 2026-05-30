import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import type { Project, TaskColumn } from '../lib/types';

export function useProjects(workspaceId: string | null) {
  return useQuery({
    queryKey: ['projects', workspaceId],
    queryFn: () => apiFetch<Project[]>(`/projects?workspaceId=${workspaceId}`),
    enabled: !!workspaceId,
  });
}

export function useProject(id: string | null) {
  return useQuery({
    queryKey: ['project', id],
    queryFn: () => apiFetch<Project>(`/projects/${id}`),
    enabled: !!id,
  });
}

export function useProjectColumns(projectId: string | null) {
  return useQuery({
    queryKey: ['project-columns', projectId],
    queryFn: () => apiFetch<TaskColumn[]>(`/projects/${projectId}/columns`),
    enabled: !!projectId,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { workspaceId: string; name: string; description?: string }) =>
      apiFetch<Project>('/projects', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['projects', vars.workspaceId] });
    },
  });
}

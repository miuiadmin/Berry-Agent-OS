import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import type { OrgNode } from '../lib/types';

export function useOrgTree(workspaceId: string) {
  return useQuery({
    queryKey: ['org-tree', workspaceId],
    queryFn: () => apiFetch<OrgNode[]>(`/org/tree/${workspaceId}`),
    enabled: !!workspaceId,
  });
}

export function useCreateNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { workspaceId: string; parentId?: string; name: string; type: string }) =>
      apiFetch<OrgNode>('/org', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['org-tree', variables.workspaceId] });
    },
  });
}

export function useMoveNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { nodeId: string; newParentId: string | null; workspaceId: string }) =>
      apiFetch(`/org/${data.nodeId}/move`, {
        method: 'POST',
        body: JSON.stringify({ newParentId: data.newParentId }),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['org-tree', variables.workspaceId] });
    },
  });
}

export function useDeleteNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { nodeId: string; workspaceId: string }) =>
      apiFetch(`/org/${data.nodeId}`, { method: 'DELETE' }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['org-tree', variables.workspaceId] });
    },
  });
}

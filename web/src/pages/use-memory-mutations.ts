/**
 * useMemoryMutations — 记忆系统相关的所有 mutation 集合。
 *
 * 统一封装 memory 的 4 个 mutation（创建 / 删除 / 提升 / 验证），
 * 成功后自动 toast 提示 + 刷新列表缓存。
 * 从 MemoryPage.tsx 提取。
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { memoryApi } from "@/lib/api";
import { useT } from "@/lib/i18n";

/**
 * @param layer 当前 layer（global/agent/workspace）
 * @param scopeId 当前 scope ID
 * @param onCreateSuccess 创建成功后的回调（关闭表单 + 清空输入）
 */
export function useMemoryMutations(
  layer: string,
  scopeId: string,
  onCreateSuccess: () => void,
) {
  const t = useT();
  const qc = useQueryClient();
  /** 刷新当前 layer/scope 的记忆列表缓存 */
  const invalidateList = () =>
    qc.invalidateQueries({ queryKey: ["memory", layer, scopeId] });

  /** 创建记忆条目（按 layer 分发到不同 API） */
  const createMut = useMutation({
    mutationFn: (data: { key: string; value: string }) => {
      if (layer === "agent") return memoryApi.createAgent({ agentId: scopeId, ...data });
      if (layer === "workspace") return memoryApi.createWorkspace({ workspaceId: scopeId, ...data });
      return memoryApi.createGlobal({ userId: scopeId, ...data });
    },
    onSuccess: () => {
      toast.success(t("memory.memoryCreated"));
      invalidateList();
      onCreateSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  /** 删除记忆条目 */
  const deleteMut = useMutation({
    mutationFn: ({ entryLayer, id }: { entryLayer: string; id: string }) =>
      memoryApi.delete(entryLayer, id),
    onSuccess: () => {
      toast.success(t("memory.memoryDeleted"));
      invalidateList();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  /** 提升记忆到更高层级 */
  const promoteMut = useMutation({
    mutationFn: ({ id, target }: { id: string; target: string }) =>
      memoryApi.promote(id, target),
    onSuccess: () => {
      toast.success(t("memory.memoryPromoted"));
      invalidateList();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  /** 验证记忆条目 */
  const verifyMut = useMutation({
    mutationFn: (id: string) => memoryApi.verify(id),
    onSuccess: () => {
      toast.success(t("memory.memoryVerified"));
      invalidateList();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return { createMut, deleteMut, promoteMut, verifyMut };
}

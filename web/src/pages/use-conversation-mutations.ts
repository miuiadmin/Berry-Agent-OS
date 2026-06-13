/**
 * 对话 mutations hooks（页面 + 侧边栏共用）。
 *
 * 封装对话删除 / 重命名 / 导出 mutations，统一 invalidate / toast / 当前会话清理。
 * 被以下消费方使用：
 *   - ConversationsPage（页面级）
 *   - ConversationSidebar（侧边栏）
 */

import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  apiDelete,
  apiGet,
  exportConversation,
  renameConversation,
  type ConversationInfo,
} from "@/lib/api";
import { useChatStore, flushPersist } from "@/lib/stores/chat-store";
import { clearOutboxForSession } from "@/lib/stores/ws-store";
import { useT } from "@/lib/i18n";

export function useConversationMutations() {
  const queryClient = useQueryClient();
  const t = useT();
  const sessionId = useChatStore((s) => s.sessionId);
  const setSessionId = useChatStore((s) => s.setSessionId);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setSkipAutoRestore = useChatStore((s) => s.setSkipAutoRestore);

  /** 删除后清理前端状态（onSuccess + onError 校验后端已删时复用） */
  const cleanupAfterDelete = (sid: string) => {
    queryClient.invalidateQueries({ queryKey: ["conversations"] });
    clearOutboxForSession(sid);
    if (typeof window !== "undefined" && "BroadcastChannel" in window) {
      new BroadcastChannel("chat-sync").postMessage({ type: "session-deleted", sid });
    }
    if (sid === sessionId) {
      clearMessages();
      setSessionId(null);
      setSkipAutoRestore(true);
      // 立即同步 localStorage：chat-store persist 默认 2s 防抖写，删除当前会话必须立即落盘，
      // 否则刷新快于 2s 会从 localStorage 恢复已删会话（"删了又回来"根因）
      flushPersist();
    }
  };

  /** 删除对话（若删除的是当前活跃对话则清理状态并阻止自动恢复） */
  const deleteConversation = useMutation({
    mutationFn: async (sid: string) => {
      await apiDelete(`/api/conversations/${sid}`);
    },
    onSuccess: (_data, sid) => {
      cleanupAfterDelete(sid);
      toast.success(t("conversations.conversationDeleted"));
    },
    onError: async (err: Error, sid) => {
      // 网络抖动可能后端已删但 HTTP 响应丢失 → GET 校验实际状态（防误判失败导致前端残留已删会话）
      try {
        const list = await apiGet<Array<{ sessionId: string }>>("/api/conversations?limit=200");
        if (!list.some((c) => c.sessionId === sid)) {
          // 后端确实删了（响应丢失误判）→ 清前端（同 onSuccess），不 toast 错误
          cleanupAfterDelete(sid);
          return;
        }
      } catch {
        // GET 也失败（真网络问题）→ 走下面 toast
      }
      toast.error(err.message || t("conversations.failedToDelete"));
    },
  });

  /** 重命名对话 */
  const renameConversationMut = useMutation({
    mutationFn: async ({ sid, title }: { sid: string; title: string }) => {
      await renameConversation(sid, title);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (err: Error) => {
      toast.error(err.message || t("chat.failedToRename"));
    },
  });

  /** 导出单条对话为 JSON 文件下载 */
  const exportSingle = useCallback(
    async (conv: ConversationInfo) => {
      try {
        const messages = await exportConversation(conv.sessionId);
        const data = {
          sessionId: conv.sessionId,
          title: conv.title,
          exportedAt: new Date().toISOString(),
          messages,
        };
        downloadJson(data, `conversation-${conv.sessionId.slice(0, 8)}.json`);
        toast.success(t("conversations.exportedConversation"));
      } catch {
        toast.error(t("conversations.failedToExport"));
      }
    },
    [t],
  );

  /** 导出全部对话为一个打包 JSON 文件 */
  const exportAll = useCallback(
    async (conversations: ConversationInfo[]) => {
      if (!conversations?.length) return;
      try {
        const all = await Promise.all(
          conversations.map(async (conv) => {
            const messages = await exportConversation(conv.sessionId);
            return { sessionId: conv.sessionId, title: conv.title, messages };
          }),
        );
        downloadJson(
          { exportedAt: new Date().toISOString(), conversations: all },
          `conversations-export-${new Date().toISOString().slice(0, 10)}.json`,
        );
        toast.success(
          t("conversations.exportedCount", { count: all.length }),
        );
      } catch {
        toast.error(t("conversations.failedToExportAll"));
      }
    },
    [t],
  );

  return {
    deleteConversation,
    renameConversation: renameConversationMut,
    exportSingle,
    exportAll,
  };
}

// ─── 工具函数 ──────────────────────────────────────────────────────

/** 将对象序列化为 JSON 并触发浏览器下载 */
function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

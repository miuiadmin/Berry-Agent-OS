/**
 * 对话列表页面的 mutations hooks。
 *
 * 封装对话删除 mutation，统一 invalidate / toast / 当前会话清理逻辑。
 * 导出功能（单条 / 全部）也封装在此，因为依赖 query 数据。
 */

import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiDelete, exportConversation, type ConversationInfo } from "@/lib/api";
import { useChatStore } from "@/lib/stores/chat-store";
import { useT } from "@/lib/i18n";

export function useConversationMutations() {
  const queryClient = useQueryClient();
  const t = useT();
  const sessionId = useChatStore((s) => s.sessionId);
  const setSessionId = useChatStore((s) => s.setSessionId);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setSkipAutoRestore = useChatStore((s) => s.setSkipAutoRestore);

  /** 删除对话（若删除的是当前活跃对话则清理状态并阻止自动恢复） */
  const deleteConversation = useMutation({
    mutationFn: async (sid: string) => {
      await apiDelete(`/api/conversations/${sid}`);
    },
    onSuccess: (_data, sid) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      toast.success(t("conversations.conversationDeleted"));
      if (sid === sessionId) {
        clearMessages();
        setSessionId(null);
        setSkipAutoRestore(true);
      }
    },
    onError: (err: Error) => {
      toast.error(err.message || t("conversations.failedToDelete"));
    },
  });

  /** 导出单条对话为 JSON 文件下载 */
  const exportSingle = useCallback(async (conv: ConversationInfo) => {
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
  }, [t]);

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

  return { deleteConversation, exportSingle, exportAll };
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

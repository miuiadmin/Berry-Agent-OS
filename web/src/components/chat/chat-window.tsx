/**
 * 聊天主窗口。
 *
 * 职责（编排层）：
 *   - 历史恢复（sessionId 变化时拉取；无 session 时恢复最近对话）
 *   - 发送 / 重试 / 编辑消息
 *   - 文件拖拽上传（支持 AbortController 中止）
 *   - 渲染消息列表 + 输入框 + 弹窗（委派 / 权限确认）
 *
 * 渲染细节下放到 chat-window-parts.tsx：
 *   - {@link ChatSkeleton} / {@link HistoryError} / {@link ModelSelector} /
 *     {@link PermissionModeSelector} / {@link DelegationDialog} /
 *     {@link PermissionConfirmDialog}
 */

import { useCallback, useEffect, useState, useRef } from "react";
import { useChatSocket } from "@/hooks/use-chat-socket";
import { useChatStore } from "@/lib/stores/chat-store";
import { ChatMessageList } from "@/components/chat/chat-message-list";
import { ChatInput } from "@/components/chat/chat-input";
import { DragOverlay, type Attachment } from "@/components/chat/file-upload";
import { Button } from "@/components/ui/button";
import { PanelLeft } from "lucide-react";
import { apiGet, uploadFile } from "@/lib/api";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { useT } from "@/lib/i18n";
import {
  ChatSkeleton,
  HistoryError,
  DelegationDialog,
  PermissionConfirmDialog,
  PermissionModeSelector,
} from "./chat-window-parts";
import { ModelSelector } from "./model-selector";

interface ChatWindowProps {
  /** 切换侧边栏（移动端 hamburger 按钮） */
  onToggleSidebar?: () => void;
}

export function ChatWindow({ onToggleSidebar }: ChatWindowProps) {
  const {
    sendMessage,
    cancelGeneration,
    resendMessage,
    respondDelegation,
    respondPermission,
  } = useChatSocket();
  const sessionId = useChatStore((s) => s.sessionId);
  const messagesLength = useChatStore((s) => s.messages.length);
  const removeMessage = useChatStore((s) => s.removeMessage);
  const removeMessagesAfter = useChatStore((s) => s.removeMessagesAfter);
  /** 待处理的委派请求（非 null 时弹出委派对话框） */
  const pendingDelegation = useChatStore((s) => s.pendingDelegation);
  /** 待处理的权限确认请求（非 null 时弹予权限对话框） */
  const pendingPermission = useChatStore((s) => s.pendingPermission);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [droppedAttachments, setDroppedAttachments] = useState<Attachment[]>([]);
  /** 已加载历史的 sessionId（避免重复拉取） */
  const loadedSessionRef = useRef<string | null>(null);
  /** 文件拖放上传的 AbortController，卸载时中止所有进行中的上传 */
  const uploadAbortRef = useRef<AbortController | null>(null);
  const t = useT();

  // 是否已配置至少一个可用的 provider/model channel
  // 复用 apiGet 统一错误处理，与 use-model-config.ts 同一接口
  const channelsQuery = useQuery({
    queryKey: ["providers", "channels"],
    queryFn: () =>
      apiGet<{ channels?: Array<{ configured?: boolean; modelCount?: number }> }>("/api/providers/channels").catch(() => ({ channels: [] })),
    staleTime: 30_000,
  });
  const isModelConfigured = !!channelsQuery.data?.channels?.some(
    (ch) => ch.configured || (ch.modelCount ?? 0) > 0,
  );

  /**
   * 输入框可用条件（H4 修复）：
   * - 不在流式中（避免重入）
   * - 模型已配置（否则根本发不出去）
   * 不再硬绑 connectionStatus：断线时输入框仍可输入，send 走 ws-store.sendQueue 暂存
   */
  const canSend = !isStreaming && isModelConfigured;

  /**
   * 统一的历史恢复入口。
   *
   * 合并了原先的 loadHistory（chat-window 独立 effect）和 sharedSessionRestore
   * （use-chat-socket 的 status effect）两条路径，消除了两条路径并发触发时的竞态。
   *
   * 触发条件：sessionId 变化且当前无消息。
   * sharedSessionRestore 内部有 restoringSessionId 锁，即使 use-chat-socket 的
   * status effect 也同时触发，也不会重复拉取。
   */
  const loadHistory = useCallback(async () => {
    if (!sessionId || loadedSessionRef.current === sessionId) return;
    if (useChatStore.getState().messages.length > 0) {
      loadedSessionRef.current = sessionId;
      return;
    }
    setHistoryError(null);
    setLoadingHistory(true);
    try {
      const msgs = await useChatStore
        .getState()
        .sharedSessionRestore(sessionId);
      loadedSessionRef.current = sessionId;
      // sharedSessionRestore 在 sessionId 已切换时返回旧消息，忽略
      if (useChatStore.getState().sessionId !== sessionId) return;
      // 没有消息也是正常情况（新对话）
      if (!msgs?.length) return;
    } catch (err) {
      setHistoryError(
        err instanceof Error ? err.message : t("chat.unknownError"),
      );
    } finally {
      setLoadingHistory(false);
    }
  }, [sessionId, t]);

  useEffect(() => {
    if (!sessionId || messagesLength > 0) return;
    loadHistory();
  }, [sessionId, messagesLength, loadHistory]);

  // If no session after mount, restore the most recent conversation
  // 跳过条件：用户刚删除对话（skipAutoRestore=true）时不要自动拉回
  useEffect(() => {
    if (sessionId || messagesLength > 0) return;
    if (useChatStore.getState().skipAutoRestore) return;
    apiGet<Array<{ sessionId: string }>>("/api/conversations?limit=1")
      .then((list) => {
        if (list?.length && !useChatStore.getState().sessionId) {
          useChatStore.getState().setSessionId(list[0].sessionId);
        }
      })
      .catch((err) => {
        if (import.meta.env.DEV)
          console.warn("[chat] auto-restore failed:", err);
      });
  }, [sessionId, messagesLength]);

  /** 重试失败消息：移除错误助手消息 + 原始用户消息后重发 */
  const handleRetry = useCallback(
    (errorMsgId: string) => {
      const msgs = useChatStore.getState().messages;
      const errorIdx = msgs.findIndex((m) => m.id === errorMsgId);
      if (errorIdx < 0) return;
      const userMsg = msgs[errorIdx - 1];
      if (userMsg?.role === "user") {
        removeMessage(userMsg.id);
      }
      removeMessage(errorMsgId);
      resendMessage(userMsg?.content ?? "");
    },
    [removeMessage, resendMessage],
  );

  /** 编辑用户消息：移除该消息及之后的所有消息，然后重新发送 */
  const handleEdit = useCallback(
    (messageId: string, content: string) => {
      removeMessagesAfter(messageId);
      removeMessage(messageId);
      sendMessage(content);
    },
    [removeMessagesAfter, removeMessage, sendMessage],
  );

  /** 发送消息 + 清空拖入的附件 */
  const handleSend = useCallback(
    (text: string, attachments?: Attachment[]) => {
      sendMessage(text, attachments);
      setDroppedAttachments([]);
    },
    [sendMessage],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = e.dataTransfer.files;
      if (!files?.length) return;
      // 每次拖放创建新的 AbortController，旧的自动失效
      const controller = new AbortController();
      uploadAbortRef.current = controller;
      const newAttachments: Attachment[] = [];
      for (const file of Array.from(files)) {
        // 检查是否已被中止（如组件卸载）
        if (controller.signal.aborted) break;
        try {
          const result = await uploadFile(file, controller.signal);
          newAttachments.push({
            fileId: result.fileId,
            filename: result.filename,
            mimeType: result.mimeType,
            size: result.size,
            url: result.url,
          });
        } catch (err) {
          // 中止导致的中断不算错误，不提示
          if (controller.signal.aborted) break;
          const msg =
            err instanceof Error ? err.message : t("chat.fileUploadFailed");
          toast.error(msg);
        }
      }
      if (newAttachments.length > 0) {
        setDroppedAttachments((prev) => [...prev, ...newAttachments]);
      }
    },
    [t],
  );

  /** 渲染消息区域（加载 / 错误 / 正常列表三种状态） */
  const renderContent = () => {
    if (loadingHistory) return <ChatSkeleton />;
    if (historyError)
      return <HistoryError error={historyError} onRetry={loadHistory} />;
    return <ChatMessageList onRetry={handleRetry} onEdit={handleEdit} />;
  };

  return (
    <div
      className="relative grid h-full grid-rows-[auto_1fr_auto] overflow-x-hidden"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <DragOverlay visible={dragOver} />
      {/* 顶部栏：侧边栏切换 + 会话标题 + 权限/模型选择器 */}
      <div className="flex min-w-0 items-center justify-between overflow-hidden border-b px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          {onToggleSidebar && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("chat.toggleSidebar")}
              className="shrink-0 md:hidden"
              onClick={onToggleSidebar}
            >
              <PanelLeft className="size-4" />
            </Button>
          )}
          <h3 className="truncate text-sm font-medium text-foreground">
            {sessionId
              ? `${t("chat.session")}: ${sessionId.slice(0, 12)}...`
              : t("chat.newConversation")}
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PermissionModeSelector />
          <ModelSelector />
        </div>
      </div>
      {renderContent()}
      {/* 委派请求弹窗 */}
      {pendingDelegation && (
        <DelegationDialog
          request={pendingDelegation}
          onRespond={respondDelegation}
        />
      )}
      {/* 权限确认弹窗 */}
      {pendingPermission && (
        <PermissionConfirmDialog
          request={pendingPermission}
          onRespond={respondPermission}
        />
      )}
      <ChatInput
        onSend={(text, attachments) => {
          handleSend(text, attachments);
          setDroppedAttachments([]);
        }}
        onCancel={cancelGeneration}
        externalAttachments={droppedAttachments}
        disabled={!canSend}
      />
    </div>
  );
}

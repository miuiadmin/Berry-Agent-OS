/**
 * 聊天主窗口（编排层）。
 *
 * 职责：
 *   - 历史恢复（sessionId 变化时拉取；无 session 时恢复最近对话）
 *   - 发送 / 重试 / 编辑消息
 *   - 文件拖拽上传（委派给 useFileDrop hook）
 *   - 渲染消息列表 + 输入框 + 弹窗（委派 / 权限确认）
 *
 * 渲染子组件定义在 chat-window-parts.tsx；本文件只保留编排逻辑。
 */

import { useCallback, useEffect, useState, useRef } from "react";
import { useChatSocket } from "@/hooks/use-chat-socket";
import { useChatStore } from "@/lib/stores/chat-store";
import { ChatMessageList } from "@/components/chat/chat-message-list";
import { ChatInput } from "@/components/chat/chat-input";
import { DragOverlay, type Attachment } from "@/components/chat/file-upload";
import { Button } from "@/components/ui/button";
import { PanelLeft } from "lucide-react";
import { apiGet } from "@/lib/api";
import { textFromBlocks } from "@/lib/blocks";
import { useT } from "@/lib/i18n";
import {
  ChatSkeleton,
  HistoryError,
  DelegationDialog,
  PermissionConfirmDialog,
  PermissionModeSelector,
} from "./chat-window-parts";
import { ModelSelector } from "./model-selector";
import { useModelConfig } from "./use-model-config";
import { useFileDrop } from "@/hooks/use-file-drop";

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
  const pendingDelegation = useChatStore((s) => s.pendingDelegation);
  const pendingPermission = useChatStore((s) => s.pendingPermission);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const t = useT();
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  /** 已加载历史的 sessionId（避免 sessionId 抖动时重复拉取） */
  const loadedSessionRef = useRef<string | null>(null);

  // ── 文件拖拽上传（独立 hook，降低主组件复杂度） ──
  const fileDrop = useFileDrop();

  // ── 模型配置：是否已配置至少一个"启用且含模型"的渠道 ──
  // 复用 useModelConfig（model-selector 也在用），消除原先重复的
  // ["providers","channels"] 查询；isModelConfigured 由 hook 统一派生。
  const { isModelConfigured } = useModelConfig();

  /**
   * 输入框可用条件：
   * - 不在流式中（避免重入）
   * - 模型已配置（否则根本发不出去）
   * 断线时输入框仍可输入，send 走 ws-store.sendQueue 暂存
   */
  const canSend = !isStreaming && isModelConfigured;

  // ── 历史恢复 ──

  /**
   * 统一的历史恢复入口（合并原先的 loadHistory 与 sharedSessionRestore 两条路径，
   * 消除并发触发竞态）。
   *
   * 三种早退条件：
   *   1) 无 sessionId
   *   2) 已加载过该 sessionId（loadedSessionRef 防重）
   *   3) store 里已有消息（说明已由别处恢复，标记 loaded 后跳过）
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
      const msgs = await useChatStore.getState().sharedSessionRestore(sessionId);
      loadedSessionRef.current = sessionId;
      /** sharedSessionRestore 在 sessionId 已切换时返回旧消息，忽略 */
      if (useChatStore.getState().sessionId !== sessionId) return;
      /** 没有消息也是正常情况（新对话） */
      if (!msgs?.length) return;
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : t("chat.unknownError"));
    } finally {
      setLoadingHistory(false);
    }
  }, [sessionId, t]);

  /** sessionId 变化且当前无消息时触发历史恢复 */
  useEffect(() => {
    if (!sessionId || messagesLength > 0) return;
    loadHistory();
  }, [sessionId, messagesLength, loadHistory]);

  /** 无 session 时自动恢复最近对话（用户删除对话后跳过） */
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
        if (import.meta.env.DEV) console.warn("[chat] auto-restore failed:", err);
      });
  }, [sessionId, messagesLength]);

  // ── 消息操作 ──

  /** 重试失败消息：移除错误助手消息 + 原始用户消息后重发 */
  const handleRetry = useCallback(
    (errorMsgId: string) => {
      const msgs = useChatStore.getState().messages;
      const errorIdx = msgs.findIndex((m) => m.id === errorMsgId);
      if (errorIdx < 0) return;
      // 边界：错误消息是首条（errorIdx===0）→ 前面没有 user 消息可重发，直接删除错误占位消息后返回，
      // 否则下方会用空字符串重发，产生一条空的 user 消息
      if (errorIdx === 0) {
        removeMessage(errorMsgId);
        return;
      }
      const userMsg = msgs[errorIdx - 1];
      if (userMsg?.role === "user") {
        removeMessage(userMsg.id);
        removeMessage(errorMsgId);
        // doc-22 单一事实源：用户正文可能只在 TextBlock 里（content 为兜底/旧值），
        // 优先用 textFromBlocks 投影，回退 content
        resendMessage(textFromBlocks(userMsg.blocks, userMsg.content ?? ""));
      } else {
        // 紧邻的前一条不是 user（如连续两条错误消息）→ 仅删错误占位
        removeMessage(errorMsgId);
      }
    },
    [removeMessage, resendMessage],
  );

  /** 编辑用户消息：移除该消息及之后的所有消息，然后重新发送 */
  const handleEdit = useCallback(
    (messageId: string, content: string) => {
      // content 来自 EditableMessage 的 textFromBlocks 预填值（见 message-bubble-parts），
      // 已是用户正文投影，无需在此再投影。
      //
      // 两次 store.set（removeMessagesAfter 删后继 + removeMessage 删自身）：
      // zustand set 同步触发订阅者，理论上两次 set 之间存在「消息还在但后继已没」的瞬态。
      // 但 React 18 自动批处理把两次 set 合并成一次渲染，UI 订阅者看不到瞬态；
      // 且无生产订阅者依赖该中间态。若未来 store 暴露 removeMessagesAfter(id, { inclusive })，
      // 可合并为单次 set 消除瞬态（当前 store 无此签名，保持两次调用）。
      removeMessagesAfter(messageId);
      removeMessage(messageId);
      sendMessage(content);
    },
    [removeMessagesAfter, removeMessage, sendMessage],
  );

  /** 发送消息并清空拖拽附件 */
  const handleSend = useCallback(
    (text: string, attachments?: Attachment[]) => {
      sendMessage(text, attachments);
      fileDrop.clearAttachments();
    },
    [sendMessage, fileDrop],
  );

  return (
    <div
      className="relative grid h-full grid-rows-[auto_1fr_auto] overflow-x-hidden"
      {...fileDrop.handlers}
    >
      <DragOverlay visible={fileDrop.dragOver} />

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
              ? `${t("chat.session")}: ${sessionId.length > 12 ? sessionId.slice(0, 12) + "…" : sessionId}`
              : t("chat.newConversation")}
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PermissionModeSelector />
          <ModelSelector />
        </div>
      </div>

      {/* 消息区域（加载 / 错误 / 正常列表三态） */}
      {loadingHistory && <ChatSkeleton />}
      {!loadingHistory && historyError && (
        <HistoryError error={historyError} onRetry={loadHistory} />
      )}
      {!loadingHistory && !historyError && (
        <ChatMessageList onRetry={handleRetry} onEdit={handleEdit} />
      )}

      {/*
        委派请求弹窗 + 权限确认弹窗。
        互斥渲染（权限优先）：两者类型上可同时为非 null，但若同时挂载两个 BottomSheet，
        一次 Escape 会触发两个 onDismiss（双否认）。权限弹窗是 destructive 色调、更紧急，
        故 pendingPermission 存在时优先展示，pendingDelegation 暂缓（权限解决后再出现）。
      */}
      {pendingDelegation && !pendingPermission && (
        <DelegationDialog request={pendingDelegation} onRespond={respondDelegation} />
      )}
      {pendingPermission && (
        <PermissionConfirmDialog request={pendingPermission} onRespond={respondPermission} />
      )}

      <ChatInput
        onSend={handleSend}
        onCancel={cancelGeneration}
        externalAttachments={fileDrop.attachments}
        disabled={!canSend}
      />
    </div>
  );
}

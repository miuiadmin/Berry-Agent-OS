
import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useChatStore, genMsgId,
  appendToLast, setLastStatus, setLastProgress, setLastError, appendReasoning, appendToolCall,
  type DelegationRequest, type PermissionConfirmRequest,
} from "@/lib/stores/chat-store";
import { useWsStore } from "@/lib/stores/ws-store";
import type { ServerMessage } from "@/lib/types/ws-messages";
import { useT } from "@/lib/i18n";

/** 流式响应超时时间（毫秒） */
const STREAMING_TIMEOUT_MS = 90_000;

// ─── 辅助函数 ─────────────────────────────────────────────────

/** 将 WS 委托消息转换为组件用的 DelegationRequest */
function toDelegationRequest(msg: Extract<ServerMessage, { type: "delegation.needed" }>): DelegationRequest {
  return {
    delegationId: msg.delegationId, sessionId: msg.sessionId,
    requestedBy: msg.requestedBy, title: msg.title,
    description: msg.description, urgency: msg.urgency, options: msg.options,
  };
}

/** 将 WS 权限确认消息转换为组件用的 PermissionConfirmRequest */
function toPermissionRequest(msg: Extract<ServerMessage, { type: "permission.confirm_needed" }>): PermissionConfirmRequest {
  return {
    requestId: msg.requestId, sessionId: msg.sessionId,
    agentName: msg.agentName, toolName: msg.toolName,
    toolInput: msg.toolInput, dangerLevel: msg.dangerLevel, brainReason: msg.brainReason,
  };
}

// ─── Hook ─────────────────────────────────────────────────────

/**
 * 对话消息处理 hook。
 *
 * 注意：此 hook 不再管理 WebSocket 连接生命周期（connect/disconnect）。
 * 连接由全局 DashboardLayout 统一管理，App 加载即连接。
 * 此 hook 只负责：
 * 1. 监听 WS 消息并派发到 chat store（文本流、推理、工具调用等）
 * 2. 连接成功后恢复会话状态
 * 3. 提供 send/cancel/respond 等消息操作方法
 */
export function useChatSocket() {
  const { sessionId, addMessage, setStreaming, setPendingDelegation, setPendingPermission } = useChatStore();
  const { send, onMessage, status } = useWsStore();
  const queryClient = useQueryClient();
  const t = useT();

  /** 流式响应超时定时器 */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>( null);
  /** 已恢复过会话的 sessionId（防止同一会话重复恢复，切换会话时自动重置） */
  const recoveredRef = useRef<string | null>(null);

  // ─── 定时器管理 ───────────────────────────────────────────────

  /** 重置超时定时器（每次收到数据后调用） */
  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setLastError(t("chat.responseTimeout"));
      setStreaming(false);
    }, STREAMING_TIMEOUT_MS);
  }, [t]);

  /** 清除超时定时器（响应完成/失败时调用） */
  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  // 卸载时清理定时器
  useEffect(() => () => { clearTimer(); }, [clearTimer]);

  // ─── 断连时暂停超时计时器，重连后按需恢复 ─────────────────────
  useEffect(() => {
    if (status === "disconnected" || status === "connecting") {
      // 断连/重连中：暂停超时计时器，防止误触发
      clearTimer();
    } else if (status === "connected") {
      // 重连成功后：如果仍在流式中，重新启动超时计时器
      if (useChatStore.getState().isStreaming) {
        resetTimer();
      }
    }
  }, [status, clearTimer, resetTimer]);

  // ─── 会话恢复（连接成功后拉取历史消息） ────────────────────────

  useEffect(() => {
    if (status !== "connected") return;
    const sid = useChatStore.getState().sessionId;
    // 按 sessionId 区分：同一会话只恢复一次，切换会话则重新恢复
    if (!sid || recoveredRef.current === sid) return;
    recoveredRef.current = sid;

    fetch(`/api/sessions/${sid}/state`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data || useChatStore.getState().sessionId !== sid) return;
        const activeTask = data.activeTasks?.[0];
        const messages = (data.messages ?? []).map((m: { role: string; content: string; createdAt: string; reasoning?: string; thinkingSteps?: Array<{ text: string; ts: number }> }) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
          timestamp: new Date(m.createdAt).getTime(),
          reasoning: m.reasoning,
          thinkingSteps: m.thinkingSteps,
        }));
        useChatStore.getState().restoreSession(
          messages,
          activeTask ? {
            progress: activeTask.progress,
            thinkingSteps: activeTask.thinkingSteps,
            streamingContent: activeTask.streamingContent,
            streamingReasoning: activeTask.streamingReasoning,
          } : undefined,
        );
        if (activeTask) resetTimer();
      })
      .catch(() => {});
  }, [status, resetTimer]);

  // ─── 消息分发（核心：将 WS 消息派发到 chat store） ────────────

  useEffect(() => {
    const unsub = onMessage((raw) => {
      const data = raw as Record<string, unknown>;

      // 事件类型消息（task.progress / task.failed 等）
      if (data.type === "event") {
        const event = data.event as string;
        if ((event === "task.failed" || event === "task.timeout") && useChatStore.getState().isStreaming) {
          const payload = data.payload as { error?: string } | undefined;
          setLastError(payload?.error ?? t("chat.taskFailed"));
          clearTimer();
        }
        if ((event === "task.progress" || event === "daemon.task.progress") && useChatStore.getState().isStreaming) {
          const payload = data.payload as { message?: string; from?: string } | undefined;
          if (payload?.message) {
            setLastProgress(payload.message);
            resetTimer();
          }
        }
        return;
      }

      // 重连恢复消息：服务端推送断连期间已积累的完整文本
      if (data.type === "reconnect_recovery") {
        const content = data.content as string;
        if (content) {
          const state = useChatStore.getState();
          const msgs = state.messages;
          // 找到最后一条 assistant 消息（可能不是数组末尾，中间可能有 user 消息）
          let lastAsstIdx = -1;
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "assistant") { lastAsstIdx = i; break; }
          }
          if (lastAsstIdx >= 0) {
            const lastAsst = msgs[lastAsstIdx];
            // 只在恢复内容比本地更长时才覆盖（更长 = 更新，因为内容只会追加）
            if (content.length > (lastAsst.content?.length ?? 0)) {
              useChatStore.getState().updateLastMessage(() => ({ content, status: "streaming" as const }));
            }
          } else {
            // 本地没有任何 assistant 消息：创建占位符
            addMessage({ id: genMsgId("asst"), role: "assistant", content, timestamp: Date.now(), status: "streaming" });
          }
          setStreaming(true);
          resetTimer();
        }
        return;
      }

      // 对话消息类型（text_delta / reasoning / tool_call / result 等）
      const msg = data as unknown as ServerMessage;

      // 防护：如果收到流式消息但还没有 assistant 占位消息，先创建一个
      if (msg.type === "text_delta" || msg.type === "reasoning_delta" || msg.type === "tool_call" || msg.type === "progress" || msg.type === "agent_handoff" || msg.type === "ask_user") {
        const state = useChatStore.getState();
        const last = state.messages[state.messages.length - 1];
        if (!last || last.role !== "assistant") {
          addMessage({ id: genMsgId("asst"), role: "assistant", content: "", timestamp: Date.now(), status: "streaming" });
          setStreaming(true);
        }
      }

      switch (msg.type) {
        case "text_delta":
          appendToLast(msg.text);
          resetTimer();
          break;
        case "reasoning_delta": {
          const rd = msg as Extract<ServerMessage, { type: "reasoning_delta" }>;
          appendReasoning(rd.text);
          resetTimer();
          break;
        }
        case "progress":
          if (msg.summary) setLastProgress(msg.summary);
          resetTimer();
          break;
        case "agent_handoff": {
          const hm = msg as unknown as { from: string; to: string; intent: string };
          setLastProgress(t("chat.delegatedTo", { agent: hm.to }));
          resetTimer();
          break;
        }
        case "ask_user": {
          const askMsg = msg as unknown as { question: string; options?: string[] };
          setLastProgress(`❓ ${askMsg.question}`);
          resetTimer();
          break;
        }
        case "tool_call": {
          const tc = msg as Extract<ServerMessage, { type: "tool_call" }>;
          appendToolCall({
            toolName: tc.toolName,
            input: tc.input,
            result: tc.result,
            isError: tc.isError,
            durationMs: tc.durationMs,
            ts: Date.now(),
          });
          resetTimer();
          break;
        }
        case "result": {
          const resultMsg = msg as Extract<ServerMessage, { type: "result" }>;
          const response = resultMsg.content;
          const current = useChatStore.getState().messages;
          const lastMsg = current[current.length - 1];
          if (lastMsg && lastMsg.role === "assistant") {
            // result 到达时，如果最后一条助手消息内容为空，用完整结果填充
            if (response && !lastMsg.content.trim()) {
              appendToLast(response);
            }
            setLastStatus("complete");
          } else if (response) {
            // 没有 assistant 占位消息（服务端直接返回 result，无 text_delta 前导）
            addMessage({ id: genMsgId("asst"), role: "assistant", content: response, timestamp: Date.now(), status: "complete" });
          }
          setStreaming(false);
          clearTimer();
          break;
        }
        case "error":
          setLastError(msg.error ?? msg.message ?? t("chat.unknownError"));
          clearTimer();
          break;
        case "cancelled":
        case "interrupted":
          setLastStatus("complete");
          setStreaming(false);
          clearTimer();
          break;
        case "delegation.needed":
          setPendingDelegation(toDelegationRequest(msg));
          break;
        case "permission.confirm_needed":
          setPendingPermission(toPermissionRequest(msg));
          break;
        default:
          if (import.meta.env.DEV) {
            console.debug("[ws] unhandled message type:", (msg as { type: string }).type, msg);
          }
      }
    });
    return unsub;
  }, [onMessage, setStreaming, setPendingDelegation, setPendingPermission, resetTimer, clearTimer]);

  // ─── 发送消息 ─────────────────────────────────────────────────

  /** 内部发送方法：新增助手占位消息 → 设置流式状态 → 通过 WS 发送 */
  const sendInternal = useCallback((text: string, attachments?: unknown[]) => {
    addMessage({ id: genMsgId("asst"), role: "assistant", content: "", timestamp: Date.now(), status: "streaming" });
    setStreaming(true);
    resetTimer();
    try {
      send({ type: "message", text, sessionId, attachments, permissionMode: useChatStore.getState().permissionMode });
    } catch {
      setLastError(t("chat.failedToSendMessage"));
      clearTimer();
    }
  }, [sessionId, addMessage, setStreaming, send, resetTimer, clearTimer]);

  /** 发送用户消息（附带模型配置检查） */
  const sendMessage = useCallback(
    async (text: string, attachments?: Array<{ fileId: string; filename: string; mimeType: string; url: string }>) => {
      // 快速模型配置检查：使用 React Query 缓存，避免每次都请求
      const cached = queryClient.getQueryData<{ channels?: Array<{ configured?: boolean; modelCount?: number }> }>(["providers", "channels"]);
      if (cached?.channels && !cached.channels.some((ch) => ch.configured || (ch.modelCount ?? 0) > 0)) {
        setLastError(t("chat.modelNotConfigured"));
        return;
      }

      addMessage({ id: genMsgId("user"), role: "user", content: text, timestamp: Date.now(), status: "complete", attachments });
      sendInternal(text, attachments);
    },
    [addMessage, sendInternal],
  );

  /** 重发消息（不新增用户消息，直接发送文本） */
  const resendMessage = useCallback((text: string) => { sendInternal(text); }, [sendInternal]);

  /** 取消当前生成 */
  const cancelGeneration = useCallback(() => {
    send({ type: "interrupt" });
    setLastStatus("complete");
    setStreaming(false);
    clearTimer();
  }, [send, setStreaming, clearTimer]);

  /** 响应委托请求 */
  const respondDelegation = useCallback(
    (delegationId: string, response: string | null, approved: boolean) => {
      send({ type: "delegation.respond", delegationId, response, status: approved ? "approved" : "denied" });
      setPendingDelegation(null);
    },
    [send, setPendingDelegation],
  );

  /** 响应权限确认请求 */
  const respondPermission = useCallback(
    (requestId: string, approved: boolean) => {
      send({ type: approved ? "permissions.approve" : "permissions.deny", requestId });
      setPendingPermission(null);
    },
    [send, setPendingPermission],
  );

  return { sendMessage, cancelGeneration, resendMessage, respondDelegation, respondPermission, connectionStatus: status };
}


import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useChatStore, genMsgId,
  appendToLast, setLastStatus, setLastProgress, setLastError, appendReasoning, appendToolCall, updateLastToolCallResult,
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
  const { sessionId, addMessage, setStreaming, setPendingDelegation, setPendingPermission, sharedSessionRestore, createStreamingPlaceholder, markLastMessageStatus } = useChatStore();
  const { send, confirmOutgoingMessage, onMessage, status } = useWsStore();
  const queryClient = useQueryClient();
  const t = useT();

  /** 流式响应超时定时器 */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>( null);
  /** 发送消息时记录的 sessionId，用于全局事件（task.failed/progress）的按对话过滤 */
  const streamingSessionRef = useRef<string | null>(null);
  /** 组件是否仍挂载的守卫，防止卸载后异步回调设置孤立定时器 */
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

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
    // 流式结束，清除 streaming session 标记
    streamingSessionRef.current = null;
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

  // ─── 共享会话恢复（H6 修复） ──────────────────────────────
  // 统一所有"从服务端拉历史 + 恢复活跃任务"的入口。
  // 不再使用 recoveredRef 短路：每次 status 变 connected 都重新触发（chat-store 内部 restoringSessionId 锁防止并发）。
  useEffect(() => {
    if (status !== "connected") return;
    const sid = useChatStore.getState().sessionId;
    if (!sid) return;
    // 直接调共享入口，store 内部加锁 + 原子写入
    sharedSessionRestore(sid).then((msgs) => {
      // 组件已卸载，不设置定时器
      if (!mountedRef.current) return;
      // 恢复完后，如果最后一条是 streaming 占位，需要重置超时计时器
      const last = msgs[msgs.length - 1];
      if (last?.status === "streaming") {
        streamingSessionRef.current = sid;
        resetTimer();
      }
    }).catch((err) => {
      if (import.meta.env.DEV) console.warn("[ws] sharedSessionRestore failed:", err);
    });
  }, [status, sessionId, sharedSessionRestore, resetTimer]);

  // ─── 消息分发（核心：将 WS 消息派发到 chat store） ────────────

  useEffect(() => {
    const unsub = onMessage((raw) => {
      const data = raw as Record<string, unknown>;

      // ── 按 sessionId 过滤：只处理当前对话的消息 ──
      // 后端流式事件（text_delta / progress / tool_call / reconnect_recovery 等）都携带 sessionId。
      // 如果消息的 sessionId 与当前活跃对话不匹配，直接丢弃，防止跨对话内容污染。
      if (data.sessionId && data.sessionId !== useChatStore.getState().sessionId) {
        return;
      }

      // 事件类型消息（task.progress / task.failed 等）
      // 全局事件（ws-event-bridge 广播）不带顶层 sessionId，但 payload 里可能有。
      // 用 streamingSessionRef 确保只处理当前对话发起的流式任务的事件。
      if (data.type === "event") {
        const event = data.event as string;
        const payload = data.payload as Record<string, unknown> | undefined;
        // 全局事件的 payload 可能有 sessionId，如果有则按对话过滤
        if (payload?.sessionId && payload.sessionId !== useChatStore.getState().sessionId) {
          return;
        }
        // task.failed/timeout：只有当前对话发起的 streaming 才处理
        if ((event === "task.failed" || event === "task.timeout") && useChatStore.getState().isStreaming) {
          if (streamingSessionRef.current && streamingSessionRef.current !== useChatStore.getState().sessionId) {
            return; // 不是当前对话的任务，跳过
          }
          setLastError((payload as { error?: string })?.error ?? t("chat.taskFailed"));
          clearTimer();
        }
        if ((event === "task.progress" || event === "daemon.task.progress") && useChatStore.getState().isStreaming) {
          if (streamingSessionRef.current && streamingSessionRef.current !== useChatStore.getState().sessionId) {
            return;
          }
          if ((payload as { message?: string })?.message) {
            setLastProgress((payload as { message?: string }).message!);
            resetTimer();
          }
        }
      return;
      }

      // 对话消息类型（text_delta / reasoning / tool_call / result 等）
      const msg = data as unknown as ServerMessage;

      // H6 修复：占位创建统一走 createStreamingPlaceholder
      // 收到第一个流式事件时，如果当前还没有 streaming 占位（pendingStreamMessageId 为空且末尾非 streaming assistant），创建之
      if (msg.type === "text_delta" || msg.type === "reasoning_delta" || msg.type === "tool_call" || msg.type === "progress" || msg.type === "agent_handoff" || msg.type === "ask_user" || msg.type === "dialogue_status") {
        const state = useChatStore.getState();
        // 只有在没有 pending 占位时才会真创建（store 内部幂等）
        const placeholderId = createStreamingPlaceholder();
        if (placeholderId) {
          setStreaming(true);
          // 记下 streaming sessionId
          if (!streamingSessionRef.current) {
            streamingSessionRef.current = state.sessionId;
          }
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
        case "agent_handoff":
          setLastProgress(t("chat.delegatedTo", { agent: msg.to }));
          resetTimer();
          break;
        case "ask_user":
          setLastProgress(`❓ ${msg.question}`);
          resetTimer();
          break;
        case "dialogue_status": {
          // 11.0 对话协议：展示 Agent 间协作状态
          if (msg.status === "started") {
            setLastProgress(t("chat.dialogueStarted", { agent: msg.to }));
          } else if (msg.status === "round_complete") {
            const suffix = msg.summary ? ` — ${msg.summary}` : "";
            setLastProgress(t("chat.dialogueRoundComplete", { round: msg.round, summary: suffix }));
          } else if (msg.status === "ended") {
            setLastProgress(t("chat.dialogueEnded"));
          }
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
        case "tool_result": {
          // 流式契约补全：tool_call 之后到达的独立 tool_result（结果稍后才到）
          const tr = msg as Extract<ServerMessage, { type: "tool_result" }>;
          // 把 tool_result 追加到对应的 tool_call 卡片（按 toolName 匹配最新未填 result 的卡片）
          updateLastToolCallResult(tr.toolName, {
            isError: tr.isError ?? false,
            durationMs: tr.durationMs,
          });
          resetTimer();
          break;
        }
        case "uncertainty": {
          // 模型自报 confidence 低：展示提示但不打断流
          const u = msg as Extract<ServerMessage, { type: "uncertainty" }>;
          setLastProgress(`⚠️ ${u.reason}`);
          resetTimer();
          break;
        }
        case "no_response": {
          // P1-4: Brain 路由失败 / Runtime 异常 — 找到当前 streaming 的 user 消息标 failed
          const nr = msg as Extract<ServerMessage, { type: "no_response" }>;
          const current = useChatStore.getState().messages;
          // 找最后一条 sending 的 user 消息
          for (let i = current.length - 1; i >= 0; i--) {
            const m = current[i];
            if (m.role === "user" && m.status === "sending") {
              useChatStore.setState((s) => {
                const msgs = [...s.messages];
                msgs[i] = { ...msgs[i], status: "failed" };
                return { messages: msgs };
              });
              setLastError(`对话未收到回复: ${nr.reason}`);
              break;
            }
          }
          setStreaming(false);
          clearTimer();
          break;
        }
        case "result": {
          const resultMsg = msg as Extract<ServerMessage, { type: "result" }>;
          // 后端 SocketResultEvent 用 response 字段，兼容旧版 content 字段
          const response = resultMsg.response ?? resultMsg.content;
          const current = useChatStore.getState().messages;
          const lastMsg = current[current.length - 1];
          if (lastMsg && lastMsg.role === "assistant") {
            // 用 result 的权威完整响应替换流式部分内容，确保与服务端一致
            if (response) {
              useChatStore.getState().updateLastMessage(() => ({ content: response }));
            }
            setLastStatus("complete");
            // H5 修复：result 到达 = user 消息已被服务端接收，把 user 消息从 'sending' 升级为 'complete'
            // 用客户端 messageStore.setState 直接定位到上一条 user 消息
            const userIdx = current.length - 2;
            if (userIdx >= 0 && current[userIdx].role === "user" && current[userIdx].status === "sending") {
              const userMsgId = current[userIdx].id;
              useChatStore.setState((s) => {
                const msgs = [...s.messages];
                msgs[userIdx] = { ...msgs[userIdx], status: "complete" };
                return { messages: msgs };
              });
              // 同步从 outbox 移除（如果该 user 消息是经 outbox 暂存的）
              if (userMsgId) confirmOutgoingMessage(userMsgId);
            }
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
  }, [onMessage, setStreaming, setPendingDelegation, setPendingPermission, resetTimer, clearTimer, createStreamingPlaceholder, addMessage, t]);

  // ─── 发送消息 ─────────────────────────────────────────────────

  /**
   * 内部发送方法（H5 重写）：
   * 1. 立即把 user 消息 addMessage({role:'user', content, status:'sending', clientMsgId}) —— 用户先看到自己的消息
   * 2. 调 send({type:'message', text, sessionId, attachments, clientMsgId, permissionMode})；WS 断开时自动入 outbox
   * 3. 如果 send 抛错（同步异常）：把刚 addMessage 的 user 消息 status 改为 'failed'，不吞占位
   * 4. 占位 assistant 消息不再在此创建，改为 onMessage 收到 text_delta 时由 createStreamingPlaceholder 统一创建
   */
  const sendInternal = useCallback((
    text: string,
    attachments?: unknown[],
    options?: { clientMsgId?: string },
  ) => {
    const clientMsgId = options?.clientMsgId ?? genMsgId("user");
    // 1) 先 addMessage user 消息（status='sending' 表示还未被服务端确认）
    addMessage({
      id: clientMsgId,
      role: "user",
      content: text,
      timestamp: Date.now(),
      status: "sending",
      attachments: attachments as never,
    });
    // 记录发起流式时的 sessionId，用于后续全局事件过滤
    streamingSessionRef.current = sessionId;
    try {
      // 2) 调 send；WS 断开时由 ws-store.send 自动入 outbox
      send({
        type: "message",
        text,
        sessionId,
        attachments,
        clientMsgId,
        permissionMode: useChatStore.getState().permissionMode,
      });
      // 发送动作本身没抛错就启动超时计时器（即便 WS 暂未连接）
      resetTimer();
    } catch (err) {
      // 3) send 同步抛错：把刚 addMessage 的 user 消息标记为 failed（不 setLastError 吞占位）
      // markLastMessageStatus 作用于 messages 最后一条——此时正好是 user 消息
      markLastMessageStatus("failed");
      // 仅在严重异常时给个 toast 提示，同步 error 一般是参数错误，console 已足够
      if (import.meta.env.DEV) {
        console.warn("[ws] send failed synchronously:", err);
      }
      clearTimer();
    }
  }, [sessionId, addMessage, send, resetTimer, clearTimer, markLastMessageStatus]);

  /** 发送用户消息（附带模型配置检查 + clientMsgId 去重） */
  const sendMessage = useCallback(
    async (text: string, attachments?: Array<{ fileId: string; filename: string; mimeType: string; url: string }>) => {
      // 快速模型配置检查：使用 React Query 缓存，避免每次都请求
      const cached = queryClient.getQueryData<{ channels?: Array<{ configured?: boolean; modelCount?: number }> }>(["providers", "channels"]);
      if (cached?.channels && !cached.channels.some((ch) => ch.configured || (ch.modelCount ?? 0) > 0)) {
        setLastError(t("chat.modelNotConfigured"));
        return;
      }

      // 生成稳定的 clientMsgId（用于 outbox 去重 + 重发关联）
      const clientMsgId = genMsgId("user");
      sendInternal(text, attachments, { clientMsgId });
      // 注意：这里不再 addMessage user 消息——由 sendInternal 统一处理（addMessage(status='sending', clientMsgId)）
    },
    [sendInternal],
  );

  /** 重发消息（不新增用户消息，直接发送文本，复用上一条 user 消息的 id 作 clientMsgId） */
  const resendMessage = useCallback((text: string) => {
    const clientMsgId = genMsgId("user");
    sendInternal(text, undefined, { clientMsgId });
  }, [sendInternal]);

  /** 取消当前生成 */
  const cancelGeneration = useCallback(() => {
    send({ type: "interrupt", sessionId });
    setLastStatus("complete");
    setStreaming(false);
    clearTimer();
  }, [send, sessionId, setStreaming, clearTimer]);

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

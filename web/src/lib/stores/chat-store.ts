import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export interface ChatAttachment {
  fileId: string;
  filename: string;
  mimeType: string;
  url: string;
}

export interface ThinkingStep {
  text: string;
  ts: number;
}

export interface ToolCallEvent {
  toolName: string;
  input: string;
  result: string;
  isError: boolean;
  durationMs: number;
  ts: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /**
   * 消息状态：
   * - 'sending'：user 消息已 addMessage 但服务端还没确认（H5 新增）
   * - 'streaming'：assistant 消息正在接收流式内容
   * - 'complete'：消息已完成
   * - 'error'：消息出错
   * - 'failed'：user 消息发送失败（send 同步抛错时设置，H5 新增）
   */
  status?: "sending" | "streaming" | "complete" | "error" | "failed";
  progress?: string;
  thinkingSteps?: ThinkingStep[];
  toolCalls?: ToolCallEvent[];
  reasoning?: string;
  error?: string;
  attachments?: ChatAttachment[];
}

export interface DelegationRequest {
  delegationId: string;
  sessionId: string;
  requestedBy: string;
  title: string;
  description: string;
  urgency: string;
  options: string[];
}

export interface PermissionConfirmRequest {
  requestId: string;
  sessionId: string;
  agentName: string;
  toolName: string;
  toolInput: string;
  dangerLevel: string;
  brainReason: string;
}

// --- Shared ID generator (HTTP-safe, works without crypto.randomUUID) ---

export function genMsgId(prefix: string): string {
  try { return `${prefix}-${crypto.randomUUID().slice(0, 8)}`; }
  catch { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
}

// --- Store ---

interface ChatState {
  sessionId: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  /** 当前正在流入的 assistant 消息 ID（流式占位，不一定已 push 到 messages 末尾）。
   *  使用独立字段而非总是 messages[length-1]，避免 onMessage 抢先插入 user 消息时位置错位。 */
  pendingStreamMessageId: string | null;
  pendingDelegation: DelegationRequest | null;
  pendingPermission: PermissionConfirmRequest | null;
  permissionMode: 'ask' | 'allow-all' | 'deny-all';
  /** 用户主动清空对话（删除/新建）后为 true，阻止自动恢复 effect 拉取最近对话 */
  skipAutoRestore: boolean;
  /** 该 sessionId 正在执行 sharedSessionRestore（防止 onMessage 与 effect 并发触发） */
  restoringSessionId: string | null;

  setSessionId: (id: string | null) => void;
  addMessage: (msg: ChatMessage) => void;
  updateLastMessage: (updater: (msg: ChatMessage) => Partial<ChatMessage>) => void;
  setStreaming: (v: boolean) => void;
  clearMessages: () => void;
  removeMessage: (id: string) => void;
  removeMessagesAfter: (id: string) => void;
  setPendingDelegation: (req: DelegationRequest | null) => void;
  setPendingPermission: (req: PermissionConfirmRequest | null) => void;
  setPermissionMode: (mode: 'ask' | 'allow-all' | 'deny-all') => void;
  /** 标记跳过自动恢复（删除对话后调用） */
  setSkipAutoRestore: (v: boolean) => void;
  restoreSession: (messages: ChatMessage[], activeTask?: { progress?: string | null; thinkingSteps?: ThinkingStep[]; streamingContent?: string | null; streamingReasoning?: string | null }) => void;
  /**
   * 原子性加载历史消息 + 恢复活跃任务。
   * 在一次 set 中完成所有消息添加和 streaming 占位符创建，
   * 避免 onMessage 在中间状态穿插创建重复占位符。
   */
  loadHistoryAndRestore: (
    historyMessages: Array<{ role: string; content: string; createdAt: string; reasoning?: string; thinkingSteps?: ThinkingStep[] }>,
    activeTask?: { progress?: string | null; thinkingSteps?: ThinkingStep[]; streamingContent?: string | null; streamingReasoning?: string | null } | undefined,
  ) => void;

  /**
   * 共享会话恢复（H6 修复）。
   * 统一所有"从服务端拉历史 + 恢复活跃任务"的入口：
   * 1. 内部加锁（restoringSessionId）防止 onMessage 与 effect 并发触发
   * 2. 原子性 set：一次写入 messages + activeTask + isStreaming
   * 3. 返回 messages 数组
   *
   * 调用方：chat-window 的 loadHistory effect、use-chat-socket 的 status/sessionId effect
   */
  sharedSessionRestore: (sessionId: string) => Promise<ChatMessage[]>;

  /**
   * 创建流式占位 assistant 消息。
   * 不会重复创建：如果当前 pendingStreamMessageId 已存在则直接返回其 ID。
   * 返回创建的（或已存在的）消息 ID。
   */
  createStreamingPlaceholder: () => string;

  /** 标记最后一条消息的发送状态（user 消息用 'sending' / 'failed' / 'complete'） */
  markLastMessageStatus: (status: "sending" | "failed" | "complete") => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      sessionId: null,
      messages: [],
      isStreaming: false,
      pendingStreamMessageId: null,
      pendingDelegation: null,
      pendingPermission: null,
      permissionMode: 'ask',
      skipAutoRestore: false,
      restoringSessionId: null,

      setSessionId: (id) => set((s) => {
        // 设定新会话时重置跳过标志（用户主动选择了对话，后续可以自动恢复）
        if (id) return { sessionId: id, skipAutoRestore: false };
        return { sessionId: id };
      }),

      addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),

      updateLastMessage: (updater) =>
        set((s) => {
          if (s.messages.length === 0) return s;
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          const patch = updater(last);
          msgs[msgs.length - 1] = { ...last, ...patch };
          const newState: Partial<ChatState> = { messages: msgs };
          if (patch.status === "error") newState.isStreaming = false;
          return newState;
        }),

      setStreaming: (v) => set({ isStreaming: v }),
      clearMessages: () => set({ messages: [], isStreaming: false, pendingStreamMessageId: null, pendingDelegation: null, pendingPermission: null }),

      removeMessage: (id) => set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),
      removeMessagesAfter: (id) =>
        set((s) => {
          const idx = s.messages.findIndex((m) => m.id === id);
          if (idx === -1) return s;
          return { messages: s.messages.slice(0, idx + 1) };
        }),

      setPendingDelegation: (req) => set({ pendingDelegation: req }),
      setPendingPermission: (req) => set({ pendingPermission: req }),
      setPermissionMode: (mode) => set({ permissionMode: mode }),
      /** 设置是否跳过自动恢复（删除对话后设为 true） */
      setSkipAutoRestore: (v) => set({ skipAutoRestore: v }),

      /**
       * 原子性加载历史消息 + 恢复活跃任务。
       * 在一次 zustand set 中完成：所有历史消息添加 + activeTask streaming 占位符创建。
       * 避免 loadHistory 和 onMessage 的竞态条件（onMessage 在 loadHistory 完成
       * 之前创建重复占位符）。
       */
      loadHistoryAndRestore: (historyMessages, activeTask) =>
        set((s) => {
          // 如果已有消息（recoveredRef effect 先跑了），跳过
          if (s.messages.length > 0) return s;

          const msgs: ChatMessage[] = historyMessages.map((m) => ({
            id: genMsgId("hist"),
            role: m.role as "user" | "assistant",
            content: m.content,
            timestamp: m.createdAt ? new Date(m.createdAt).getTime() : Date.now(),
            // 如果有 activeTask 且这是最后一条 assistant 消息，先不标记 complete
            // 让下面的 activeTask 逻辑决定 status
            status: "complete" as const,
            reasoning: m.reasoning,
            thinkingSteps: m.thinkingSteps,
          }));

          // 有活跃任务：在最后一条 assistant 消息后追加 streaming 占位符
          if (activeTask) {
            const streamingText = activeTask.streamingContent ?? "";
            const streamingReasoning = activeTask.streamingReasoning ?? undefined;
            // 如果最后一条历史消息是 assistant 且有 streamingContent，
            // 用 streamingContent 更新它并标记为 streaming
            const lastMsg = msgs[msgs.length - 1];
            if (lastMsg?.role === "assistant" && streamingText && streamingText.length > (lastMsg.content?.length ?? 0)) {
              msgs[msgs.length - 1] = {
                ...lastMsg,
                content: streamingText,
                reasoning: streamingReasoning && (!lastMsg.reasoning || streamingReasoning.length > lastMsg.reasoning.length)
                  ? streamingReasoning : lastMsg.reasoning,
                status: "streaming",
                progress: activeTask.progress ?? undefined,
                thinkingSteps: activeTask.thinkingSteps ?? lastMsg.thinkingSteps,
              };
            } else {
              // 历史消息不包含 streaming 内容，追加新占位符
              msgs.push({
                id: genMsgId("asst-recovering"),
                role: "assistant",
                content: streamingText,
                timestamp: Date.now(),
                status: "streaming",
                reasoning: streamingReasoning,
                progress: activeTask.progress ?? undefined,
                thinkingSteps: activeTask.thinkingSteps,
              });
            }
            return { messages: msgs, isStreaming: true };
          }

          return { messages: msgs };
        }),

      restoreSession: (messages, activeTask) =>
        set((s) => {
          const hasLocal = s.messages.length > 0;
          let msgs = hasLocal ? [...s.messages] : messages.map((m) => ({
            ...m, id: genMsgId("hist"), status: "complete" as const,
          }));

          // 无活跃任务：如果有本地状态则检查是否有空的流式占位符需要从服务端补全
          if (!activeTask) {
            if (hasLocal) {
              // 检查最后一条消息：如果是空的流式占位符（断连遗留），用服务端数据补全
              const last = msgs[msgs.length - 1];
              if (last?.role === "assistant" && (!last.content || last.status === "streaming")) {
                const serverLast = messages[messages.length - 1];
                if (serverLast?.role === "assistant" && serverLast.content) {
                  msgs = [...msgs];
                  msgs[msgs.length - 1] = { ...last, content: serverLast.content, status: "complete" };
                  return { messages: msgs, isStreaming: false };
                }
              }
              return s;
            }
            return { messages: msgs };
          }

          // 有活跃任务：更新或创建流式占位符
          // streamingContent 来自 SQLite（最多 2s 延迟），本地内容可能来自 reconnect_recovery（更新）
          const streamingText = activeTask.streamingContent ?? "";
          const streamingReasoning = activeTask.streamingReasoning ?? undefined;
          const last = msgs[msgs.length - 1];
          if (last?.role === "assistant" && last.status === "streaming") {
            // 取本地和服务端中更长的内容（更长 = 更新，因为内容只会追加）
            const restoredContent = (last.content && last.content.length >= streamingText.length)
              ? last.content
              : (streamingText || last.content);
            msgs[msgs.length - 1] = {
              ...last,
              content: restoredContent,
              reasoning: streamingReasoning && (!last.reasoning || streamingReasoning.length > last.reasoning.length)
                ? streamingReasoning : last.reasoning,
              progress: activeTask.progress ?? undefined,
              thinkingSteps: activeTask.thinkingSteps ?? last.thinkingSteps,
            };
          } else {
            // 服务端有活跃任务但本地无流式占位符：新建
            msgs = [...msgs, {
              id: genMsgId("asst-recovering"),
              role: "assistant" as const,
              content: streamingText,
              timestamp: Date.now(),
              status: "streaming" as const,
              reasoning: streamingReasoning,
              progress: activeTask.progress ?? undefined,
              thinkingSteps: activeTask.thinkingSteps,
            }];
          }
          return { messages: msgs, isStreaming: true };
        }),

      /**
       * 创建流式占位 assistant 消息（H6 修复）。
       * - 如果当前已有 pendingStreamMessageId（且对应消息在 messages 中），直接返回其 ID
       * - 否则追加一条空的 assistant streaming 消息，记录到 pendingStreamMessageId
       * - 返回该消息 ID
       *
       * 这是 onMessage 收到第一个流式事件时（text_delta / reasoning_delta / tool_call / progress / agent_handoff / ask_user / dialogue_status）调用的唯一入口。
       */
      createStreamingPlaceholder: () => {
        const state = get();
        // 已存在 pending 占位
        if (state.pendingStreamMessageId) {
          const exists = state.messages.some((m) => m.id === state.pendingStreamMessageId);
          if (exists) return state.pendingStreamMessageId;
        }
        // 最后一条已经是 assistant 且处于 streaming 状态：复用
        const last = state.messages[state.messages.length - 1];
        if (last && last.role === "assistant" && last.status === "streaming") {
          set({ pendingStreamMessageId: last.id });
          return last.id;
        }
        const id = genMsgId("asst");
        set((s) => ({
          messages: [...s.messages, { id, role: "assistant", content: "", timestamp: Date.now(), status: "streaming" }],
          pendingStreamMessageId: id,
          isStreaming: true,
        }));
        return id;
      },

      /**
       * 标记最后一条消息的状态（H5 修复）。
       * user 消息发送中 → 'sending'；send 失败 → 'failed'；发送成功（result 到达）→ 'complete'。
       */
      markLastMessageStatus: (status) =>
        set((s) => {
          if (s.messages.length === 0) return s;
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          const patch: Partial<ChatMessage> = { status };
          if (status === "failed") {
            patch.error = "send_failed";
            patch.progress = undefined;
          }
          msgs[msgs.length - 1] = { ...last, ...patch };
          return { messages: msgs };
        }),

      /**
       * 共享会话恢复（H6 修复）。
       *
       * 合并了原先 chat-window.loadHistory + use-chat-socket.onMessage status effect +
       * useEffect [sessionId, messages.length] 三套占位创建路径，作为唯一的恢复入口。
       *
       * 行为：
       * 1. 加锁 restoringSessionId：同一 session 并发时直接返回当前 messages
       * 2. 调 fetch /api/sessions/{sid}/state
       * 3. 原子性 set：messages + pendingStreamMessageId + isStreaming 一次写入
       * 4. 返回最终的 messages 数组
       *
       * 与 loadHistoryAndRestore 的区别：本函数自带 fetch + 锁，是完整闭环；
       * loadHistoryAndRestore 仍保留作为兼容包装（chat-window.loadHistory 在本地已经有部分消息时会用它做无锁合并）。
       */
      sharedSessionRestore: async (sessionId) => {
        if (!sessionId) return get().messages;
        // 加锁：避免同一 session 多个 effect 并发拉取
        if (get().restoringSessionId === sessionId) return get().messages;
        set({ restoringSessionId: sessionId });
        try {
          const res = await fetch(`/api/sessions/${sessionId}/state?limit=200`);
          if (!res.ok) return get().messages;
          const data = await res.json() as {
            messages?: Array<{ role: string; content: string; createdAt: string; reasoning?: string; thinkingSteps?: ThinkingStep[] }>;
            activeTasks?: Array<{ progress?: string; thinkingSteps?: ThinkingStep[]; streamingContent?: string; streamingReasoning?: string }>;
          };
          // 拉取过程中用户可能已经切换 session
          if (get().sessionId !== sessionId) return get().messages;

          const activeTask = data.activeTasks?.[0];
          const historyMsgs: ChatMessage[] = (data.messages ?? []).map((m) => ({
            id: genMsgId("hist"),
            role: m.role as "user" | "assistant",
            content: m.content,
            timestamp: m.createdAt ? new Date(m.createdAt).getTime() : Date.now(),
            status: "complete" as const,
            reasoning: m.reasoning,
            thinkingSteps: m.thinkingSteps,
          }));

          let pendingStreamId: string | null = null;
          if (activeTask) {
            const streamingText = activeTask.streamingContent ?? "";
            const streamingReasoning = activeTask.streamingReasoning ?? undefined;
            const last = historyMsgs[historyMsgs.length - 1];
            if (last?.role === "assistant" && streamingText && streamingText.length > (last.content?.length ?? 0)) {
              // 复用最后一条 assistant：升级为 streaming
              historyMsgs[historyMsgs.length - 1] = {
                ...last,
                content: streamingText,
                reasoning: streamingReasoning && (!last.reasoning || streamingReasoning.length > last.reasoning.length)
                  ? streamingReasoning : last.reasoning,
                status: "streaming",
                progress: activeTask.progress ?? undefined,
                thinkingSteps: activeTask.thinkingSteps ?? last.thinkingSteps,
              };
              pendingStreamId = last.id;
            } else {
              // 追加 streaming 占位
              const id = genMsgId("asst-recovering");
              historyMsgs.push({
                id,
                role: "assistant",
                content: streamingText,
                timestamp: Date.now(),
                status: "streaming",
                reasoning: streamingReasoning,
                progress: activeTask.progress ?? undefined,
                thinkingSteps: activeTask.thinkingSteps,
              });
              pendingStreamId = id;
            }
          }

          set({
            messages: historyMsgs,
            pendingStreamMessageId: pendingStreamId,
            isStreaming: !!activeTask,
          });
          return historyMsgs;
        } catch {
          return get().messages;
        } finally {
          // 只有 sessionId 仍然是当前会话才清锁（防止 race）
          if (get().restoringSessionId === sessionId) {
            set({ restoringSessionId: null });
          }
        }
      },
    }),
    {
      name: "chat-storage",
      storage: createJSONStorage(() => {
        try { return localStorage; } catch { return sessionStorage; }
      }),
      partialize: (state) => ({
        sessionId: state.sessionId,
        // 持久化时保留所有 user/assistant 消息（不过滤空 content 的 assistant 占位符），
        // 但将流式状态标记为 complete 以避免还原后误判为仍在流式中
        messages: state.messages.map((m) =>
          m.status === "streaming"
            ? { ...m, status: "complete" as const, progress: undefined }
            : m
        ),
        // 持久化 pendingStreamMessageId，让刷新后仍能识别流式占位（业务层会在 status===connected 时调 sharedSessionRestore 重新校验）
        pendingStreamMessageId: state.pendingStreamMessageId,
      }),
    },
  ),
);

// --- Convenience selectors (backward compat for callers using old API) ---

export function appendToLast(text: string) {
  useChatStore.getState().updateLastMessage((m) => ({ content: m.content + text }));
}
export function setLastStatus(status: ChatMessage["status"]) {
  useChatStore.getState().updateLastMessage(() => ({ status, progress: undefined }));
}
export function setLastProgress(progress: string) {
  useChatStore.getState().updateLastMessage((m) => {
    const steps = m.thinkingSteps ?? [];
    if (steps[steps.length - 1]?.text !== progress) {
      return { progress, thinkingSteps: [...steps, { text: progress, ts: Date.now() }] };
    }
    return { progress };
  });
}
export function setLastError(error: string) {
  useChatStore.getState().updateLastMessage(() => ({ status: "error" as const, error, progress: undefined }));
}
export function appendReasoning(text: string) {
  useChatStore.getState().updateLastMessage((m) => ({ reasoning: (m.reasoning ?? "") + text }));
}
export function appendToolCall(event: ToolCallEvent) {
  useChatStore.getState().updateLastMessage((m) => ({ toolCalls: [...(m.toolCalls ?? []), event] }));
}

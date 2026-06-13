/**
 * 聊天状态管理（Zustand + persist）。
 *
 * 管理对话会话的核心状态：消息列表 / 流式传输 / 委派请求 / 权限确认。
 * 持久化到 localStorage（防抖写入，流式期间最多 2s 写一次）。
 * 支持跨标签页 localStorage 同步（storage event 合并消息）。
 *
 * 关键机制：
 *   - sharedSessionRestore：统一的"拉历史 + 恢复活跃任务"入口（H6 修复）
 *   - createStreamingPlaceholder：流式占位符去重（防止 onMessage 重复创建）
 *   - pendingStreamMessageId：跟踪当前流式消息 ID（避免多消息交叉）
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { apiGet } from "@/lib/api";
import type { Block, StreamBlockPayload } from "@/lib/blocks";
import { applyBlockToBlocks } from "@/lib/blocks";
import { useWsStore } from "./ws-store";

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
  /**
   * 对话内联 block（设计文档/22）：tool / thinking / delegation 的内联模型。
   * 流式期间由 applyBlock（stream.block 事件）累积；历史/无 block 事件路径由渲染层 displayBlocks 投影兜底。
   * 与 toolCalls/reasoning 并存（兼容期双写）——渲染层优先用 blocks，缺项用旧字段补齐。
   */
  blocks?: Block[];
  /**
   * 13.0 灵魂版：Brain 审核裁决（modify/reject 时前端展示徽章）
   * - 'modify'：Brain 修改了初稿，显示 "Brain 已修改" 蓝色标签
   * - 'reject'：Brain 拦截了回复，显示 "Brain 已拦截" 琥珀色标签
   * - undefined / 'approve'：不显示任何标签
   */
  reviewVerdict?: "approve" | "modify" | "reject";
  /** Brain 审核理由 */
  reviewReason?: string;
  /** Brain 修改前的原始初稿（用于 diff 展示或一键还原） */
  originalDraft?: string;
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
  permissionMode: 'ask' | 'allow-all' | 'deny-all' | 'yolo';
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
  setPermissionMode: (mode: 'ask' | 'allow-all' | 'deny-all' | 'yolo') => void;
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

  /**
   * 应用一个 stream.block 事件到当前流式 assistant 消息（对话内联，设计文档/22）。
   * 目标消息：优先 pendingStreamMessageId，回退最后一条 streaming assistant。
   * 用 applyBlockToBlocks 纯 reducer 更新 blocks（text/thinking 追加 delta，tool/delegation upsert）。
   */
  applyBlock: (payload: StreamBlockPayload) => void;
}

/**
 * 持久化数据提取函数。
 * 截断为最近 50 条消息，将流式状态标记为 complete，截断工具调用结果。
 * 独立为函数以便防抖写入时复用。
 */
function truncateBlockForPersist(block: Block): Block {
  // 仅截断 tool block 的大 output/error（结构与 toolCalls.result 同性质）；其余 block 原样
  if (block.type !== 'tool') return block;
  const out = typeof block.output === 'string' ? block.output.slice(0, 500) : block.output;
  const err = block.error ? block.error.slice(0, 500) : block.error;
  return { ...block, output: out, error: err };
}

function partializeForPersist(state: ChatState) {
  return {
    sessionId: state.sessionId,
    messages: state.messages.slice(-50).map((m) => ({
      ...m,
      status: m.status === "streaming" ? "complete" as const : m.status,
      progress: m.status === "streaming" ? undefined : m.progress,
      toolCalls: m.toolCalls?.slice(-5).map(tc => ({ ...tc, result: tc.result?.slice(0, 500) })),
      // 对话内联 block：截断 tool output（与 toolCalls 同策略），避免 localStorage 溢出
      blocks: m.blocks?.slice(-8).map(b => truncateBlockForPersist(b)),
    })),
    pendingStreamMessageId: state.pendingStreamMessageId,
  };
}

/**
 * 流式结束后强制刷入 localStorage。
 * 由 setLastStatus/setLastError 在流结束时调用。
 * 确保最终的完整消息状态被持久化（而非中间的流式片段）。
 */
export function flushPersist() {
  try {
    const state = useChatStore.getState();
    const partial = partializeForPersist(state);
    localStorage.setItem("chat-storage", JSON.stringify(partial));
  } catch { /* 配额溢出或存储不可用，静默丢弃 */ }
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
        if (id) {
          // P2-11: 切换对话时发送 subscribe 消息给 WS，声明关注的新 sessionId
          // 服务端 WsEventBridge 按此过滤流式事件，减少多标签冗余传输
          // 直接从 useWsStore.getState() 取（动态 import 在同步 set 闭包中不可用）
          try {
            const wsSend = useWsStore.getState().send;
            wsSend({ type: 'subscribe', sessionId: id });
          } catch { /* ws-store 未初始化时忽略 */ }
          return { sessionId: id, skipAutoRestore: false };
        }
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
       * 应用 stream.block 事件到当前流式消息（对话内联，设计文档/22）。
       * 与 appendToLast/appendToolCall 同策略定位目标消息（pendingStreamMessageId 优先），
       * 用 applyBlockToBlocks 纯 reducer 不可变更新 blocks。
       */
      applyBlock: (payload) =>
        set((s) => {
          const msgs = s.messages;
          // 目标：当前流式占位（pendingStreamMessageId）；找不到则回退最后一条 streaming assistant
          let idx = s.pendingStreamMessageId ? msgs.findIndex((m) => m.id === s.pendingStreamMessageId) : -1;
          if (idx < 0) idx = msgs.findLastIndex((m) => m.role === "assistant" && m.status === "streaming");
          if (idx < 0) return s; // 无目标消息（占位尚未创建）——事件丢弃，下一条 delta 会重建
          const msg = msgs[idx];
          const copy = msgs.slice();
          copy[idx] = { ...msg, blocks: applyBlockToBlocks(msg.blocks, payload) };
          return { messages: copy };
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
          const data = await apiGet<{
            messages?: Array<{ role: string; content: string; createdAt: string; reasoning?: string; thinkingSteps?: ThinkingStep[]; blocks?: Block[] }>;
            activeTasks?: Array<{ progress?: string; thinkingSteps?: ThinkingStep[]; streamingContent?: string; streamingReasoning?: string }>;
          }>(`/api/sessions/${sessionId}/state?limit=200`);
          // 拉取过程中用户可能已经切换 session
          if (get().sessionId !== sessionId) return get().messages;

          const activeTask = data.activeTasks?.[0];
          const historyMsgs: ChatMessage[] = (data.messages ?? []).map((m) => {
            // 对话内联（doc 22）：thinking block 是持久化的推理真相源；/state 不单独返回 reasoning，
            // 从 message.blocks 的 thinking block 抽取文本回填 message.reasoning（InlineLeadBlocks 读此字段
            // 渲染思考）。刷新后思考过程可见；流式期 reasoning_delta 仍走 m.reasoning（此处 ?? 回退）。
            const blockReasoning = (m.blocks ?? [])
              .filter((b) => b.type === "thinking")
              .map((b) => (b as { text?: string }).text ?? "")
              .join("\n")
              .trim();
            // 对话内联（doc 22）：review block 是持久化的审核裁决真相源。后端 ReviewBlock（modify/reject）
            // 落 message_blocks，刷新后从此投影 reviewVerdict/reviewReason/originalDraft 回填消息——
            // BrainReviewBadge 读 message.reviewVerdict 渲染徽章 → 刷新后徽章保留。
            // approve 不落 review block（无徽章）；无 review block 时三字段 undefined（无徽章，正确）。
            const blockReview = (m.blocks ?? []).find(
              (b): b is Extract<Block, { type: "review" }> => b.type === "review",
            );
            return {
              id: genMsgId("hist"),
              role: m.role as "user" | "assistant",
              content: m.content,
              timestamp: m.createdAt ? new Date(m.createdAt).getTime() : Date.now(),
              status: "complete" as const,
              reasoning: m.reasoning ?? (blockReasoning || undefined),
              thinkingSteps: m.thinkingSteps,
              reviewVerdict: blockReview?.verdict,
              reviewReason: blockReview?.reason,
              originalDraft: blockReview?.originalDraft,
              // 对话内联（doc 22）：透传后端 getTimeline 返回的 blocks，刷新后 thinking/tool/delegation 卡片内联可见。
              blocks: m.blocks,
            };
          });

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

          // P2-7/P2-8 修复：在写入前与本地流式内容做 merge
          // 场景：WS 重连后 sharedSessionRestore 拉取服务端历史，同时 onMessage 已在接收 text_delta
          // 如果服务端 StreamingFlusher 刷新延迟（最多 2s），服务端内容可能比本地短
          // 全量覆盖会导致用户看到内容倒退（文本突然变短）或丢失 onMessage 已追加的流式增量
          const localMessages = get().messages;
          const localStreamingIdx = localMessages.findLastIndex(
            (m) => m.role === "assistant" && m.status === "streaming"
          );

          if (localStreamingIdx >= 0) {
            const localStreaming = localMessages[localStreamingIdx];
            const serverStreamingIdx = historyMsgs.findLastIndex(
              (m) => m.role === "assistant" && (m.status === "streaming" || m.status === "complete")
            );

            if (serverStreamingIdx >= 0) {
              const serverStreaming = historyMsgs[serverStreamingIdx];
              // P2-7: 取本地和服务端更长的内容（更长 = 更新，因为内容只会追加不会缩短）
              const localContent = localStreaming.content ?? "";
              const serverContent = serverStreaming.content ?? "";
              if (localContent.length > serverContent.length) {
                historyMsgs[serverStreamingIdx] = {
                  ...serverStreaming,
                  content: localContent,
                  status: "streaming",
                  // reasoning 同理取更长的
                  reasoning: localStreaming.reasoning && (!serverStreaming.reasoning || localStreaming.reasoning.length > serverStreaming.reasoning.length)
                    ? localStreaming.reasoning : serverStreaming.reasoning,
                };
                // 如果本地有 streaming 占位 ID，保留以便后续 text_delta 追加到正确位置
                if (!pendingStreamId) {
                  pendingStreamId = serverStreaming.id;
                }
              }
            } else if (localStreaming.content) {
              // P2-8: 本地有流式内容但服务端历史中没有对应消息（fetch 期间 text_delta 到达）
              // 保留本地的流式消息，追加到服务端历史末尾
              historyMsgs.push({ ...localStreaming });
              if (!pendingStreamId) {
                pendingStreamId = localStreaming.id;
              }
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
        try {
          const storage = localStorage;
          /**
           * 防抖写入：将 localStorage.setItem 延迟到空闲时执行。
           * 解决流式传输期间每个 text_delta 都触发同步 localStorage 写入
           * 导致主线程阻塞（手机端卡死）的问题。
           *
           * 策略：
           * - 流式中（isStreaming=true）：只记录 dirty 标记，不立即写入
           * - 流结束后或空闲时：一次性刷入最新状态
           * - 页面隐藏/卸载时：立即刷入
           */
          let writeTimer: ReturnType<typeof setTimeout> | null = null;
          const flushWrite = (key: string, value: string) => {
            writeTimer = null;
            try { storage.setItem(key, value); } catch { /* 配额溢出静默丢弃 */ }
          };
          // 页面隐藏/卸载时立即刷入脏数据
          if (typeof document !== 'undefined') {
            const flushIfNeeded = () => {
              if (writeTimer !== null) {
                clearTimeout(writeTimer);
                // 使用当前 store 状态重新序列化（避免写入过期数据）
                try {
                  const state = useChatStore.getState();
                  const partial = partializeForPersist(state);
                  storage.setItem("chat-storage", JSON.stringify(partial));
                } catch {}
                writeTimer = null;
              }
            };
            document.addEventListener('visibilitychange', () => {
              if (document.visibilityState === 'hidden') flushIfNeeded();
            });
            // beforeunload 兜底
            window.addEventListener('beforeunload', flushIfNeeded);
          }
          return {
            getItem: storage.getItem.bind(storage),
            setItem: (key: string, value: string) => {
              // 如果正在流式传输，延迟写入（每个 delta 不阻塞主线程）
              if (useChatStore.getState().isStreaming) {
                if (writeTimer) clearTimeout(writeTimer);
                // 流式期间最多 2 秒写一次（或流结束后 flushPersist 立即写入）
                writeTimer = setTimeout(() => flushWrite(key, value), 2000);
                return;
              }
              // 非流式：取消任何待处理的延迟写入，立即写入
              if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
              try { storage.setItem(key, value); } catch { /* 配额溢出静默丢弃 */ }
            },
            removeItem: storage.removeItem.bind(storage),
          };
        } catch { return { getItem: () => null, setItem: () => {}, removeItem: () => {} }; }
      }),
      /** 流式传输期间的 partialize，跳过写入（由防抖 setItem 控制） */
      partialize: (state) => partializeForPersist(state),
    },
  ),
);

// --- Convenience selectors (backward compat for callers using old API) ---

export function appendToLast(text: string) {
  useChatStore.getState().updateLastMessage((m) => ({ content: m.content + text }));
}
export function setLastStatus(status: ChatMessage["status"]) {
  useChatStore.getState().updateLastMessage(() => ({ status, progress: undefined }));
  // 流式结束时清除 pendingStreamMessageId，避免下次响应重用旧消息
  if (status === "complete" || status === "error") {
    useChatStore.setState({ pendingStreamMessageId: null });
    // 流结束后立即刷入 localStorage，确保完整消息被持久化
    flushPersist();
  }
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
  // 错误时清除 pendingStreamMessageId，避免下次响应重用旧消息
  useChatStore.setState({ pendingStreamMessageId: null });
  // 错误也是流结束，立即刷入 localStorage
  flushPersist();
}
export function appendReasoning(text: string) {
  useChatStore.getState().updateLastMessage((m) => ({ reasoning: (m.reasoning ?? "") + text }));
}
export function appendToolCall(event: ToolCallEvent) {
  useChatStore.getState().updateLastMessage((m) => ({ toolCalls: [...(m.toolCalls ?? []), event] }));
}

/**
 * 补全最近一条尚未填 result 的 toolCall 卡片（按 toolName 匹配）
 * 用于 tool_call 与 tool_result 分开发送的场景
 */
export function updateLastToolCallResult(toolName: string, patch: { isError?: boolean; durationMs?: number }) {
  useChatStore.getState().updateLastMessage((m) => {
    const calls = [...(m.toolCalls ?? [])];
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i].toolName === toolName) {
        calls[i] = { ...calls[i], ...patch };
        break;
      }
    }
    return { toolCalls: calls };
  });
}

// ─── 跨标签页 localStorage 同步 ────────────────────────────────
// 多标签页共享 "chat-storage" key，zustand persist 后写者覆盖前者。
// 通过 storage event 监听其他标签页的写入，将消息列表合并（按 id 去重取并集），
// 避免 Tab B 的写入丢失 Tab A 已有的消息。

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    // 只关心 chat-storage key 的变更
    if (e.key !== "chat-storage" || !e.newValue) return;

    try {
      const incoming = JSON.parse(e.newValue) as {
        state?: { messages?: ChatMessage[]; sessionId?: string | null };
      };
      if (!incoming.state?.messages) return;

      const localState = useChatStore.getState();
      const localMsgs = localState.messages;
      const remoteMsgs = incoming.state.messages;

      // 按 id 去重：取并集，相同 id 保留 content 更长的（streaming 内容更丰富）
      const mergedMap = new Map<string, ChatMessage>();
      for (const m of localMsgs) mergedMap.set(m.id, m);
      for (const m of remoteMsgs) {
        const existing = mergedMap.get(m.id);
        // 不存在则添加；已存在则保留内容更长的版本
        if (!existing || m.content.length > existing.content.length) {
          mergedMap.set(m.id, m);
        }
      }

      // 排序：按 timestamp 稳定排列
      const merged = [...mergedMap.values()].sort((a, b) => a.timestamp - b.timestamp);

      // 仅当合并结果与本地不同时才更新（避免无限循环）
      if (merged.length !== localMsgs.length) {
        useChatStore.setState({ messages: merged });
      }
    } catch {
      // 解析失败静默忽略，不影响本地状态
    }
  });
}

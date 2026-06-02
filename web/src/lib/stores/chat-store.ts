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
  status?: "streaming" | "complete" | "error";
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
  pendingDelegation: DelegationRequest | null;
  pendingPermission: PermissionConfirmRequest | null;
  permissionMode: 'ask' | 'allow-all' | 'deny-all';

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
  restoreSession: (messages: ChatMessage[], activeTask?: { progress?: string | null; thinkingSteps?: ThinkingStep[]; streamingContent?: string | null; streamingReasoning?: string | null }) => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      sessionId: null,
      messages: [],
      isStreaming: false,
      pendingDelegation: null,
      pendingPermission: null,
      permissionMode: 'ask',

      setSessionId: (id) => set({ sessionId: id }),

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
      clearMessages: () => set({ messages: [], isStreaming: false, pendingDelegation: null, pendingPermission: null }),

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

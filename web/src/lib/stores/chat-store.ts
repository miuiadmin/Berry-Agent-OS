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

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  status?: "streaming" | "complete" | "error";
  progress?: string;
  thinkingSteps?: ThinkingStep[];
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
  currentTaskId: string | null;
  pendingDelegation: DelegationRequest | null;
  pendingPermission: PermissionConfirmRequest | null;

  setSessionId: (id: string | null) => void;
  addMessage: (msg: ChatMessage) => void;
  updateLastMessage: (updater: (msg: ChatMessage) => Partial<ChatMessage>) => void;
  setStreaming: (v: boolean) => void;
  setCurrentTaskId: (id: string | null) => void;
  clearMessages: () => void;
  removeMessage: (id: string) => void;
  editMessage: (id: string, content: string) => void;
  removeMessagesAfter: (id: string) => void;
  setPendingDelegation: (req: DelegationRequest | null) => void;
  setPendingPermission: (req: PermissionConfirmRequest | null) => void;
  restoreSession: (messages: ChatMessage[], activeTask?: { progress?: string | null; thinkingSteps?: ThinkingStep[] }) => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      sessionId: null,
      messages: [],
      isStreaming: false,
      currentTaskId: null,
      pendingDelegation: null,
      pendingPermission: null,

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
      setCurrentTaskId: (id) => set({ currentTaskId: id }),
      clearMessages: () => set({ messages: [], isStreaming: false, pendingDelegation: null, pendingPermission: null }),

      removeMessage: (id) => set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),
      editMessage: (id, content) =>
        set((s) => ({
          messages: s.messages.map((m) => (m.id === id ? { ...m, content } : m)),
        })),
      removeMessagesAfter: (id) =>
        set((s) => {
          const idx = s.messages.findIndex((m) => m.id === id);
          if (idx === -1) return s;
          return { messages: s.messages.slice(0, idx + 1) };
        }),

      setPendingDelegation: (req) => set({ pendingDelegation: req }),
      setPendingPermission: (req) => set({ pendingPermission: req }),

      restoreSession: (messages, activeTask) =>
        set((s) => {
          const hasLocal = s.messages.length > 0;
          let msgs = hasLocal ? [...s.messages] : messages.map((m) => ({
            id: genMsgId("hist"), ...m, status: "complete" as const,
          }));

          if (!activeTask) return hasLocal ? s : { messages: msgs };

          // Append or update streaming placeholder
          const last = msgs[msgs.length - 1];
          if (last?.role === "assistant" && last.status === "streaming") {
            msgs[msgs.length - 1] = { ...last, progress: activeTask.progress ?? undefined, thinkingSteps: activeTask.thinkingSteps };
          } else {
            msgs = [...msgs, {
              id: genMsgId("asst-recovering"),
              role: "assistant" as const,
              content: "",
              timestamp: Date.now(),
              status: "streaming" as const,
              progress: activeTask.progress ?? undefined,
              thinkingSteps: activeTask.thinkingSteps,
            }];
          }
          return { messages: msgs, isStreaming: true };
        }),
    }),
    {
      name: "berry-chat",
      storage: createJSONStorage(() => {
        try { return localStorage; } catch { return sessionStorage; }
      }),
      partialize: (state) => ({
        sessionId: state.sessionId,
        messages: state.messages
          .filter((m) => m.content.length > 0 || m.role === "user")
          .map((m) =>
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

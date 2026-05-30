import { create } from "zustand";

export interface ChatAttachment {
  fileId: string;
  filename: string;
  mimeType: string;
  url: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  status?: "streaming" | "complete" | "error";
  progress?: string;
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

interface ChatState {
  sessionId: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  currentTaskId: string | null;
  pendingDelegation: DelegationRequest | null;
  pendingPermission: PermissionConfirmRequest | null;
  setSessionId: (id: string | null) => void;
  addMessage: (msg: ChatMessage) => void;
  appendToLast: (text: string) => void;
  setLastStatus: (status: ChatMessage["status"]) => void;
  setLastProgress: (progress: string) => void;
  setStreaming: (v: boolean) => void;
  setCurrentTaskId: (id: string | null) => void;
  clearMessages: () => void;
  removeMessage: (id: string) => void;
  editMessage: (id: string, content: string) => void;
  removeMessagesAfter: (id: string) => void;
  setPendingDelegation: (req: DelegationRequest | null) => void;
  setPendingPermission: (req: PermissionConfirmRequest | null) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  sessionId: null,
  messages: [],
  isStreaming: false,
  currentTaskId: null,
  pendingDelegation: null,
  pendingPermission: null,
  setSessionId: (id) => set({ sessionId: id }),
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  appendToLast: (text) =>
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last) {
        msgs[msgs.length - 1] = { ...last, content: last.content + text };
      }
      return { messages: msgs };
    }),
  setLastStatus: (status) =>
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last) {
        msgs[msgs.length - 1] = { ...last, status, progress: undefined };
      }
      return { messages: msgs };
    }),
  setLastProgress: (progress) =>
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last) {
        msgs[msgs.length - 1] = { ...last, progress };
      }
      return { messages: msgs };
    }),
  setStreaming: (v) => set({ isStreaming: v }),
  setCurrentTaskId: (id) => set({ currentTaskId: id }),
  clearMessages: () => set({ messages: [], pendingDelegation: null, pendingPermission: null }),
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
}));

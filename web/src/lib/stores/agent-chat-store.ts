/**
 * 13.0 多智能体协作 — Agent 间对话状态管理。
 *
 * 管理 Agent 间对话消息（Code→Learning 等）。
 * 通过 WS agent_dialogue 事件实时更新，通过 API 查询历史。
 */

import { create } from "zustand";

/** Agent 间对话消息方向 */
export type AgentChatDirection = "request" | "response" | "notify";

/** Agent 间对话消息 */
export interface AgentChatMessage {
  id: string;
  sessionId: string;
  taskId?: string;
  fromAgent: string;
  toAgent: string;
  direction: AgentChatDirection;
  messageType: string;
  content: string;
  correlationId?: string;
  timestamp: number;
}

/** Agent 间对话面板状态 */
interface AgentChatState {
  /** 当前对话消息列表 */
  messages: AgentChatMessage[];
  /** 面板是否展开 */
  isOpen: boolean;
  /** 是否正在加载历史 */
  isLoadingHistory: boolean;
  /** 当前过滤的 sessionId */
  filterSessionId: string | null;
  /** 当前过滤的 taskId */
  filterTaskId: string | null;

  // ─── Actions ───

  /** 添加一条实时对话消息（来自 WS agent_dialogue 事件） */
  addMessage: (msg: AgentChatMessage) => void;

  /** 从 API 加载历史对话 */
  setMessages: (messages: AgentChatMessage[]) => void;

  /** 切换面板展开/收起 */
  toggleOpen: () => void;

  /** 设置面板展开状态 */
  setOpen: (open: boolean) => void;

  /** 设置过滤器 */
  setFilter: (sessionId: string | null, taskId?: string | null) => void;

  /** 设置历史加载状态 */
  setLoadingHistory: (loading: boolean) => void;

  /** 清空所有状态 */
  clear: () => void;
}

export const useAgentChatStore = create<AgentChatState>()((set, get) => ({
  messages: [],
  isOpen: false,
  isLoadingHistory: false,
  filterSessionId: null,
  filterTaskId: null,

  addMessage: (msg) =>
    set((s) => {
      /** 去重：同 id 不重复添加 */
      if (s.messages.some((m) => m.id === msg.id)) return s;
      return { messages: [...s.messages, msg] };
    }),

  setMessages: (messages) => set({ messages }),

  toggleOpen: () => set((s) => ({ isOpen: !s.isOpen })),

  setOpen: (open) => set({ isOpen: open }),

  setFilter: (sessionId, taskId = null) =>
    set({ filterSessionId: sessionId, filterTaskId: taskId }),

  setLoadingHistory: (isLoadingHistory) => set({ isLoadingHistory }),

  clear: () =>
    set({
      messages: [],
      isOpen: false,
      isLoadingHistory: false,
      filterSessionId: null,
      filterTaskId: null,
    }),
}));

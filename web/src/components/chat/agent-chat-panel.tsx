/**
 * 13.0 多智能体协作 — Agent 间对话面板。
 *
 * 展示 Agent 间实时对话（Code→Learning 等），让用户看到 Agent 协作过程。
 * 可折叠面板，嵌入 ChatWindow 右侧或底部。
 *
 * §5.1.1 前端实时信息流：Agent 间对话实时可见
 */

import { useEffect, useRef } from "react";
import { useAgentChatStore, type AgentChatMessage } from "@/lib/stores/agent-chat-store";
import { useT } from "@/lib/i18n";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  ArrowRight,
  X,
} from "lucide-react";

/** Agent 名称 → 显示颜色映射 */
const AGENT_COLORS: Record<string, string> = {
  code: "text-blue-400",
  learning: "text-green-400",
  memory: "text-emerald-400",
  skills: "text-purple-400",
  conversation: "text-orange-400",
  brain: "text-red-400",
  plugin_builder: "text-pink-400",
  skill_tester: "text-yellow-400",
  evolution: "text-cyan-400",
};

/** Agent 名称 → 图标背景色 */
const AGENT_BG: Record<string, string> = {
  code: "bg-blue-500/10",
  learning: "bg-green-500/10",
  memory: "bg-emerald-500/10",
  skills: "bg-purple-500/10",
  conversation: "bg-orange-500/10",
  brain: "bg-red-500/10",
};

/** 获取 agent 显示颜色 */
function getAgentColor(agent: string): string {
  return AGENT_COLORS[agent] ?? "text-zinc-400";
}

/** 获取 agent 图标背景色 */
function getAgentBg(agent: string): string {
  return AGENT_BG[agent] ?? "bg-zinc-500/10";
}

/** 方向箭头样式 */
function DirectionArrow({ direction }: { direction: AgentChatMessage["direction"] }) {
  if (direction === "request") {
    return <ArrowRight className="w-3 h-3 text-zinc-500 flex-shrink-0" />;
  }
  if (direction === "response") {
    return <ArrowRight className="w-3 h-3 text-zinc-500 flex-shrink-0 rotate-180" />;
  }
  return <MessageSquare className="w-3 h-3 text-zinc-500 flex-shrink-0" />;
}

/** 单条对话消息渲染 */
function AgentChatBubble({ msg }: { msg: AgentChatMessage }) {
  const isRequest = msg.direction === "request";

  return (
    <div className={`flex items-start gap-1.5 px-2 py-1 text-[13px] ${isRequest ? "flex-row" : "flex-row-reverse"}`}>
      {/* Agent 图标 */}
      <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${getAgentBg(msg.fromAgent)}`}>
        <Bot className={`w-3 h-3 ${getAgentColor(msg.fromAgent)}`} />
      </div>

      {/* 消息内容 */}
      <div className={`flex items-center gap-1.5 max-w-[85%] ${isRequest ? "flex-row" : "flex-row-reverse"}`}>
        <span className={`font-medium text-[11px] ${getAgentColor(msg.fromAgent)}`}>
          {msg.fromAgent}
        </span>
        <DirectionArrow direction={msg.direction} />
        <span className={`font-medium text-[11px] ${getAgentColor(msg.toAgent)}`}>
          {msg.toAgent}
        </span>
      </div>

      {/* 消息正文 */}
      <div className={`text-zinc-300 text-[12px] leading-relaxed break-all ${isRequest ? "text-left" : "text-right"}`}>
        {msg.content.length > 200
          ? msg.content.slice(0, 200) + "…"
          : msg.content}
      </div>
    </div>
  );
}

/**
 * Agent 间对话面板。
 *
 * 可折叠面板，显示当前 session 的所有 Agent 间对话。
 * 消息来源：WS agent_dialogue 实时事件 + API 历史查询。
 */
export function AgentChatPanel() {
  const t = useT();
  const {
    messages,
    isOpen,
    toggleOpen,
    setOpen,
  } = useAgentChatStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  /** 自动滚动到底部 */
  useEffect(() => {
    if (isOpen && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isOpen]);

  /** 消息数量 badge */
  const count = messages.length;

  return (
    <div className="border-t border-zinc-800 bg-zinc-900/50">
      {/* 头部（点击折叠/展开） */}
      <button
        onClick={toggleOpen}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-zinc-800/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-zinc-400" />
          <span className="text-[13px] font-medium text-zinc-300">
            {t("agentChat.title")}
          </span>
          {count > 0 && (
            <span className="text-[11px] bg-zinc-700 text-zinc-300 rounded-full px-1.5 py-0.5">
              {count}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {isOpen && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              className="p-1 hover:bg-zinc-700 rounded"
            >
              <X className="w-3 h-3 text-zinc-500" />
            </button>
          )}
          {isOpen ? (
            <ChevronDown className="w-4 h-4 text-zinc-500" />
          ) : (
            <ChevronUp className="w-4 h-4 text-zinc-500" />
          )}
        </div>
      </button>

      {/* 消息列表（折叠时隐藏） */}
      {isOpen && (
        <div
          ref={scrollRef}
          className="max-h-[300px] overflow-y-auto overscroll-contain scrollbar-thin"
        >
          {messages.length === 0 ? (
            <div className="text-center text-zinc-600 text-[12px] py-4">
              {t("agentChat.empty")}
            </div>
          ) : (
            <div className="divide-y divide-zinc-800/50">
              {messages.map((msg) => (
                <AgentChatBubble key={msg.id} msg={msg} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

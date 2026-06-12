/**
 * 13.0 多智能体协作 — Agent 间对话面板。
 *
 * 展示 Agent 间实时对话（Code→Learning 等），让用户看到 Agent 协作过程。
 * 可折叠面板，嵌入 ChatWindow 右侧或底部。
 *
 * §5.1.1 前端实时信息流：Agent 间对话实时可见
 *
 * 注意：本组件当前未被任何页面引用（暂未启用），待 13.0 多智能体协作前端完善后接入。
 * Agent 颜色使用语义 token（info/success/destructive/warning），有明确语义的 Agent
 * 映射到对应 token，其余使用 muted-foreground 作为中性色，待 13.0 激活时补充分类色板。
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

/**
 * Agent 名称 → 语义颜色映射。
 * 有明确语义的 Agent 收口到主题 token：
 *   - code（编码/信息）→ info
 *   - learning（学习/正向）→ success
 *   - brain（审核/拦截）→ destructive
 *   - skill_tester（测试/警示）→ warning
 * 其余 Agent 暂用 muted-foreground 中性色，待 13.0 激活时补充分类色板。
 */
const AGENT_COLORS: Record<string, string> = {
  code: "text-info",
  learning: "text-success",
  brain: "text-destructive",
  skill_tester: "text-warning",
};

/** Agent 名称 → 图标背景色（与 AGENT_COLORS 的语义 token 对应，统一 /10 透明度） */
const AGENT_BG: Record<string, string> = {
  code: "bg-info/10",
  learning: "bg-success/10",
  brain: "bg-destructive/10",
  skill_tester: "bg-warning/10",
};

/** 获取 agent 显示颜色（未命中映射时回退到中性色） */
function getAgentColor(agent: string): string {
  return AGENT_COLORS[agent] ?? "text-muted-foreground";
}

/** 获取 agent 图标背景色（未命中映射时回退到中性色） */
function getAgentBg(agent: string): string {
  return AGENT_BG[agent] ?? "bg-muted";
}

/** 方向箭头样式 */
function DirectionArrow({ direction }: { direction: AgentChatMessage["direction"] }) {
  if (direction === "request") {
    return <ArrowRight className="size-3 shrink-0 text-muted-foreground" />;
  }
  if (direction === "response") {
    return <ArrowRight className="size-3 shrink-0 rotate-180 text-muted-foreground" />;
  }
  return <MessageSquare className="size-3 shrink-0 text-muted-foreground" />;
}

/** 单条对话消息渲染 */
function AgentChatBubble({ msg }: { msg: AgentChatMessage }) {
  const isRequest = msg.direction === "request";

  return (
    <div className={`flex items-start gap-1.5 px-2 py-1 text-[13px] ${isRequest ? "flex-row" : "flex-row-reverse"}`}>
      {/* Agent 图标 */}
      <div className={`flex size-5 shrink-0 items-center justify-center rounded-full ${getAgentBg(msg.fromAgent)}`}>
        <Bot className={`size-3 ${getAgentColor(msg.fromAgent)}`} />
      </div>

      {/* 消息内容 */}
      <div className={`flex max-w-[85%] items-center gap-1.5 ${isRequest ? "flex-row" : "flex-row-reverse"}`}>
        <span className={`text-[11px] font-medium ${getAgentColor(msg.fromAgent)}`}>
          {msg.fromAgent}
        </span>
        <DirectionArrow direction={msg.direction} />
        <span className={`text-[11px] font-medium ${getAgentColor(msg.toAgent)}`}>
          {msg.toAgent}
        </span>
      </div>

      {/* 消息正文 */}
      <div className={`break-all text-[12px] leading-relaxed text-foreground ${isRequest ? "text-left" : "text-right"}`}>
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
    <div className="border-t border-border bg-muted/30">
      {/* 头部（点击折叠/展开） */}
      <button
        type="button"
        onClick={toggleOpen}
        className="flex w-full items-center justify-between px-3 py-2 transition-colors hover:bg-muted/60"
      >
        <div className="flex items-center gap-2">
          <MessageSquare className="size-4 text-muted-foreground" />
          <span className="text-[13px] font-medium text-foreground">
            {t("agentChat.title")}
          </span>
          {count > 0 && (
            <span className="rounded-full bg-muted-foreground/15 px-1.5 py-0.5 text-[11px] text-foreground">
              {count}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {isOpen && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              className="min-h-[44px] min-w-[44px] rounded p-1 hover:bg-muted md:min-h-0 md:min-w-0"
              aria-label={t("common.close")}
            >
              <X className="size-3 text-muted-foreground" />
            </button>
          )}
          {isOpen ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronUp className="size-4 text-muted-foreground" />
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
            <div className="py-4 text-center text-[12px] text-muted-foreground">
              {t("agentChat.empty")}
            </div>
          ) : (
            <div className="divide-y divide-border/50">
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

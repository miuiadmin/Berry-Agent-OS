/**
 * 13.0 多智能体协作 — Agent 间对话面板。
 *
 * 展示 Agent 间实时对话（Code→Learning 等），让用户看到 Agent 协作过程。
 * 可折叠面板，嵌入 ChatWindow 右侧或底部。
 *
 * §5.1.1 前端实时信息流：Agent 间对话实时可见
 *
 * 注意：本组件当前未被任何页面引用（暂未启用），待 13.0 多智能体协作前端完善后接入。
 */

import { useEffect, useRef } from "react";
import { useAgentChatStore, type AgentChatMessage } from "@/lib/stores/agent-chat-store";
import { useT } from "@/lib/i18n";
import { Bot, ChevronDown, ChevronUp, MessageSquare, ArrowRight, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Agent 语义样式配置（文本色 + 背景色合并，消除并行 map）。
 * 有明确语义的 Agent 收口到主题 token，其余用 muted-foreground 中性色。
 */
const AGENT_STYLE: Record<string, { text: string; bg: string }> = {
  code:        { text: "text-info",         bg: "bg-info/10" },
  learning:    { text: "text-success",      bg: "bg-success/10" },
  brain:       { text: "text-destructive",   bg: "bg-destructive/10" },
  skill_tester: { text: "text-warning",     bg: "bg-warning/10" },
};
const DEFAULT_AGENT_STYLE = { text: "text-muted-foreground", bg: "bg-muted" };

/** 获取 agent 样式配置 */
function agentStyle(agent: string) {
  return AGENT_STYLE[agent] ?? DEFAULT_AGENT_STYLE;
}

/** 方向箭头：request→右箭头 / response→左箭头 / broadcast→消息图标 */
function DirectionArrow({ direction }: { direction: AgentChatMessage["direction"] }) {
  if (direction === "response") return <ArrowRight className="size-3 shrink-0 rotate-180 text-muted-foreground" />;
  if (direction === "request") return <ArrowRight className="size-3 shrink-0 text-muted-foreground" />;
  return <MessageSquare className="size-3 shrink-0 text-muted-foreground" />;
}

/** 单条对话消息 */
function AgentChatBubble({ msg }: { msg: AgentChatMessage }) {
  const isReq = msg.direction === "request";
  const from = agentStyle(msg.fromAgent);
  const to = agentStyle(msg.toAgent);

  return (
    <div className={cn("flex items-start gap-1.5 px-2 py-1 text-[13px]", isReq ? "flex-row" : "flex-row-reverse")}>
      {/* Agent 图标 */}
      <div className={cn("flex size-5 shrink-0 items-center justify-center rounded-full", from.bg)}>
        <Bot className={cn("size-3", from.text)} />
      </div>

      {/* from → to 标签 */}
      <div className={cn("flex max-w-[85%] items-center gap-1.5", isReq ? "flex-row" : "flex-row-reverse")}>
        <span className={cn("text-[11px] font-medium", from.text)}>{msg.fromAgent}</span>
        <DirectionArrow direction={msg.direction} />
        <span className={cn("text-[11px] font-medium", to.text)}>{msg.toAgent}</span>
      </div>

      {/* 消息正文（超 200 字截断） */}
      <div className={cn("break-all text-[12px] leading-relaxed text-foreground", isReq ? "text-left" : "text-right")}>
        {msg.content.length > 200 ? msg.content.slice(0, 200) + "…" : msg.content}
      </div>
    </div>
  );
}

/**
 * Agent 间对话面板（可折叠）。
 * 消息来源：WS agent_dialogue 实时事件 + API 历史查询。
 */
export function AgentChatPanel() {
  const t = useT();
  const { messages, isOpen, toggleOpen, setOpen } = useAgentChatStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  /** 自动滚动到底部 */
  useEffect(() => {
    if (isOpen && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, isOpen]);

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
          <span className="text-[13px] font-medium text-foreground">{t("agentChat.title")}</span>
          {messages.length > 0 && (
            <span className="rounded-full bg-muted-foreground/15 px-1.5 py-0.5 text-[11px] text-foreground">
              {messages.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {isOpen && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setOpen(false); }}
              className="min-h-[44px] min-w-[44px] rounded p-1 hover:bg-muted md:min-h-0 md:min-w-0"
              aria-label={t("common.close")}
            >
              <X className="size-3 text-muted-foreground" />
            </button>
          )}
          {isOpen ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronUp className="size-4 text-muted-foreground" />}
        </div>
      </button>

      {/* 消息列表 */}
      {isOpen && (
        <div ref={scrollRef} className="max-h-[300px] overflow-y-auto overscroll-contain scrollbar-thin">
          {messages.length === 0 ? (
            <div className="py-4 text-center text-[12px] text-muted-foreground">{t("agentChat.empty")}</div>
          ) : (
            <div className="divide-y divide-border/50">
              {messages.map((msg) => <AgentChatBubble key={msg.id} msg={msg} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

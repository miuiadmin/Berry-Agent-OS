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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  ArrowRight,
  X,
} from "lucide-react";

/** Agent 名称 → 显示颜色映射（全部走语义 token，明暗自适应） */
const AGENT_COLORS: Record<string, string> = {
  code: "text-info",
  learning: "text-success",
  memory: "text-chart-3",
  skills: "text-chart-5",
  conversation: "text-chart-4",
  brain: "text-danger",
  plugin_builder: "text-chart-1",
  skill_tester: "text-warning",
  evolution: "text-chart-2",
};

/** Agent 名称 → 图标背景色（/10 透明度浅底，明暗自适应） */
const AGENT_BG: Record<string, string> = {
  code: "bg-info/10",
  learning: "bg-success/10",
  memory: "bg-chart-3/10",
  skills: "bg-chart-5/10",
  conversation: "bg-chart-4/10",
  brain: "bg-danger/10",
};

/** 获取 agent 显示颜色 */
function getAgentColor(agent: string): string {
  return AGENT_COLORS[agent] ?? "text-muted-foreground";
}

/** 获取 agent 图标背景色 */
function getAgentBg(agent: string): string {
  return AGENT_BG[agent] ?? "bg-accent/10";
}

/** 方向箭头样式 */
function DirectionArrow({ direction }: { direction: AgentChatMessage["direction"] }) {
  if (direction === "request") {
    return <ArrowRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />;
  }
  if (direction === "response") {
    return <ArrowRight className="w-3 h-3 text-muted-foreground flex-shrink-0 rotate-180" />;
  }
  return <MessageSquare className="w-3 h-3 text-muted-foreground flex-shrink-0" />;
}

/** 单条对话消息渲染 */
function AgentChatBubble({ msg }: { msg: AgentChatMessage }) {
  const isRequest = msg.direction === "request";

  return (
    <div className={`flex items-start gap-1.5 px-2 py-1 text-[13px] ${isRequest ? "flex-row" : "flex-row-reverse"}`}>
      {/* Agent 图标 — 使用 Avatar adapter 统一样式 */}
      <Avatar name={msg.fromAgent} size="sm" className={`flex-shrink-0 ${getAgentColor(msg.fromAgent)}`} fallback={<Bot className="w-3 h-3" />} />

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
      <div className={`text-foreground text-[12px] leading-relaxed break-all ${isRequest ? "text-left" : "text-right"}`}>
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
    <div className="border-t border-border bg-muted/50">
      {/* 头部（点击折叠/展开）— 外层用 div 承载点击，内部关闭按钮独立，避免嵌套 button */}
      <div
        role="button"
        tabIndex={0}
        onClick={toggleOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleOpen();
          }
        }}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/50 transition-colors cursor-pointer min-h-[44px] md:min-h-0"
      >
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-muted-foreground" />
          <span className="text-[13px] font-medium text-foreground">
            {t("agentChat.title")}
          </span>
          {count > 0 && (
            <Badge variant="secondary" className="text-[11px]">
              {count}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {isOpen && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              className="min-w-0 min-h-0 size-6"
            >
              <X className="w-3 h-3 text-muted-foreground" />
            </Button>
          )}
          {isOpen ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronUp className="w-4 h-4 text-muted-foreground" />
          )}
        </div>
      </div>

      {/* 消息列表（折叠时隐藏） */}
      {isOpen && (
        <div
          ref={scrollRef}
          className="max-h-[300px] overflow-y-auto overscroll-contain scrollbar-thin"
        >
          {messages.length === 0 ? (
            <div className="text-center text-muted-foreground text-[12px] py-4">
              {t("agentChat.empty")}
            </div>
          ) : (
            <div className="divide-y divide-border">
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

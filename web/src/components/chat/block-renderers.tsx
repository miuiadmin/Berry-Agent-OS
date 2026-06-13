/**
 * 对话内联 block 渲染器（设计文档/22）。
 *
 * 把消息的 displayBlocks（thinking / tool / delegation）按序内联渲染在对话气泡之前，
 * 对齐 Claude Code / OpenCode 的「工具调用 / 推理嵌在对话里」范式——不再是气泡下方的分离兄弟节点。
 *
 * 组件：
 *   - ToolBlockCard：单个 tool block 的内联折叠卡（input/output/state/duration）。
 *   - InlineLeadBlocks：按 displayBlocks 序列渲染 thinking + tool（text 由外层正文气泡承载，此处跳过）。
 *
 * 复用 ThinkingProcess（推理）与 ToolCallCards 的卡片视觉（PRE_BASE / 折叠头），不引入新视觉语言。
 * 移动端硬规则：触控目标 min-h-[44px] md:min-h-0；hover 仅桌面端。
 */

import { useState, memo } from "react";
import { ChevronRight, Wrench, Check, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDurationMs } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { toolBlocksFromLegacy, reasoningFromBlocks } from "@/lib/blocks";
import type { ToolBlock, DelegationBlock } from "@/lib/blocks";
import type { ChatMessage } from "@/lib/stores/chat-store";
import { ThinkingProcess } from "./thinking-process";

/** 输入/输出 pre 共享样式（与 tool-call-cards.tsx 的 PRE_BASE 一致） */
const PRE_BASE =
  "mt-0.5 rounded px-2 py-1.5 overflow-x-auto overflow-y-auto text-[10px] leading-relaxed whitespace-pre-wrap break-all";

/**
 * 把 block 的 unknown 载荷规整为可展示字符串：对象/原始值 JSON.stringify，字符串原样。
 */
function payloadToString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * 单个 tool block 的内联折叠卡（镜像 ToolCallCards 的 ToolCallDetail 视觉，但消费 ToolBlock 模型）。
 * 出生即终态（completed/failed）；pending/running 时显示 spinner。
 */
const ToolBlockCard = memo(function ToolBlockCard({
  block,
  isActive,
}: {
  block: ToolBlock;
  isActive: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const t = useT();

  const isFailed = block.state === "failed";
  const isRunning = block.state === "pending" || block.state === "running";
  const inputStr = payloadToString(block.input);
  // 失败优先展示 error；否则展示 output
  const outputStr = block.error ? payloadToString(block.error) : payloadToString(block.output);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 w-full text-left text-[11px] hover:text-foreground transition-colors min-h-[44px] md:min-h-0"
      >
        <ChevronRight className={cn("size-2.5 shrink-0 transition-transform", expanded && "rotate-90")} />
        <Wrench className="size-3 shrink-0 text-muted-foreground/70" />
        <code className="font-mono text-[11px]">{block.name}</code>
        <span className="ml-auto flex items-center gap-1 shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
          {formatDurationMs(block.durationMs)}
          {isRunning ? (
            <Loader2 className="size-3 animate-spin" />
          ) : isFailed ? (
            <X className="size-3 text-destructive" />
          ) : (
            <Check className="size-3 text-success" />
          )}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 ml-4 space-y-1.5 text-[11px]">
          {inputStr && (
            <div>
              <span className="text-muted-foreground/60 text-[11px] uppercase tracking-wide">{t("tools.input")}</span>
              <pre className={cn(PRE_BASE, "bg-muted/50 max-h-32")}>{inputStr}</pre>
            </div>
          )}
          {outputStr && (
            <div>
              <span className={cn("text-[11px] uppercase tracking-wide", isFailed ? "text-destructive" : "text-muted-foreground/60")}>
                {t(isFailed ? "tools.error" : "tools.output")}
              </span>
              <pre className={cn(PRE_BASE, "max-h-40", isFailed ? "bg-destructive/5" : "bg-muted/50")}>{outputStr}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * 渲染消息的前置内联 blocks（thinking + tool），按 thinking → tools 序列。
 * text block 跳过——正文由 chat-message-list 的气泡承载（避免重复）。
 * delegation block（期4）暂以占位渲染，待 childSessionId 嵌套会话落地。
 *
 * 兼容两条流式路径：
 *   - tool：live blocks（stream.block 事件累积）优先；无则从旧 toolCalls[] 投影（delegation 路径不经 block 事件）。
 *   - thinking：reasoning + thinkingSteps 都透传给 ThinkingProcess（保留进度步骤，防回归）。
 *
 * @param message 当前消息
 * @param isActive 是否流式活跃（驱动 ThinkingProcess 折叠态 / spinner）
 */
export const InlineLeadBlocks = memo(function InlineLeadBlocks({
  message,
  isActive,
}: {
  message: ChatMessage;
  isActive: boolean;
}) {
  // 仅 assistant 消息有内联 blocks；user 消息直接走正文
  if (message.role === "user") return null;

  // thinking：block-first——优先从 thinking block 取（stream.block thinking 喂，单一事实源），
  // 回退 message.reasoning（兼容历史消息 / 过渡期）。消灭 reasoning_delta 后 fallback 仅历史触发。
  const blockReasoning = reasoningFromBlocks(message.blocks, message.reasoning);
  const hasThinking = !!blockReasoning || (message.thinkingSteps?.length ?? 0) > 0;

  // tool blocks：live blocks 优先（stream.block 累积），否则从旧 toolCalls 投影兜底
  const liveToolBlocks = (message.blocks ?? []).filter((b): b is ToolBlock => b.type === "tool");
  const toolBlocks = liveToolBlocks.length > 0 ? liveToolBlocks : toolBlocksFromLegacy(message.toolCalls);
  // 期4 占位：delegation blocks（childSessionId 嵌套会话待落地）
  const delegationBlocks = (message.blocks ?? []).filter(
    (b): b is DelegationBlock => b.type === "delegation",
  );

  if (!hasThinking && toolBlocks.length === 0 && delegationBlocks.length === 0) return null;

  return (
    <div className="w-[90%] sm:w-[80%] space-y-0.5">
      {hasThinking && (
        <ThinkingProcess
          steps={message.thinkingSteps ?? []}
          reasoning={blockReasoning}
          isActive={isActive}
        />
      )}
      {toolBlocks.map((b) => (
        <ToolBlockCard key={b.id} block={b} isActive={isActive} />
      ))}
      {delegationBlocks.map((b) => (
        <div
          key={b.id}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70 min-h-[44px] md:min-h-0"
        >
          <ChevronRight className="size-2.5" />
          <Wrench className="size-3" />
          <span>{b.targetAgent}</span>
          <span className="ml-auto text-[11px] uppercase tracking-wide">{b.state}</span>
        </div>
      ))}
    </div>
  );
});

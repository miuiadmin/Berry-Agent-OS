/**
 * 对话内联 block 渲染器（设计文档/22）——单气泡时间线。
 *
 * MessageTimeline 按 message.blocks 数组顺序渲染整条 AI 响应（思考→文字段→工具→文字段…穿插），
 * 对齐 Claude Code / OpenCode 的「工具调用 / 推理嵌在对话里」范式。所有 block 在同一个气泡内按
 * 到达时间编排，不再按 type 分组堆在气泡外。
 *
 * 组件：
 *   - ToolBlockCard：单个 tool block 的折叠卡（input/output/state/duration）。
 *   - DelegationBlockCard：委派卡（targetAgent + state）。
 *   - MessageTimeline：按 blocks 序 map 渲染（thinking→ThinkingProcess、text→ReactMarkdown、
 *     tool→ToolBlockCard、delegation→DelegationBlockCard、review→跳过由徽章单独渲染）。
 *
 * 移动端硬规则：触控目标 min-h-[44px] md:min-h-0；hover 仅桌面端。
 */

import { useState, useMemo, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import { ChevronRight, Wrench, Check, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { MARKDOWN_PROSE } from "@/components/ui/_shared";
import { formatDurationMs } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { ToolBlock, DelegationBlock, Block } from "@/lib/blocks";
import type { ChatMessage } from "@/lib/stores/chat-store";
import { ThinkingProcess } from "./thinking-process";

/**
 * 工具卡 input/output 的 pre 共享样式（等宽小字、可滚动、自动换行）。
 * 代码场景用 11px（CLAUDE.md 移动端硬规则：非代码内容禁用 text-[10px]，等宽代码 pre 用 11px 符合「代码内容」豁免）。
 */
const PRE_BASE =
  "mt-0.5 rounded px-2 py-1.5 overflow-x-auto overflow-y-auto text-[11px] leading-relaxed whitespace-pre-wrap break-all";

/**
 * 把 block 的 unknown 载荷规整为可展示字符串：对象/原始值 JSON.stringify（2 空格缩进），字符串原样。
 * 用于 tool 的 input / output / error 展示。
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
 * 单个 tool block 的折叠卡（input/output/state/durationMs）。出生即终态（completed/failed），
 * pending/running 显示 spinner。点击 header 展开 input/output pre。
 */
const ToolBlockCard = memo(function ToolBlockCard({ block }: { block: ToolBlock }) {
  const [expanded, setExpanded] = useState(false);
  const t = useT();

  const isFailed = block.state === "failed";
  const isRunning = block.state === "pending" || block.state === "running";
  // useMemo 缓存：大 output（如长 shell 输出）每帧 stringify 浪费，仅 block 字段变化时重算
  const inputStr = useMemo(() => payloadToString(block.input), [block.input]);
  // 失败优先展示 error；否则展示 output
  const outputStr = useMemo(
    () => (block.error ? payloadToString(block.error) : payloadToString(block.output)),
    [block.error, block.output],
  );

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
      {expanded && (inputStr || outputStr) && (
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
 * 委派卡（Brain→子 agent 委派的表头）：targetAgent + state。
 *
 * 仅渲染表头一行——DelegationBlock 类型里的 summary / childSessionId 字段当前不在此卡消费：
 * summary 暂无独立 UI 槽位；childSessionId（嵌套子会话折叠展开）功能未落地。
 * 字段保留在类型里供未来扩展，但此处不渲染，避免误导用户以为可点击展开。
 */
const DelegationBlockCard = memo(function DelegationBlockCard({ block }: { block: DelegationBlock }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70 min-h-[44px] md:min-h-0">
      <ChevronRight className="size-2.5" />
      <Wrench className="size-3" />
      <span>{block.targetAgent}</span>
      <span className="ml-auto text-[11px] uppercase tracking-wide">{block.state}</span>
    </div>
  );
});

/**
 * 按 block.type 分发到对应渲染器。MessageTimeline 的 map 用此函数保持 switch 扁平。
 *
 * @param block           单个 block
 * @param i               在 blocks 中的序号（key + 流式光标判定）
 * @param ctx             渲染上下文（是否最后一块、是否流式活跃、markdown 组件、thinkingSteps）
 */
function renderBlock(block: Block, i: number, ctx: {
  isLast: boolean;
  isActive: boolean;
  markdownComponents: Components;
  thinkingSteps: ChatMessage["thinkingSteps"];
}): ReactNode {
  switch (block.type) {
    case "thinking":
      return (
        <ThinkingProcess
          key={`tg-${i}`}
          steps={ctx.thinkingSteps ?? []}
          reasoning={block.text}
          durationMs={block.durationMs}
          isActive={ctx.isActive}
        />
      );
    case "text":
      // 流式光标只附在「最后一块且是 text」上：流式时正在生成的就是末尾文字段；
      // 若末尾是工具卡（工具刚到、新文字段未开始），不显示光标，避免错位到消息中间
      return (
        <div
          key={`tx-${i}`}
          className={cn(
            MARKDOWN_PROSE,
            ctx.isActive && ctx.isLast && "streaming-cursor",
          )}
        >
          <ReactMarkdown components={ctx.markdownComponents}>{block.text}</ReactMarkdown>
        </div>
      );
    case "tool":
      return <ToolBlockCard key={block.id ?? `tl-${i}`} block={block} />;
    case "delegation":
      return <DelegationBlockCard key={block.id ?? `dg-${i}`} block={block} />;
    case "review":
      // review block 不在时间线渲染——BrainReviewBadge 由 message.reviewVerdict 单独渲染（restore 从 review block 投影）
      return null;
    default:
      return null;
  }
}

/**
 * 单气泡时间线：按 message.blocks 数组顺序渲染整条 AI 响应（思考→文字段→工具→文字段…穿插）。
 * user 消息不渲染（走正文气泡）。无 blocks 时返回 null（由上层走 markdown fallback）。
 *
 * @param message           当前消息（取 blocks 有序数组 + thinkingSteps）
 * @param isActive          流式活跃（驱动 ThinkingProcess 折叠态 / text 段光标）
 * @param markdownComponents text 段的 markdown 渲染组件（由 chat-message-list 注入，复用其配置）
 */
export const MessageTimeline = memo(function MessageTimeline({
  message,
  isActive,
  markdownComponents,
}: {
  message: ChatMessage;
  isActive: boolean;
  markdownComponents: Components;
}) {
  if (message.role === "user") return null;
  const blocks = message.blocks ?? [];
  if (blocks.length === 0) return null;
  const lastIdx = blocks.length - 1;
  return (
    <div className="space-y-2">
      {blocks.map((block, i) =>
        renderBlock(block, i, {
          isLast: i === lastIdx,
          isActive,
          markdownComponents,
          thinkingSteps: message.thinkingSteps,
        }),
      )}
    </div>
  );
});

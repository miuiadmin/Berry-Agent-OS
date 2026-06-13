/**
 * 工具调用卡片组件。
 *
 * 展示 AI 调用工具的详情：工具名 / 输入参数 / 执行结果 / 耗时 / 状态。
 * 可折叠展开，失败时显示错误信息。
 */

import { useState, memo } from "react";
import { ChevronRight, Wrench, Check, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDurationMs } from "@/lib/format";
import { useAutoCollapse } from "@/hooks/use-auto-collapse";
import { useT } from "@/lib/i18n";
import type { ToolCallEvent } from "@/lib/stores/chat-store";

/** 工具调用详情的输入/输出 pre 共享样式 */
const PRE_BASE = "mt-0.5 rounded px-2 py-1.5 overflow-x-auto overflow-y-auto text-[10px] leading-relaxed whitespace-pre-wrap break-all";

interface ToolCallCardsProps {
  calls: ToolCallEvent[];
  isActive: boolean;
}

function ToolCallDetail({ call }: { call: ToolCallEvent }) {
  const [expanded, setExpanded] = useState(false);
  const t = useT();

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 w-full text-left text-[11px] hover:text-foreground transition-colors min-h-[44px] md:min-h-0"
      >
        <ChevronRight className={cn("size-2.5 shrink-0 transition-transform", expanded && "rotate-90")} />
        <code className="font-mono text-[11px]">{call.toolName}</code>
        <span className="ml-auto flex items-center gap-1 shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
          {formatDurationMs(call.durationMs)}
          {call.isError
            ? <X className="size-3 text-destructive" />
            : <Check className="size-3 text-success" />
          }
        </span>
      </button>
      {expanded && (
        <div className="mt-1 ml-4 space-y-1.5 text-[11px]">
          <div>
            <span className="text-muted-foreground/60 text-[11px] uppercase tracking-wide">{t("tools.input")}</span>
            <pre className={cn(PRE_BASE, "bg-muted/50 max-h-32")}>{call.input}</pre>
          </div>
          <div>
            <span className={cn("text-[11px] uppercase tracking-wide", call.isError ? "text-destructive" : "text-muted-foreground/60")}>
              {t(call.isError ? "tools.error" : "tools.output")}
            </span>
            <pre className={cn(PRE_BASE, "max-h-40", call.isError ? "bg-destructive/5" : "bg-muted/50")}>
              {call.result}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 工具调用折叠面板 — memo 包装，已完成消息不会因其他消息流式更新而重渲染。
 * 流式活跃消息（calls 数组引用每次变化）仍正常重渲染。
 */
export const ToolCallCards = memo(function ToolCallCards({ calls, isActive }: ToolCallCardsProps) {
  const [expanded, setExpanded] = useAutoCollapse(isActive);
  const t = useT();

  if (calls.length === 0) return null;

  // 防御 durationMs 缺失（daemon 路径的委派 tool_call 可能不带耗时）：
  // undefined 参与加法会让整个 totalMs 变 NaN，导致总耗时彻底丢失。缺失项按 0 累加，
  // 至少保住其余有耗时工具的汇总值。
  const totalMs = calls.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);
  const hasErrors = calls.some((c) => c.isError);

  // 外层容器不加 margin，与"思考过程"块紧邻；块间剩余视觉间距来自文本 line-height（行盒留白）而非 margin
  // （详见 thinking-process.tsx 注释），此处同样保留默认行高以保证 11px 小字可读性。
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors min-h-[44px] md:min-h-0"
      >
        <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />
        <Wrench className="size-3" />
        <span>{t("tools.header", { count: calls.length })}</span>
        {isActive && <Loader2 className="size-2.5 animate-spin ml-0.5" />}
        {!isActive && (
          <span className="ml-0.5 opacity-60">
            {totalMs > 0 ? `· ${formatDurationMs(totalMs)}` : ""}
            {hasErrors ? t("thinking.hasErrors") : ""}
          </span>
        )}
      </button>
      <div className="collapse-wrapper" data-open={expanded}>
        <div className="collapse-inner">
          <div className="ml-3.5 mt-0.5 border-l border-border/50 pl-2 divide-y divide-border/30">
            {calls.map((call) => (
              <ToolCallDetail key={`${call.toolName}-${call.ts}`} call={call} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});

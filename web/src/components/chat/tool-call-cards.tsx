
import { useState, useEffect, useRef } from "react";
import { ChevronRight, Wrench, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { formatDurationMs } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { ToolCallEvent } from "@/lib/stores/chat-store";

interface ToolCallCardsProps {
  calls: ToolCallEvent[];
  isActive: boolean;
}

function ToolCallDetail({ call }: { call: ToolCallEvent }) {
  const [expanded, setExpanded] = useState(false);
  const t = useT();

  return (
    <div>
      <Button
        variant="ghost"
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 w-full text-left text-[11px] hover:text-foreground transition-colors h-auto"
      >
        <ChevronRight className={cn("size-2.5 shrink-0 transition-transform", expanded && "rotate-90")} />
        <code className="font-mono text-[11px]">{call.toolName}</code>
        <span className="ml-auto flex items-center gap-1 shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
          {formatDurationMs(call.durationMs)}
          {call.isError
            ? <X className="size-3 text-danger" />
            : <Check className="size-3 text-success" />
          }
        </span>
      </Button>
      {expanded && (
        <div className="mt-1 ml-4 space-y-1.5 text-[11px]">
          <div>
            <span className="text-muted-foreground/60 text-[11px] uppercase tracking-wide">{t("tools.input")}</span>
            <pre className="mt-0.5 rounded bg-muted/50 px-2 py-1.5 overflow-x-auto max-h-32 overflow-y-auto text-[10px] leading-relaxed whitespace-pre-wrap break-all">
              {call.input}
            </pre>
          </div>
          <div>
            <span className={cn("text-[11px] uppercase tracking-wide", call.isError ? "text-danger" : "text-muted-foreground/60")}>
              {t(call.isError ? "tools.error" : "tools.output")}
            </span>
            <pre className={cn(
              "mt-0.5 rounded px-2 py-1.5 overflow-x-auto max-h-40 overflow-y-auto text-[10px] leading-relaxed whitespace-pre-wrap break-all",
              call.isError ? "bg-danger/5" : "bg-muted/50",
            )}>
              {call.result}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export function ToolCallCards({ calls, isActive }: ToolCallCardsProps) {
  const [expanded, setExpanded] = useState(isActive);
  const wasActive = useRef(isActive);
  const t = useT();

  useEffect(() => {
    if (wasActive.current && !isActive) setExpanded(false);
    wasActive.current = isActive;
  }, [isActive]);

  if (calls.length === 0) return null;

  const totalMs = calls.reduce((sum, c) => sum + c.durationMs, 0);
  const hasErrors = calls.some((c) => c.isError);

  // 外层容器不加 margin，与"思考过程"块紧邻；块间剩余视觉间距来自文本 line-height（行盒留白）而非 margin
  // （详见 thinking-process.tsx 注释），此处同样保留默认行高以保证 11px 小字可读性。
  return (
    <div>
      <Button
        variant="ghost"
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors h-auto"
      >
        <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />
        <Wrench className="size-3" />
        <span>{t("tools.header", { count: calls.length })}</span>
        {isActive && <Spinner size="sm" className="ml-0.5 [&>svg]:size-2.5" />}
        {!isActive && (
          <span className="ml-0.5 opacity-60">
            {totalMs > 0 ? `· ${formatDurationMs(totalMs)}` : ""}
            {hasErrors ? t("thinking.hasErrors") : ""}
          </span>
        )}
      </Button>
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
}

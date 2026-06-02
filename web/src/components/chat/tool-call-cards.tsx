
import { useState, useEffect, useRef } from "react";
import { ChevronRight, Wrench, Check, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolCallEvent } from "@/lib/stores/chat-store";

interface ToolCallCardsProps {
  calls: ToolCallEvent[];
  isActive: boolean;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ToolCallDetail({ call }: { call: ToolCallEvent }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 w-full text-left text-[11px] hover:text-foreground transition-colors min-h-[44px] md:min-h-0"
      >
        <ChevronRight className={cn("size-2.5 shrink-0 transition-transform", expanded && "rotate-90")} />
        <code className="font-mono text-[11px]">{call.toolName}</code>
        <span className="ml-auto flex items-center gap-1 shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
          {formatDuration(call.durationMs)}
          {call.isError
            ? <X className="size-3 text-red-500" />
            : <Check className="size-3 text-green-500" />
          }
        </span>
      </button>
      {expanded && (
        <div className="mt-1 ml-4 space-y-1.5 text-[11px]">
          <div>
            <span className="text-muted-foreground/60 text-[11px] uppercase tracking-wide">Input</span>
            <pre className="mt-0.5 rounded bg-muted/50 px-2 py-1.5 overflow-x-auto max-h-32 overflow-y-auto text-[10px] leading-relaxed whitespace-pre-wrap break-all">
              {call.input}
            </pre>
          </div>
          <div>
            <span className={cn("text-[11px] uppercase tracking-wide", call.isError ? "text-red-400" : "text-muted-foreground/60")}>
              {call.isError ? "Error" : "Output"}
            </span>
            <pre className={cn(
              "mt-0.5 rounded px-2 py-1.5 overflow-x-auto max-h-40 overflow-y-auto text-[10px] leading-relaxed whitespace-pre-wrap break-all",
              call.isError ? "bg-red-500/5" : "bg-muted/50",
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

  useEffect(() => {
    if (wasActive.current && !isActive) setExpanded(false);
    wasActive.current = isActive;
  }, [isActive]);

  if (calls.length === 0) return null;

  const totalMs = calls.reduce((sum, c) => sum + c.durationMs, 0);
  const hasErrors = calls.some((c) => c.isError);

  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors py-0.5"
      >
        <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />
        <Wrench className="size-3" />
        <span>Tools ({calls.length})</span>
        {isActive && <Loader2 className="size-2.5 animate-spin ml-0.5" />}
        {!isActive && (
          <span className="ml-0.5 opacity-60">
            {totalMs > 0 ? `· ${formatDuration(totalMs)}` : ""}
            {hasErrors ? " · has errors" : ""}
          </span>
        )}
      </button>
      <div className="collapse-wrapper" data-open={expanded}>
        <div className="collapse-inner">
          <div className="ml-3.5 mt-0.5 border-l border-border/50 pl-2 divide-y divide-border/30">
            {calls.map((call, i) => (
              <ToolCallDetail key={i} call={call} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

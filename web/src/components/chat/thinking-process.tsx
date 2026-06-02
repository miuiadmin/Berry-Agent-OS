
import { useState, useEffect, useRef } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import type { ThinkingStep } from "@/lib/stores/chat-store";

interface ThinkingProcessProps {
  steps: ThinkingStep[];
  reasoning?: string;
  isActive: boolean;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function StepDuration({ step, nextStep, isLast, isActive }: { step: ThinkingStep; nextStep?: ThinkingStep; isLast: boolean; isActive: boolean }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!isLast || !isActive) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [isLast, isActive]);

  const end = isLast && isActive ? now : (nextStep?.ts ?? step.ts);
  const elapsed = end - step.ts;

  return (
    <span className="ml-auto pl-2 text-[11px] tabular-nums text-muted-foreground/50 shrink-0">
      {formatElapsed(elapsed)}
    </span>
  );
}

export function ThinkingProcess({ steps, reasoning, isActive }: ThinkingProcessProps) {
  const [expanded, setExpanded] = useState(isActive);
  const listRef = useRef<HTMLDivElement>(null);
  const wasActive = useRef(isActive);
  const t = useT();

  // Auto-collapse when streaming completes
  useEffect(() => {
    if (wasActive.current && !isActive) setExpanded(false);
    wasActive.current = isActive;
  }, [isActive]);

  // Auto-scroll to bottom when new steps arrive
  useEffect(() => {
    if (expanded && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [steps.length, expanded]);

  if (steps.length === 0 && !reasoning) return null;

  const totalMs = steps.length >= 2 ? (steps[steps.length - 1].ts - steps[0].ts) : 0;

  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}
        className="flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors min-h-[44px] md:min-h-0"
      >
        <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />
        <span>{isActive ? t("thinking.active") : t("thinking.inactive")}</span>
        {isActive && <Loader2 className="size-2.5 animate-spin ml-0.5" />}
        {!isActive && steps.length > 0 && (
          <span className="ml-0.5 opacity-60">
            ({steps.length}{totalMs > 500 ? ` · ${formatElapsed(totalMs)}` : ""})
          </span>
        )}
      </button>
      <div className="collapse-wrapper" data-open={expanded}>
        <div className="collapse-inner">
          <div
            ref={listRef}
            className="ml-3.5 mt-0.5 max-h-32 overflow-y-auto space-y-px border-l border-border/50 pl-2"
          >
            {steps.map((step, i) => (
              <div
                key={i}
                className={cn(
                  "flex items-center text-[11px] leading-snug",
                  i === steps.length - 1 && isActive
                    ? "text-muted-foreground"
                    : "text-muted-foreground/60",
                )}
              >
                <span className="truncate">{step.text}</span>
                <StepDuration
                  step={step}
                  nextStep={steps[i + 1]}
                  isLast={i === steps.length - 1}
                  isActive={isActive}
                />
              </div>
            ))}
            {reasoning && (
              <ReasoningBlock text={reasoning} isActive={isActive} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReasoningBlock({ text, isActive }: { text: string; isActive: boolean }) {
  return (
    <div className="mt-1 pt-1 border-t border-border/30">
      <div className="text-[11px] text-muted-foreground/70 whitespace-pre-wrap max-h-60 overflow-y-auto leading-relaxed">
        {text}
        {isActive && <span className="animate-pulse">▋</span>}
      </div>
    </div>
  );
}

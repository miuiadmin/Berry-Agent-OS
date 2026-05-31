"use client";

import { useState, useEffect, useRef } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
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
  if (elapsed < 50) return null;

  return (
    <span className="ml-auto pl-2 text-[10px] tabular-nums text-muted-foreground/50 shrink-0">
      {formatElapsed(elapsed)}
    </span>
  );
}

export function ThinkingProcess({ steps, reasoning, isActive }: ThinkingProcessProps) {
  const [manualCollapse, setManualCollapse] = useState<boolean | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const collapsed = manualCollapse ?? !isActive;

  useEffect(() => {
    if (!collapsed && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [steps.length, collapsed]);

  if (steps.length === 0) return null;

  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={() => setManualCollapse((v) => !(v ?? !isActive))}
        className="flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors py-0.5"
      >
        <ChevronRight className={cn("size-3 transition-transform", !collapsed && "rotate-90")} />
        <span>{isActive ? "Thinking" : "Thought process"}</span>
        {isActive && <Loader2 className="size-2.5 animate-spin ml-0.5" />}
        {!isActive && <span className="ml-0.5 opacity-60">({steps.length})</span>}
      </button>
      {!collapsed && (
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
            <div className="mt-1 pt-1 border-t border-border/30 text-[11px] text-muted-foreground/70 whitespace-pre-wrap max-h-40 overflow-y-auto leading-relaxed">
              {reasoning}
              {isActive && <span className="animate-pulse">▋</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

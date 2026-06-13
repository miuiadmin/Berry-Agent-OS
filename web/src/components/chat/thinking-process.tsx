/**
 * 思考过程折叠面板。
 *
 * 展示 AI 的思考步骤（thinkingSteps）和推理链（reasoning），
 * 可折叠展开，流式传输时自动展开 + 动画。
 */

import { useState, useEffect, useRef, memo } from "react";
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

/**
 * 思考过程折叠面板 — memo 包装，已完成消息不会因其他消息流式更新而重渲染。
 * 流式活跃消息（steps 数组引用每次变化）仍正常重渲染。
 */
export const ThinkingProcess = memo(function ThinkingProcess({ steps, reasoning, isActive }: ThinkingProcessProps) {
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

  // 外层容器故意不加 margin：与上方"时间戳行"、下方"工具调用块"的外层包裹（chat-message-list.tsx）
  // 一起把块间 margin 压到最小。但注意 —— 即使相邻块 margin 全为 0，视觉上仍会保留约 2~4px 空隙：
  // 这来自 CSS line-height（行高 leading），而非 margin/padding。
  // text-[11px] 默认 normal 行高约 1.2，行盒高度 ~17px，而字符字身实际占高仅 ~11px，
  // 行盒上下各留 ~3px leading 半距；两行行盒紧贴时，这上下半距叠加即形成可见间距。
  // 这是正常排印行为。要彻底消除需 leading-none（强制行高=字号），但 11px 小字会明显降低可读性，故不采用。
  return (
    <div>
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
});

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

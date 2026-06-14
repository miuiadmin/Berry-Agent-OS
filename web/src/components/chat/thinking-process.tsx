/**
 * 思考过程折叠面板。
 *
 * 展示 AI 的思考步骤（thinkingSteps）和推理链（reasoning），
 * 可折叠展开，流式传输时自动展开 + 动画。
 */

import { useState, useEffect, useRef, memo } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDurationMs } from "@/lib/format";
import { useAutoCollapse } from "@/hooks/use-auto-collapse";
import { useT } from "@/lib/i18n";
import type { ThinkingStep } from "@/lib/stores/chat-store";

interface ThinkingProcessProps {
  steps: ThinkingStep[];
  reasoning?: string;
  isActive: boolean;
  /** 思考耗时（毫秒，来自 thinking block 的 durationMs）—— 非流式时 header 显示「思考了 Ns」 */
  durationMs?: number;
}

/** 活跃步骤计时器的刷新间隔（毫秒） */
const LIVE_TICK_MS = 100;
/** 总耗时显示阈值（毫秒）—— 低于此值不显示，避免噪音 */
const TOTAL_MS_THRESHOLD = 500;

/**
 * 单个步骤的耗时显示。
 * - 进行中的最后一步：每 LIVE_TICK_MS 刷新显示实时耗时
 * - 已完成步骤：到下一步开始的时间间隔
 */
function StepDuration({ step, nextStep, isLast, isActive }: {
  step: ThinkingStep;
  nextStep?: ThinkingStep;
  isLast: boolean;
  isActive: boolean;
}) {
  const [now, setNow] = useState(Date.now());

  // 仅"进行中的最后一步"需要计时器实时刷新
  useEffect(() => {
    if (!isLast || !isActive) return;
    const id = setInterval(() => setNow(Date.now()), LIVE_TICK_MS);
    return () => clearInterval(id);
  }, [isLast, isActive]);

  // 进行中 → 用 now 作终点；已完成 → 用下一步的开始时间作终点
  const end = isLast && isActive ? now : (nextStep?.ts ?? step.ts);
  const elapsed = end - step.ts;

  return (
    <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground/50">
      {formatDurationMs(elapsed)}
    </span>
  );
}

/**
 * 思考过程折叠面板 — memo 包装，已完成消息不会因其他消息流式更新而重渲染。
 * 流式活跃消息（steps 数组引用每次变化）仍正常重渲染。
 */
export const ThinkingProcess = memo(function ThinkingProcess({ steps, reasoning, isActive, durationMs }: ThinkingProcessProps) {
  const [expanded, setExpanded] = useAutoCollapse(isActive);
  const listRef = useRef<HTMLDivElement>(null);
  const t = useT();

  /**
   * 自动滚到底：新步骤到来 / 展开切换 / reasoning 文本增长 时触发。
   * reasoning 也加入依赖——推理链流式增长时若不触发滚动，用户看不到最新文本。
   */
  useEffect(() => {
    if (expanded && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [steps.length, expanded, reasoning]);

  // 无步骤无推理 → 不渲染
  if (steps.length === 0 && !reasoning) return null;

  // 总耗时：仅 ≥2 步时才有意义
  const totalMs = steps.length >= 2 ? (steps[steps.length - 1].ts - steps[0].ts) : 0;

  /*
   * 外层容器故意不加 margin：与上方"时间戳行"、下方"工具调用块"的外层包裹
   * （chat-message-list.tsx）一起把块间 margin 压到最小。
   *
   * 但注意 —— 即使相邻块 margin 全为 0，视觉上仍会保留约 2~4px 空隙：
   * 这来自 CSS line-height（行高 leading），而非 margin/padding。
   * text-[11px] 默认 normal 行高约 1.2，行盒高度 ~17px，而字符字身实际占高仅 ~11px，
   * 行盒上下各留 ~3px leading 半距；两行行盒紧贴时，这上下半距叠加即形成可见间距。
   *
   * 这是正常排印行为。要彻底消除需 leading-none（强制行高=字号），但 11px 小字会明显
   * 降低可读性，故不采用。
   */
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}
        className="flex min-h-[44px] items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors md:min-h-0"
      >
        <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />
        <span>{isActive ? t("thinking.active") : t("thinking.inactive")}</span>
        {/* 流式中：转圈指示 */}
        {isActive && <Loader2 className="ml-0.5 size-2.5 animate-spin" />}
        {/* 已完成 + 有精确耗时：显示 durationMs（来自 thinking block） */}
        {!isActive && durationMs != null && (
          <span className="ml-0.5 opacity-60">· {formatDurationMs(durationMs)}</span>
        )}
        {/* 已完成 + 无 durationMs + 有步骤：显示步骤数（+ 可选总耗时） */}
        {!isActive && durationMs == null && steps.length > 0 && (
          <span className="ml-0.5 opacity-60">
            ({steps.length}{totalMs > TOTAL_MS_THRESHOLD ? ` · ${formatDurationMs(totalMs)}` : ""})
          </span>
        )}
      </button>
      <div className="collapse-wrapper" data-open={expanded}>
        <div className="collapse-inner">
          <div
            ref={listRef}
            className="ml-3.5 mt-0.5 max-h-32 space-y-px overflow-y-auto border-l border-border/50 pl-2"
          >
            {steps.map((step, i) => (
              <div
                key={i}
                className={cn(
                  "flex items-center text-[11px] leading-snug",
                  // 进行中的最后一步高亮，其余步骤降明度
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
            {reasoning && <ReasoningBlock text={reasoning} isActive={isActive} />}
          </div>
        </div>
      </div>
    </div>
  );
});

/** 推理链展示块（reasoning 全文，支持灯箱式滚动 + 流式光标） */
function ReasoningBlock({ text, isActive }: { text: string; isActive: boolean }) {
  return (
    <div className="mt-1 border-t border-border/30 pt-1">
      <div className="max-h-60 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground/70 overflow-y-auto">
        {text}
        {isActive && <span className="animate-pulse">▋</span>}
      </div>
    </div>
  );
}

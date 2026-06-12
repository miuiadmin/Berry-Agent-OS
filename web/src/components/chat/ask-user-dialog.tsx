/**
 * 13.0 多智能体协作 — 交互式 AskUser 组件。
 *
 * 当 Agent 通过 askUser 向用户提问时，展示选项按钮供用户选择。
 * 支持：
 *   - 展示问题文本
 *   - 可点击的选项按钮（§2.1 AgentPort askUser 原语）
 *   - 5 分钟超时自动回复默认（§5.3.5）
 *   - 自由文本输入（选择 "让我自己说"）
 *
 * 触发：WS ask_user 事件 → ChatWindow 展示此组件
 */

import { useState, useEffect, useRef } from "react";
import { useT } from "@/lib/i18n";
import { HelpCircle, Send, Clock } from "lucide-react";
import { apiPost } from "@/lib/api";
import { setLastProgress } from "@/lib/stores/chat-store";
import { Button } from "@/components/ui/button";

/** AskUser 事件 payload */
export interface AskUserPayload {
  /** Agent 提出的问题 */
  question: string;
  /** 选项列表（2-4 个） */
  options?: string[];
  /** 关联的 sessionId */
  sessionId: string;
  /** 关联的 taskId */
  taskId?: string;
  /** 关联的 correlationId（用于回复匹配） */
  correlationId?: string;
}

/** 组件 props */
interface AskUserDialogProps {
  /** askUser 事件数据 */
  payload: AskUserPayload;
  /** 回复后的回调 */
  onResponded?: () => void;
}

/** 默认超时 5 分钟（§5.3.5） */
const ASK_USER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 交互式 AskUser 对话框。
 *
 * 展示 Agent 的问题 + 选项按钮，用户点击后通过 API 回复。
 */
export function AskUserDialog({ payload, onResponded }: AskUserDialogProps) {
  const t = useT();
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [customAnswer, setCustomAnswer] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [responded, setResponded] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(
    Math.floor(ASK_USER_TIMEOUT_MS / 1000)
  );
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** 超时倒计时（§5.3.5: 5 分钟超时） */
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          /** 超时自动选择第一个选项 */
          handleRespond(payload.options?.[0] ?? t("askUser.noResponse"));
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current != null) clearInterval(timerRef.current);
    };
  }, []);

  /** 提交用户回复 */
  async function handleRespond(answer: string) {
    if (isSubmitting || responded) return;
    setIsSubmitting(true);

    try {
      await apiPost("/conversation/ask-user-response", {
        sessionId: payload.sessionId,
        taskId: payload.taskId ?? "",
        correlationId: payload.correlationId ?? "",
        answer,
      });
      setResponded(true);
      setLastProgress(
        t("askUser.responded", { answer: answer.slice(0, 50) })
      );
      onResponded?.();
    } catch (err) {
      console.error("Failed to respond to askUser:", err);
    } finally {
      setIsSubmitting(false);
    }
  }

  /** 提交自由文本回复 */
  function handleSubmitCustom() {
    if (!customAnswer.trim()) return;
    handleRespond(customAnswer.trim());
  }

  /** 格式化剩余时间 */
  function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  if (responded) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-success/5 border border-success/20 rounded-lg mx-3 my-2">
        <HelpCircle className="w-4 h-4 text-success flex-shrink-0" />
        <span className="text-[13px] text-success">
          {t("askUser.respondedLabel")}
        </span>
      </div>
    );
  }

  return (
    <div className="mx-3 my-2 bg-muted/50 border border-border rounded-lg overflow-hidden">
      {/* 问题 */}
      <div className="flex items-start gap-2 px-3 py-2 border-b border-border">
        <HelpCircle className="w-4 h-4 text-info flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="text-[13px] text-foreground">{payload.question}</p>
          <div className="flex items-center gap-1 mt-1">
            <Clock className="w-3 h-3 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">
              {formatTime(remainingSeconds)}
            </span>
          </div>
        </div>
      </div>

      {/* 选项按钮 */}
      {payload.options && payload.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 py-2">
          {payload.options.map((option, idx) => (
            <Button
              key={idx}
              variant={selectedOption === option ? "primary" : "outline"}
              size="sm"
              onClick={() => handleRespond(option)}
              disabled={isSubmitting}
              className="min-h-[44px] md:min-h-0"
            >
              {option}
            </Button>
          ))}
        </div>
      )}

      {/* 自由文本输入 */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-border">
        <input
          type="text"
          value={customAnswer}
          onChange={(e) => setCustomAnswer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmitCustom();
          }}
          placeholder={t("askUser.customPlaceholder")}
          className="flex-1 bg-background border border-input rounded px-2 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring min-h-[44px] md:min-h-0"
        />
        <Button
          variant="primary"
          size="icon"
          disabled={isSubmitting || !customAnswer.trim()}
          onClick={handleSubmitCustom}
          aria-label={t("chat.send")}
          className="min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0"
        >
          <Send className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

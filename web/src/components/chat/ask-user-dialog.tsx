/**
 * 13.0 多智能体协作 — 交互式 AskUser 组件。
 *
 * 当 Agent 通过 askUser 向用户提问时，展示选项按钮供用户选择。
 * 支持：
 *   - 展示问题文本
 *   - 可点击的选项按钮（§2.1 AgentPort askUser 原语）
 *   - 5 分钟超时自动回复默认（§5.3.5）
 *   - 自由文本输入（选择"让我自己说"）
 *
 * 触发：WS ask_user 事件 → ChatWindow 展示此组件
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useT } from "@/lib/i18n";
import { HelpCircle, Send, Clock } from "lucide-react";
import { apiPost } from "@/lib/api";
import { setLastProgress } from "@/lib/stores/chat-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  payload: AskUserPayload;
  onResponded?: () => void;
}

/** 默认超时 5 分钟（§5.3.5） */
const ASK_USER_TIMEOUT_MS = 5 * 60 * 1000;

/** 格式化剩余时间（m:ss） */
function fmtTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
}

/**
 * 交互式 AskUser 对话框。
 *
 * 展示 Agent 的问题 + 选项按钮，用户点击后通过 API 回复。
 *
 * 防重复提交：timer 用 ref 追踪 responded 状态，避免闭包过期导致超时重复提交；
 * handleRespond 自身用 submitting + respondedRef 双重判断。
 */
export function AskUserDialog({ payload, onResponded }: AskUserDialogProps) {
  const t = useT();
  const [customAnswer, setCustomAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [responded, setResponded] = useState(false);
  /** 初始倒计时秒数 */
  const [remaining, setRemaining] = useState(Math.floor(ASK_USER_TIMEOUT_MS / 1000));

  /** ref 追踪 responded 状态，让 timer 回调读到最新值（避免闭包过期） */
  const respondedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** 提交用户回复（选项 or 自定义文本）。重复调用被忽略。 */
  const handleRespond = useCallback(async (answer: string) => {
    // 双重判断：组件 submitting 态 + ref 防闭包过期
    if (submitting || respondedRef.current) return;
    setSubmitting(true);
    try {
      await apiPost("/conversation/ask-user-response", {
        sessionId: payload.sessionId,
        taskId: payload.taskId ?? "",
        correlationId: payload.correlationId ?? "",
        answer,
      });
      respondedRef.current = true;
      setResponded(true);
      setLastProgress(t("askUser.responded", { answer: answer.slice(0, 50) }));
      onResponded?.();
    } catch (err) {
      console.error("Failed to respond to askUser:", err);
    } finally {
      setSubmitting(false);
    }
  }, [submitting, payload, t, onResponded]);

  /**
   * 超时倒计时（§5.3.5: 5 分钟超时）。
   * 通过 respondedRef 检查避免超时后重复提交（与用户主动回复竞态时的兜底）。
   */
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          /** 超时自动选第一个选项（无选项时回复"无响应"文案） */
          if (!respondedRef.current) {
            handleRespond(payload.options?.[0] ?? t("askUser.noResponse"));
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [handleRespond, payload.options, t]);

  /** 提交自由文本（空值忽略） */
  const submitCustom = () => {
    const trimmed = customAnswer.trim();
    if (trimmed) handleRespond(trimmed);
  };

  /** 已回复状态：展示简洁成功提示 */
  if (responded) {
    return (
      <div className="mx-3 my-2 flex items-center gap-2 rounded-lg border border-success/20 bg-success/5 px-3 py-2">
        <HelpCircle className="size-4 shrink-0 text-success" />
        <span className="text-[13px] text-success">{t("askUser.respondedLabel")}</span>
      </div>
    );
  }

  return (
    <div className="mx-3 my-2 overflow-hidden rounded-lg border border-border bg-muted/50">
      {/* 问题 + 倒计时 */}
      <div className="flex items-start gap-2 border-b border-border px-3 py-2">
        <HelpCircle className="mt-0.5 size-4 shrink-0 text-info" />
        <div className="flex-1">
          <p className="text-[13px] text-foreground">{payload.question}</p>
          <div className="mt-1 flex items-center gap-1">
            <Clock className="size-3 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">{fmtTime(remaining)}</span>
          </div>
        </div>
      </div>

      {/* 选项按钮（移动端 44px 触控目标） */}
      {payload.options && payload.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 py-2">
          {payload.options.map((option, idx) => (
            <Button key={idx} variant="outline" size="sm"
              onClick={() => handleRespond(option)} disabled={submitting}
              className="min-h-[44px] md:min-h-0">
              {option}
            </Button>
          ))}
        </div>
      )}

      {/* 自由文本输入（Enter 提交） */}
      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <Input
          type="text"
          value={customAnswer}
          onChange={(e) => setCustomAnswer(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submitCustom(); }}
          placeholder={t("askUser.customPlaceholder")}
        />
        <Button variant="default" size="icon"
          onClick={submitCustom} disabled={submitting || !customAnswer.trim()}
          className="size-11 md:size-8" aria-label={t("askUser.customPlaceholder")}>
          <Send className="size-4" />
        </Button>
      </div>
    </div>
  );
}

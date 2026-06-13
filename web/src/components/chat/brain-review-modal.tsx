/**
 * Brain 审核详情弹窗。
 *
 * 展示 Brain 审核结果：原始回复 vs 修改后回复的 diff 对比、还原、反馈。
 * 触发：点击消息上的 Brain 审核 badge。
 */

import { useState } from "react";
import { useT } from "@/lib/i18n";
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  RotateCcw,
  MessageCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { apiPost } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TextAreaField } from "@/components/ui/text-area-field";

/** Brain 审核裁决类型 */
type Verdict = "approve" | "modify" | "reject";

/** 裁决视觉配置：图标、badge variant、i18n 标签 key */
const VERDICT_CFG: Record<
  Verdict,
  {
    icon: React.ReactNode;
    badge: "success" | "warning" | "destructive";
    labelKey: string;
  }
> = {
  approve: {
    icon: <ShieldCheck className="size-5 text-success" />,
    badge: "success",
    labelKey: "brain.approved",
  },
  modify: {
    icon: <Shield className="size-5 text-warning" />,
    badge: "warning",
    labelKey: "brain.modified",
  },
  reject: {
    icon: <ShieldAlert className="size-5 text-destructive" />,
    badge: "destructive",
    labelKey: "brain.rejected",
  },
};

/** 内容块色调样式（Tailwind 要求完整类名字面量） */
const TONE_STYLE: Record<"destructive" | "success", string> = {
  destructive: "border-destructive/20 bg-destructive/5",
  success: "border-success/20 bg-success/5",
};

/**
 * 包裹一个异步操作：自动管理 pending 态 + try/catch/finally + 错误日志。
 *
 * 消除还原 / 提交反馈两处手写的
 *   setBusy(true) → try { await } catch { console.error } finally { setBusy(false) }
 * 样板。pending 期间重复触发被忽略（等价手写的 if (busy) return）。
 *
 * 成功副作用写在传入的 action 里（await 之后、finally 之前执行），
 * 因此 setRestored 这类「成功标记」能正常留存。
 *
 * @param errLabel 失败时 console.error 的前缀文案
 * @returns run（接收实际异步逻辑）+ isPending
 */
function useAsyncAction(errLabel: string) {
  const [isPending, setIsPending] = useState(false);
  const run = async (action: () => Promise<void>) => {
    if (isPending) return;
    setIsPending(true);
    try {
      await action();
    } catch (err) {
      console.error(errLabel, err);
    } finally {
      setIsPending(false);
    }
  };
  return { run, isPending };
}

/** 弹窗 props */
interface BrainReviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  taskId?: string;
  verdict: Verdict;
  reviewReason?: string;
  originalDraft?: string;
  finalResponse: string;
}

export function BrainReviewModal({
  isOpen,
  onClose,
  sessionId,
  taskId,
  verdict,
  reviewReason,
  originalDraft,
  finalResponse,
}: BrainReviewModalProps) {
  const t = useT();
  const cfg = VERDICT_CFG[verdict];

  /** Diff 区域是否展开（modify 时默认展开） */
  const [showDiff, setShowDiff] = useState(verdict === "modify");
  /** 反馈输入区域是否展开 */
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  /** 还原 / 反馈两个异步操作（各自独立的 pending 态，由 useAsyncAction 统一管理） */
  const restoreAction = useAsyncAction("还原失败:");
  const submitAction = useAsyncAction("提交反馈失败:");
  /** 还原是否已成功（决定显示成功提示、隐藏还原/反馈按钮） */
  const [restored, setRestored] = useState(false);

  /** 还原 Brain 修改（pending 态与错误日志由 useAsyncAction 统一） */
  function handleRestore() {
    if (!originalDraft) return;
    void restoreAction.run(async () => {
      await apiPost("/brain/restore-original", {
        sessionId,
        taskId: taskId ?? "",
        originalResponse: originalDraft,
      });
      setRestored(true);
    });
  }

  /** 提交反馈（pending 态与错误日志由 useAsyncAction 统一） */
  function handleSubmitFeedback() {
    void submitAction.run(async () => {
      await apiPost("/brain/feedback", {
        sessionId,
        taskId: taskId ?? "",
        type: verdict === "modify" ? "brain_modify_wrong" : "brain_reject_wrong",
        originalResponse: originalDraft ?? "",
        modifiedResponse: finalResponse,
        userComment: feedbackText,
      });
      setShowFeedback(false);
      setFeedbackText("");
    });
  }

  /** 是否可显示反馈按钮 */
  const canFeedback = (verdict === "modify" || verdict === "reject") && !showFeedback && !restored;
  /** 是否可显示还原按钮 */
  const canRestore = verdict === "modify" && !!originalDraft && !restored;

  return (
    <Dialog open={isOpen} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        {/* 头部：裁决图标 + 标题 + 裁决 badge */}
        <DialogHeader>
          <div className="flex items-center gap-2">
            {cfg.icon}
            <DialogTitle>{t("brain.reviewTitle")}</DialogTitle>
            <Badge variant={cfg.badge}>{t(cfg.labelKey)}</Badge>
          </div>
        </DialogHeader>

        {/* 审核理由 */}
        {reviewReason && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{t("brain.reason")}</p>
            <DialogDescription className="text-[13px]">{reviewReason}</DialogDescription>
          </div>
        )}

        {/* Diff 对比（仅 modify） */}
        {verdict === "modify" && originalDraft && (
          <DiffSection
            originalDraft={originalDraft}
            finalResponse={finalResponse}
            open={showDiff}
            onToggle={() => setShowDiff(!showDiff)}
          />
        )}

        {/* 被拦截内容（仅 reject） */}
        {verdict === "reject" && (
          <div className="border-t border-border pt-3">
            <ContentBlock
              label={t("brain.rejectedContent")}
              content={originalDraft ?? finalResponse}
              tone="destructive"
            />
          </div>
        )}

        {/* 反馈输入区域 */}
        {showFeedback && (
          <div className="space-y-2 border-t border-border pt-3">
            <TextAreaField
              rows={3}
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              placeholder={t("brain.feedbackPlaceholder")}
              className="text-[13px]"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowFeedback(false)}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={handleSubmitFeedback} disabled={submitAction.isPending}>
                {submitAction.isPending ? "…" : t("brain.submitFeedback")}
              </Button>
            </div>
          </div>
        )}

        {/* 底部操作栏 */}
        <DialogFooter className="border-t border-border pt-3">
          {canFeedback && (
            <Button variant="ghost" size="sm" className="mr-auto" onClick={() => setShowFeedback(true)}>
              <MessageCircle className="size-3" />
              {t("brain.feedback")}
            </Button>
          )}
          {canRestore && (
            <Button variant="outline" size="sm" onClick={handleRestore} disabled={restoreAction.isPending}>
              <RotateCcw className="size-3" />
              {restoreAction.isPending ? "…" : t("brain.restore")}
            </Button>
          )}
          {restored && <span className="text-xs text-success">{t("brain.restoreSuccess")}</span>}
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── 辅助组件 ──────────────────────────────────────────────────────

/** 带色调的内容展示块（diff / 被拦截内容复用） */
function ContentBlock({ label, content, tone }: {
  label: string;
  content: string;
  /** 色调：destructive 红色 / success 绿色 */
  tone: "destructive" | "success";
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] text-muted-foreground">{label}</p>
      <div
        className={`max-h-[150px] overflow-y-auto whitespace-pre-wrap rounded border p-2 text-xs text-foreground ${TONE_STYLE[tone]}`}
      >
        {content}
      </div>
    </div>
  );
}

/** Diff 对比区域（原始 vs 修改后，可折叠） */
function DiffSection({ originalDraft, finalResponse, open, onToggle }: {
  originalDraft: string;
  finalResponse: string;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();

  return (
    <div className="border-t border-border pt-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <span>{t("brain.diffToggle")}</span>
        {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <ContentBlock label={t("brain.original")} content={originalDraft} tone="destructive" />
          <ContentBlock label={t("brain.modifiedLabel")} content={finalResponse} tone="success" />
        </div>
      )}
    </div>
  );
}

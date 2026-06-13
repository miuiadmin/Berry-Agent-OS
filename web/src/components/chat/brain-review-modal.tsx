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
  /** 异步操作状态 */
  const [restoring, setRestoring] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [restored, setRestored] = useState(false);

  /** 还原 Brain 修改 */
  async function handleRestore() {
    if (!originalDraft || restoring) return;
    setRestoring(true);
    try {
      await apiPost("/brain/restore-original", {
        sessionId,
        taskId: taskId ?? "",
        originalResponse: originalDraft,
      });
      setRestored(true);
    } catch (err) {
      console.error("还原失败:", err);
    } finally {
      setRestoring(false);
    }
  }

  /** 提交反馈 */
  async function handleSubmitFeedback() {
    if (submitting) return;
    setSubmitting(true);
    try {
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
    } catch (err) {
      console.error("提交反馈失败:", err);
    } finally {
      setSubmitting(false);
    }
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
              <Button size="sm" onClick={handleSubmitFeedback} disabled={submitting}>
                {submitting ? "…" : t("brain.submitFeedback")}
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
            <Button variant="outline" size="sm" onClick={handleRestore} disabled={restoring}>
              <RotateCcw className="size-3" />
              {restoring ? "…" : t("brain.restore")}
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

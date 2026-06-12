/**
 * 13.0 灵魂版 Brain 审核详情弹窗。
 *
 * 展示 Brain 审核结果：
 *   - 原始回复 vs 修改后回复的 diff 对比
 *   - "还原 Brain 修改"按钮（§5.3.12）
 *   - "反馈 Brain 修改有问题"按钮（§5.3.4）
 *
 * 触发：点击消息上的 Brain 审核 badge
 *
 * 基于 Dialog adapter（HeroUI Modal compound）实现，遮罩/ESC/聚焦陷阱原生处理，
 * 配色全部走语义 token（亮/暗双主题正确）。
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Brain 审核裁决类型 */
type Verdict = "approve" | "modify" | "reject";

/** 弹窗 props */
interface BrainReviewModalProps {
  /** 是否显示 */
  isOpen: boolean;
  /** 关闭弹窗 */
  onClose: () => void;
  /** 当前 session ID */
  sessionId: string;
  /** 任务 ID */
  taskId?: string;
  /** 审核裁决 */
  verdict: Verdict;
  /** Brain 审核理由 */
  reviewReason?: string;
  /** 原始草稿（Brain 修改前的回复） */
  originalDraft?: string;
  /** 最终回复（Brain 修改后的回复） */
  finalResponse: string;
}

/** 裁决 → 图标 + 颜色 */
function VerdictIcon({ verdict }: { verdict: Verdict }) {
  if (verdict === "approve") return <ShieldCheck className="size-5 text-success" />;
  if (verdict === "modify") return <Shield className="size-5 text-warning" />;
  return <ShieldAlert className="size-5 text-danger" />;
}

/** 裁决 → 标签文本 */
function verdictLabel(verdict: Verdict, t: (key: string) => string): string {
  if (verdict === "approve") return t("brain.approved");
  if (verdict === "modify") return t("brain.modified");
  return t("brain.rejected");
}

/** 裁决 → 标签 className（语义 token，亮/暗双主题） */
function verdictBadgeClass(verdict: Verdict): string {
  if (verdict === "approve") return "bg-success/10 text-success";
  if (verdict === "modify") return "bg-warning/10 text-warning";
  return "bg-danger/10 text-danger";
}

/** 内容滚动容器样式（diff / 拦截内容） */
const SCROLL_BOX = "rounded-md p-2 text-xs max-h-[150px] overflow-y-auto whitespace-pre-wrap";

/**
 * Brain 审核详情弹窗。
 */
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
  const [isRestoring, setIsRestoring] = useState(false);
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);
  const [showDiff, setShowDiff] = useState(verdict === "modify");
  const [restoreSuccess, setRestoreSuccess] = useState(false);

  /** 还原 Brain 修改（§5.3.12） */
  async function handleRestore() {
    if (!originalDraft || isRestoring) return;
    setIsRestoring(true);
    try {
      await apiPost("/brain/restore-original", {
        sessionId,
        taskId: taskId ?? "",
        originalResponse: originalDraft,
      });
      setRestoreSuccess(true);
    } catch (err) {
      console.error("Failed to restore original:", err);
    } finally {
      setIsRestoring(false);
    }
  }

  /** 提交反馈（§5.3.4） */
  async function handleSubmitFeedback() {
    if (isSubmittingFeedback) return;
    setIsSubmittingFeedback(true);
    try {
      await apiPost("/brain/feedback", {
        sessionId,
        taskId: taskId ?? "",
        type: verdict === "modify" ? "brain_modify_wrong" : "brain_reject_wrong",
        originalResponse: originalDraft ?? "",
        modifiedResponse: finalResponse,
        userComment: feedbackComment,
      });
      setShowFeedback(false);
      setFeedbackComment("");
    } catch (err) {
      console.error("Failed to submit feedback:", err);
    } finally {
      setIsSubmittingFeedback(false);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        {/* 头部 */}
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <VerdictIcon verdict={verdict} />
            <span>{t("brain.reviewTitle")}</span>
            <span className={cn("text-xs px-2 py-0.5 rounded-full", verdictBadgeClass(verdict))}>
              {verdictLabel(verdict, t)}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto px-6 pb-2">
          {/* 审核理由 */}
          {reviewReason && (
            <div className="pb-3 border-b border-border">
              <p className="text-xs text-muted-foreground mb-1">{t("brain.reason")}</p>
              <p className="text-sm text-foreground">{reviewReason}</p>
            </div>
          )}

          {/* Diff 对比（仅 modify 时展示） */}
          {verdict === "modify" && originalDraft && (
            <div className="border-b border-border">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDiff(!showDiff)}
                className="w-full flex items-center justify-between py-2 min-h-0 h-auto"
              >
                <span className="text-xs text-muted-foreground">{t("brain.diffToggle")}</span>
                {showDiff ? <ChevronUp className="size-3 text-muted-foreground" /> : <ChevronDown className="size-3 text-muted-foreground" />}
              </Button>
              {showDiff && (
                <div className="pb-3 space-y-2">
                  <div>
                    <p className="text-[11px] text-muted-foreground mb-1">{t("brain.original")}</p>
                    <div className={cn(SCROLL_BOX, "bg-danger/5 border border-danger/20 text-foreground")}>{originalDraft}</div>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground mb-1">{t("brain.modified")}</p>
                    <div className={cn(SCROLL_BOX, "bg-success/5 border border-success/20 text-foreground")}>{finalResponse}</div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* reject 时展示被拦截的内容 */}
          {verdict === "reject" && (
            <div className="py-3 border-b border-border">
              <p className="text-xs text-muted-foreground mb-1">{t("brain.rejectedContent")}</p>
              <div className={cn(SCROLL_BOX, "bg-danger/5 border border-danger/20 text-foreground")}>{originalDraft ?? finalResponse}</div>
            </div>
          )}

          {/* 反馈区域 */}
          {showFeedback && (
            <div className="py-3 border-b border-border">
              <textarea
                value={feedbackComment}
                onChange={(e) => setFeedbackComment(e.target.value)}
                placeholder={t("brain.feedbackPlaceholder")}
                className="w-full h-20 rounded-md border border-input bg-background p-2 text-sm resize-none focus:outline-none focus:border-ring"
              />
              <div className="flex justify-end gap-2 mt-2">
                <Button variant="ghost" size="sm" onClick={() => setShowFeedback(false)}>
                  {t("common.cancel")}
                </Button>
                <Button variant="primary" size="sm" onClick={handleSubmitFeedback} disabled={isSubmittingFeedback}>
                  {isSubmittingFeedback ? "…" : t("brain.submitFeedback")}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* 底部操作栏 */}
        <DialogFooter className="justify-between">
          <div className="flex items-center gap-2">
            {(verdict === "modify" || verdict === "reject") && !showFeedback && !restoreSuccess && (
              <Button variant="ghost" size="sm" onClick={() => setShowFeedback(true)}>
                <MessageCircle className="size-3" />
                {t("brain.feedback")}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {verdict === "modify" && originalDraft && !restoreSuccess && (
              <Button variant="outline" size="sm" onClick={handleRestore} disabled={isRestoring}>
                <RotateCcw className="size-3" />
                {isRestoring ? "…" : t("brain.restore")}
              </Button>
            )}
            {restoreSuccess && <span className="text-xs text-success">{t("brain.restoreSuccess")}</span>}
            <Button variant="primary" size="sm" onClick={onClose}>
              {t("common.close")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

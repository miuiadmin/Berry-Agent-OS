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
 * 实现复用 shadcn Dialog（base-nova）：遮罩 / 居中 / 关闭按钮 / 动画 / 主题 token
 * 均由 Dialog 组件提供，本组件只负责 Brain 审核特有的内容与交互。
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

/** Brain 审核裁决类型 */
type Verdict = "approve" | "modify" | "reject";

/** 裁决 → Badge 语义 variant（与项目 badge.tsx 的 success/warning/destructive 对应） */
type VerdictBadgeVariant = "success" | "warning" | "destructive";

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

/** 裁决 → 图标（语义色 success/warning/destructive） */
function VerdictIcon({ verdict }: { verdict: Verdict }) {
  if (verdict === "approve") return <ShieldCheck className="size-5 text-success" />;
  if (verdict === "modify") return <Shield className="size-5 text-warning" />;
  return <ShieldAlert className="size-5 text-destructive" />;
}

/** 裁决 → Badge variant */
function verdictBadgeVariant(verdict: Verdict): VerdictBadgeVariant {
  if (verdict === "approve") return "success";
  if (verdict === "modify") return "warning";
  return "destructive";
}

/** 裁决 → 标签文本 */
function verdictLabel(verdict: Verdict, t: (key: string) => string): string {
  if (verdict === "approve") return t("brain.approved");
  if (verdict === "modify") return t("brain.modified");
  return t("brain.rejected");
}

/**
 * Brain 审核详情弹窗。基于 shadcn Dialog，复用遮罩/居中/关闭/动画/主题。
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
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      {/* max-h + overflow 适配 diff/反馈长内容；sm:max-w-lg 覆盖默认 max-w-sm */}
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        {/* 头部：裁决图标 + 标题 + 裁决 badge（DialogContent 已自带关闭按钮） */}
        <DialogHeader>
          <div className="flex items-center gap-2">
            <VerdictIcon verdict={verdict} />
            <DialogTitle>{t("brain.reviewTitle")}</DialogTitle>
            <Badge variant={verdictBadgeVariant(verdict)}>{verdictLabel(verdict, t)}</Badge>
          </div>
        </DialogHeader>

        {/* 审核理由 */}
        {reviewReason && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{t("brain.reason")}</p>
            <DialogDescription className="text-[13px]">{reviewReason}</DialogDescription>
          </div>
        )}

        {/* Diff 对比（仅 modify 时展示） */}
        {verdict === "modify" && originalDraft && (
          <div className="border-t border-border pt-3">
            <button type="button"
              onClick={() => setShowDiff(!showDiff)}
              className="flex w-full items-center justify-between py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <span>{t("brain.diffToggle")}</span>
              {showDiff ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            </button>
            {showDiff && (
              <div className="mt-2 space-y-2">
                {/* 原始回复（被 Brain 修改前的版本） */}
                <div>
                  <p className="mb-1 text-[11px] text-muted-foreground">{t("brain.original")}</p>
                  <div className="max-h-[150px] overflow-y-auto whitespace-pre-wrap rounded border border-destructive/20 bg-destructive/5 p-2 text-xs text-foreground">
                    {originalDraft}
                  </div>
                </div>
                {/* 修改后回复（Brain 最终输出） */}
                <div>
                  <p className="mb-1 text-[11px] text-muted-foreground">{t("brain.modified")}</p>
                  <div className="max-h-[150px] overflow-y-auto whitespace-pre-wrap rounded border border-success/20 bg-success/5 p-2 text-xs text-foreground">
                    {finalResponse}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* reject 时展示被拦截的内容 */}
        {verdict === "reject" && (
          <div className="space-y-1 border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">{t("brain.rejectedContent")}</p>
            <div className="max-h-[150px] overflow-y-auto whitespace-pre-wrap rounded border border-destructive/20 bg-destructive/5 p-2 text-xs text-foreground">
              {originalDraft ?? finalResponse}
            </div>
          </div>
        )}

        {/* 反馈区域（展开时显示） */}
        {showFeedback && (
          <div className="space-y-2 border-t border-border pt-3">
            <textarea
              value={feedbackComment}
              onChange={(e) => setFeedbackComment(e.target.value)}
              placeholder={t("brain.feedbackPlaceholder")}
              className="h-20 w-full resize-none rounded-lg border border-input bg-transparent p-2 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowFeedback(false)}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={handleSubmitFeedback} disabled={isSubmittingFeedback}>
                {isSubmittingFeedback ? "…" : t("brain.submitFeedback")}
              </Button>
            </div>
          </div>
        )}

        {/* 底部操作栏 */}
        <DialogFooter className="border-t border-border pt-3">
          {/* 反馈入口（modify/reject 且未展开反馈、未还原成功时显示） */}
          {(verdict === "modify" || verdict === "reject") && !showFeedback && !restoreSuccess && (
            <Button variant="ghost" size="sm" className="mr-auto" onClick={() => setShowFeedback(true)}>
              <MessageCircle className="size-3" />
              {t("brain.feedback")}
            </Button>
          )}
          {/* 还原入口（仅 modify + 有原始草稿 + 未成功时） */}
          {verdict === "modify" && originalDraft && !restoreSuccess && (
            <Button variant="outline" size="sm" onClick={handleRestore} disabled={isRestoring}>
              <RotateCcw className="size-3" />
              {isRestoring ? "…" : t("brain.restore")}
            </Button>
          )}
          {restoreSuccess && (
            <span className="text-xs text-success">{t("brain.restoreSuccess")}</span>
          )}
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 13.0 灵魂版 Brain 审核详情弹窗。
 *
 * 展示 Brain 审核结果：
 *   - 原始回复 vs 修改后回复的 diff 对比
 *   - "还原 Brain 修改"按钮（§5.3.12）
 *   - "反馈 Brain 修改有问题"按钮（§5.3.4）
 *
 * 触发：点击消息上的 Brain 审核 badge
 */

import { useState } from "react";
import { useT } from "@/lib/i18n";
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  RotateCcw,
  MessageCircle,
  X,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { apiPost } from "@/lib/api";

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
  if (verdict === "approve") {
    return <ShieldCheck className="w-5 h-5 text-green-400" />;
  }
  if (verdict === "modify") {
    return <Shield className="w-5 h-5 text-yellow-400" />;
  }
  return <ShieldAlert className="w-5 h-5 text-red-400" />;
}

/** 裁决 → 标签文本 */
function verdictLabel(verdict: Verdict, t: (key: string) => string): string {
  if (verdict === "approve") return t("brain.approved");
  if (verdict === "modify") return t("brain.modified");
  return t("brain.rejected");
}

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

  if (!isOpen) return null;

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <VerdictIcon verdict={verdict} />
            <span className="font-medium text-zinc-100">
              {t("brain.reviewTitle")}
            </span>
            <span className={`text-[12px] px-2 py-0.5 rounded-full ${
              verdict === "approve" ? "bg-green-500/10 text-green-400" :
              verdict === "modify" ? "bg-yellow-500/10 text-yellow-400" :
              "bg-red-500/10 text-red-400"
            }`}>
              {verdictLabel(verdict, t)}
            </span>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-zinc-800 rounded">
            <X className="w-4 h-4 text-zinc-500" />
          </button>
        </div>

        {/* 审核理由 */}
        {reviewReason && (
          <div className="px-4 py-2 border-b border-zinc-800">
            <p className="text-[12px] text-zinc-500 mb-1">
              {t("brain.reason")}
            </p>
            <p className="text-[13px] text-zinc-300">{reviewReason}</p>
          </div>
        )}

        {/* Diff 对比（仅 modify 时展示） */}
        {verdict === "modify" && originalDraft && (
          <div className="border-b border-zinc-800">
            <button
              onClick={() => setShowDiff(!showDiff)}
              className="w-full flex items-center justify-between px-4 py-2 hover:bg-zinc-800/50"
            >
              <span className="text-[12px] text-zinc-500">
                {t("brain.diffToggle")}
              </span>
              {showDiff ? (
                <ChevronUp className="w-3 h-3 text-zinc-500" />
              ) : (
                <ChevronDown className="w-3 h-3 text-zinc-500" />
              )}
            </button>
            {showDiff && (
              <div className="px-4 pb-3 space-y-2">
                {/* 原始回复 */}
                <div>
                  <p className="text-[11px] text-zinc-600 mb-1">
                    {t("brain.original")}
                  </p>
                  <div className="bg-red-500/5 border border-red-500/20 rounded p-2 text-[12px] text-zinc-400 max-h-[150px] overflow-y-auto whitespace-pre-wrap">
                    {originalDraft}
                  </div>
                </div>
                {/* 修改后回复 */}
                <div>
                  <p className="text-[11px] text-zinc-600 mb-1">
                    {t("brain.modified")}
                  </p>
                  <div className="bg-green-500/5 border border-green-500/20 rounded p-2 text-[12px] text-zinc-400 max-h-[150px] overflow-y-auto whitespace-pre-wrap">
                    {finalResponse}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* reject 时展示被拦截的内容 */}
        {verdict === "reject" && (
          <div className="px-4 py-3 border-b border-zinc-800">
            <p className="text-[12px] text-zinc-500 mb-1">
              {t("brain.rejectedContent")}
            </p>
            <div className="bg-red-500/5 border border-red-500/20 rounded p-2 text-[12px] text-zinc-400 max-h-[150px] overflow-y-auto whitespace-pre-wrap">
              {originalDraft ?? finalResponse}
            </div>
          </div>
        )}

        {/* 反馈区域 */}
        {showFeedback && (
          <div className="px-4 py-3 border-b border-zinc-800">
            <textarea
              value={feedbackComment}
              onChange={(e) => setFeedbackComment(e.target.value)}
              placeholder={t("brain.feedbackPlaceholder")}
              className="w-full h-20 bg-zinc-800 border border-zinc-700 rounded-lg p-2 text-[13px] text-zinc-300 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <div className="flex justify-end gap-2 mt-2">
              <button
                onClick={() => setShowFeedback(false)}
                className="px-3 py-1.5 text-[12px] text-zinc-400 hover:text-zinc-300"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleSubmitFeedback}
                disabled={isSubmittingFeedback}
                className="px-3 py-1.5 text-[12px] bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50"
              >
                {isSubmittingFeedback ? "…" : t("brain.submitFeedback")}
              </button>
            </div>
          </div>
        )}

        {/* 底部操作栏 */}
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            {(verdict === "modify" || verdict === "reject") && !showFeedback && !restoreSuccess && (
              <button
                onClick={() => setShowFeedback(true)}
                className="flex items-center gap-1 px-2 py-1 text-[12px] text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800 rounded"
              >
                <MessageCircle className="w-3 h-3" />
                {t("brain.feedback")}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* 还原按钮（仅 modify + 有原始草稿时） */}
            {verdict === "modify" && originalDraft && !restoreSuccess && (
              <button
                onClick={handleRestore}
                disabled={isRestoring}
                className="flex items-center gap-1 px-3 py-1.5 text-[12px] bg-yellow-600/20 text-yellow-400 rounded hover:bg-yellow-600/30 disabled:opacity-50"
              >
                <RotateCcw className="w-3 h-3" />
                {isRestoring ? "…" : t("brain.restore")}
              </button>
            )}
            {restoreSuccess && (
              <span className="text-[12px] text-green-400">
                {t("brain.restoreSuccess")}
              </span>
            )}
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-[12px] bg-zinc-700 text-zinc-300 rounded hover:bg-zinc-600"
            >
              {t("common.close")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

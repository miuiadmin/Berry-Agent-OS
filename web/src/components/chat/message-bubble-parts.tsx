/**
 * 消息气泡的辅助子组件。
 *
 * 从 chat-message-list.tsx 拆出，让 MessageBubble 主组件只保留编排逻辑。
 * CopyButton 已提取到 ui/copy-button.tsx（与 code-block 共享），此处 re-export。
 */

import { useState, useRef, useEffect } from "react";
import { X, SendHorizontal, AlertCircle, RotateCcw, Pencil, Trash2, FileText, Download } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { ClickableImage } from "@/components/ui/image-lightbox";
import { TextAreaField } from "@/components/ui/text-area-field";
import type { ChatMessage, ChatAttachment } from "@/lib/stores/chat-store";

// ─── CopyButton 已提取到 ui/copy-button.tsx（与 code-block 共享） ───

export { CopyButton } from "@/components/ui/copy-button";

/** Brain 审核标注视觉配置（消除 verdict 三元重复） */
const REVIEW_CFG: Record<"modify" | "reject", { style: string; icon: LucideIcon; labelKey: string }> = {
  modify: { style: "bg-warning/10 text-warning", icon: Pencil, labelKey: "chat.brainModified" },
  reject: { style: "bg-destructive/10 text-destructive", icon: AlertCircle, labelKey: "chat.brainRejected" },
};

// ─── EditableMessage ──────────────────────────────────────────────

/**
 * 用户消息编辑态：textarea 自适应高度，Enter 提交 / Esc 取消。
 * 使用 TextAreaField 统一样式（移动端 16px 防 iOS 自动缩放）。
 */
export function EditableMessage({
  message,
  onSubmit,
  onCancel,
}: {
  message: ChatMessage;
  onSubmit: (content: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(message.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const t = useT();

  /** 挂载后聚焦并自适应高度 */
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }, []);

  /** 输入时同步内容并自适应高度 */
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = e.target.scrollHeight + "px";
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const trimmed = text.trim();
      if (trimmed) onSubmit(trimmed);
    }
    if (e.key === "Escape") onCancel();
  };

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed) onSubmit(trimmed);
  };

  return (
    <div className="flex max-w-[90%] flex-col gap-2 sm:max-w-[80%]">
      <TextAreaField
        ref={textareaRef}
        rows={1}
        value={text}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        className="resize-none rounded-xl border border-input bg-muted/50 px-4 py-2.5 leading-relaxed outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
      />
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel}
          className="inline-flex min-h-[44px] items-center gap-1 rounded-md px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent md:min-h-0 md:px-2 md:py-1">
          <X className="size-3" />
          {t("common.cancel")}
        </button>
        <button type="button" onClick={submit} disabled={!text.trim()}
          className="inline-flex min-h-[44px] items-center gap-1 rounded-md bg-brand px-3 py-2 text-xs text-brand-foreground transition-colors hover:bg-brand/90 disabled:opacity-50 md:min-h-0 md:px-2 md:py-1">
          <SendHorizontal className="size-3" />
          {t("chat.send")}
        </button>
      </div>
    </div>
  );
}

// ─── MessageError ─────────────────────────────────────────────────

/**
 * 消息错误 / 失败提示 + 重试按钮。
 * 统一 isError（destructive）与 isUserFailed（warning）两种场景。
 */
export function MessageError({
  message,
  onRetry,
  variant,
}: {
  message: string;
  onRetry?: () => void;
  variant: "destructive" | "warning";
}) {
  const t = useT();
  return (
    <div className={cn("mt-2 space-y-1 text-xs", variant === "destructive" ? "text-destructive" : "text-warning")}>
      <div className="flex items-center gap-1.5">
        <AlertCircle className="size-3 shrink-0" />
        <span>{message}</span>
      </div>
      {onRetry && (
        <button type="button" onClick={onRetry}
          className="inline-flex items-center gap-0.5 underline hover:no-underline">
          <RotateCcw className="size-2.5" />
          {t("common.retry")}
        </button>
      )}
    </div>
  );
}

// ─── BrainReviewBadge ─────────────────────────────────────────────

/** Brain 审核标注（modify / reject 时在助手消息下方展示） */
export function BrainReviewBadge({
  verdict,
  reason,
}: {
  verdict: "modify" | "reject";
  reason?: string;
}) {
  const t = useT();
  const cfg = REVIEW_CFG[verdict];
  const Icon = cfg.icon;
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
      <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5", cfg.style)}>
        <Icon className="size-2.5" />
        {t(cfg.labelKey)}
      </span>
      {reason && (
        <span className="max-w-[200px] truncate text-muted-foreground/70" title={reason}>{reason}</span>
      )}
    </div>
  );
}

// ─── MessageActions ───────────────────────────────────────────────

/** 单个图标操作按钮（编辑 / 删除复用，hover 色调可配置） */
function ActionButton({ icon: Icon, label, tone, onClick }: {
  icon: LucideIcon;
  label: string;
  /** default=中性灰 hover / destructive=红色 hover */
  tone: "default" | "destructive";
  onClick: () => void;
}) {
  const hover = tone === "destructive"
    ? "hover:bg-destructive/10 hover:text-destructive active:bg-destructive/10"
    : "hover:bg-accent hover:text-accent-foreground active:bg-accent";
  return (
    <button type="button" onClick={onClick}
      className={cn("inline-flex items-center rounded-md p-2.5 text-muted-foreground transition-colors md:p-1", hover)}
      aria-label={label}>
      <Icon className="size-3" />
    </button>
  );
}

/** 消息下方操作按钮组（复制 / 编辑 / 删除），移动端始终可见，桌面端 hover 显示 */
export function MessageActions({
  copyText,
  isUser,
  onEdit,
  onDelete,
}: {
  copyText: string;
  isUser: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 [@media(hover:none)]:opacity-100">
      <CopyButton text={copyText} />
      {isUser && onEdit && <ActionButton icon={Pencil} label={t("chat.editMessage")} tone="default" onClick={onEdit} />}
      {isUser && onDelete && <ActionButton icon={Trash2} label={t("chat.deleteMessage")} tone="destructive" onClick={onDelete} />}
    </div>
  );
}

// ─── AttachmentList ───────────────────────────────────────────────

/** 消息附件列表：图片用 ClickableImage，其他用下载链接 */
export function AttachmentList({ attachments }: { attachments: ChatAttachment[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {attachments.map((att) =>
        att.mimeType.startsWith("image/") ? (
          <ClickableImage key={att.fileId} src={att.url} alt={att.filename} className="max-h-48 rounded-lg animate-slide-down" />
        ) : (
          <a key={att.fileId} href={att.url} download={att.filename}
            className="flex items-center gap-2 rounded-lg border border-border bg-background/50 px-3 py-2 text-xs transition-colors hover:bg-accent animate-slide-down"
            onClick={(e) => e.stopPropagation()}>
            <FileText className="size-4 text-muted-foreground" />
            <span className="max-w-[150px] truncate">{att.filename}</span>
            <Download className="size-3 text-muted-foreground" />
          </a>
        ),
      )}
    </div>
  );
}

/**
 * 消息气泡的辅助子组件。
 *
 * 从 chat-message-list.tsx 拆出，让 MessageBubble 主组件只保留编排逻辑。
 * 这些组件互相独立，CopyButton 被 MessageActions 内部复用。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, X, SendHorizontal, AlertCircle, RotateCcw, Pencil, Trash2, FileText, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { ClickableImage } from "@/components/ui/image-lightbox";
import type { ChatMessage, ChatAttachment } from "@/lib/stores/chat-store";

// ─── CopyButton ───────────────────────────────────────────────────

/**
 * 复制按钮：点击写入剪贴板，1.5s 内显示 ✓ 反馈。
 * 失败时静默（剪贴板被拒/非安全上下文）。
 */
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const t = useT();
  /** 反馈态定时器引用，卸载时清除 */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      // clipboard access denied or insecure context
    });
  }, [text]);

  return (
    <button type="button"
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1.5 md:px-1.5 md:py-0 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground active:bg-accent transition-colors min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0",
        className,
      )}
      aria-label={t("chat.copy")}
    >
      {copied ? <Check className="size-3 animate-fade-scale" /> : <Copy className="size-3" />}
    </button>
  );
}

// ─── EditableMessage ──────────────────────────────────────────────

/**
 * 用户消息编辑态：textarea 自适应高度，Enter 提交 / Esc 取消。
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

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = textareaRef.current.scrollHeight + "px";
    }
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const trimmed = text.trim();
      if (trimmed) onSubmit(trimmed);
    }
    if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <div className="flex max-w-[90%] flex-col gap-2 sm:max-w-[80%]">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = e.target.scrollHeight + "px";
        }}
        onKeyDown={handleKeyDown}
        className="resize-none rounded-xl border border-input bg-muted/50 px-4 py-2.5 text-sm leading-relaxed outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
        rows={1}
      />
      <div className="flex items-center justify-end gap-2">
        <button type="button"
          onClick={onCancel}
          className="inline-flex min-h-[44px] items-center gap-1 rounded-md px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent md:min-h-0 md:px-2 md:py-1"
        >
          <X className="size-3" />
          {t("common.cancel")}
        </button>
        <button type="button"
          onClick={() => {
            const trimmed = text.trim();
            if (trimmed) onSubmit(trimmed);
          }}
          disabled={!text.trim()}
          className="inline-flex min-h-[44px] items-center gap-1 rounded-md bg-brand px-3 py-2 text-xs text-brand-foreground transition-colors hover:bg-brand/90 disabled:opacity-50 md:min-h-0 md:px-2 md:py-1"
        >
          <SendHorizontal className="size-3" />
          {t("chat.send")}
        </button>
      </div>
    </div>
  );
}

// ─── MessageError ─────────────────────────────────────────────────

/**
 * 消息错误/失败提示 + 重试按钮。
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
  const color = variant === "destructive" ? "text-destructive" : "text-warning";
  return (
    <div className={cn("mt-2 space-y-1 text-xs", color)}>
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

/**
 * Brain 审核标注（modify/reject 时在助手消息下方展示）。
 */
export function BrainReviewBadge({
  verdict,
  reason,
}: {
  verdict: "modify" | "reject";
  reason?: string;
}) {
  const t = useT();
  const isModify = verdict === "modify";
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
      <span className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
        isModify ? "bg-warning/10 text-warning" : "bg-destructive/10 text-destructive",
      )}>
        {isModify ? <Pencil className="size-2.5" /> : <AlertCircle className="size-2.5" />}
        {isModify ? t("chat.brainModified") : t("chat.brainRejected")}
      </span>
      {reason && (
        <span className="max-w-[200px] truncate text-muted-foreground/70" title={reason}>
          {reason}
        </span>
      )}
    </div>
  );
}

// ─── MessageActions ───────────────────────────────────────────────

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
      {isUser && onEdit && (
        <button type="button" onClick={onEdit}
          className="inline-flex items-center rounded-md p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground active:bg-accent md:p-1"
          aria-label={t("chat.editMessage")}>
          <Pencil className="size-3" />
        </button>
      )}
      {isUser && onDelete && (
        <button type="button" onClick={onDelete}
          className="inline-flex items-center rounded-md p-2.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive active:bg-destructive/10 md:p-1"
          aria-label={t("chat.deleteMessage")}>
          <Trash2 className="size-3" />
        </button>
      )}
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
          <ClickableImage
            key={att.fileId}
            src={att.url}
            alt={att.filename}
            className="max-h-48 rounded-lg animate-slide-down"
          />
        ) : (
          <a
            key={att.fileId}
            href={att.url}
            download={att.filename}
            className="flex items-center gap-2 rounded-lg border border-border bg-background/50 px-3 py-2 text-xs hover:bg-accent transition-colors animate-slide-down"
            onClick={(e) => e.stopPropagation()}
          >
            <FileText className="size-4 text-muted-foreground" />
            <span className="max-w-[150px] truncate">{att.filename}</span>
            <Download className="size-3 text-muted-foreground" />
          </a>
        ),
      )}
    </div>
  );
}

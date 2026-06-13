/**
 * 聊天输入框组件。
 *
 * 底部固定的输入区域：textarea + 附件管理 + 工具栏（上传/图片/设置/停止） + 发送按钮。
 * 自适应高度（最大 300px），超过 500 字符时显示字数统计。
 * Enter 发送 / Shift+Enter 换行。
 */

import { useState, useRef, useMemo } from "react";
import { Square, ImagePlus, Settings } from "lucide-react";
import { useChatStore } from "@/lib/stores/chat-store";
import { FileUploadButton, AttachmentPreview, type Attachment } from "@/components/chat/file-upload";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";

/** textarea 自适应高度上限 */
const MAX_HEIGHT = 300;

/** 工具栏按钮 */
function ToolbarButton({
  children, onClick, disabled, variant, "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "destructive";
  "aria-label"?: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel}
      className={cn(
        "inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg p-2 transition-all duration-150 active:scale-90 md:min-h-0 md:min-w-0 md:p-1.5",
        variant === "destructive"
          ? "text-destructive hover:bg-destructive/10 active:bg-destructive/20"
          : "text-muted-foreground hover:bg-accent hover:text-foreground active:bg-accent",
        "disabled:pointer-events-none disabled:opacity-40",
      )}>
      {children}
    </button>
  );
}

interface ChatInputProps {
  onSend: (text: string, attachments?: Attachment[]) => void;
  onCancel?: () => void;
  externalAttachments?: Attachment[];
  disabled?: boolean;
}

export function ChatInput({ onSend, onCancel, externalAttachments, disabled }: ChatInputProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const t = useT();

  /** 合并内部 + 外部拖拽附件 */
  const allAttachments = useMemo(
    () => [...attachments, ...(externalAttachments ?? [])],
    [attachments, externalAttachments],
  );
  /** 是否可发送（有内容且未禁用） */
  const canSend = text.trim().length > 0 || allAttachments.length > 0;
  /** 发送按钮禁用条件（与 className 的可用条件互为反义，统一计算） */
  const sendDisabled = !canSend || isStreaming || disabled;

  /** 提交发送 */
  const handleSubmit = () => {
    if (disabled) { toast.error(t("chat.notConnected")); return; }
    const trimmed = text.trim();
    if ((!trimmed && allAttachments.length === 0) || isStreaming) return;
    onSend(trimmed, allAttachments.length > 0 ? allAttachments : undefined);
    setText("");
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  /** 输入时同步内容并自适应高度（封顶 MAX_HEIGHT） */
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, MAX_HEIGHT)}px`;
  };

  return (
    <div className="border-t border-border bg-background p-3 md:p-4">
      <div className="mx-auto max-w-3xl">
        <div className="input-focus-glow overflow-hidden rounded-2xl border border-input bg-muted/50 transition-all duration-200">
          {/* 附件预览 */}
          {allAttachments.length > 0 && (
            <AttachmentPreview
              attachments={allAttachments}
              onRemove={(fileId) => setAttachments((prev) => prev.filter((a) => a.fileId !== fileId))}
            />
          )}

          {/* 文本输入 */}
          <div className="relative">
            <textarea ref={textareaRef} value={text} onChange={handleInput} onKeyDown={handleKeyDown}
              placeholder={t("chat.typePlaceholder")} aria-label={t("chat.typePlaceholder")} rows={1}
              className="w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[16px] leading-relaxed outline-none placeholder:text-muted-foreground md:text-sm" />
            {text.length > 500 && (
              <span className="absolute bottom-2 right-3 text-[11px] text-muted-foreground/60">{text.length}</span>
            )}
          </div>

          {/* 工具栏 */}
          <div className="flex items-center justify-between px-2 pb-2 pt-1">
            <div className="flex items-center gap-0.5">
              <FileUploadButton onAttach={(a) => setAttachments((prev) => [...prev, a])} disabled={isStreaming} />
              <ToolbarButton disabled aria-label={t("chat.uploadImage")}>
                <ImagePlus className="size-4" />
              </ToolbarButton>
              <ToolbarButton disabled aria-label={t("chat.settings")}>
                <Settings className="size-4" />
              </ToolbarButton>
              {isStreaming && (
                <ToolbarButton onClick={onCancel} variant="destructive" aria-label={t("chat.stopGeneration")}>
                  <Square className="size-3.5 fill-current" />
                </ToolbarButton>
              )}
            </div>
            {/* 发送按钮 */}
            <button type="button" onClick={handleSubmit} disabled={sendDisabled}
              className={cn(
                "btn-press min-h-[44px] rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 md:min-h-0 md:px-3 md:py-1.5 md:text-xs",
                sendDisabled
                  ? "cursor-not-allowed bg-muted text-muted-foreground"
                  : "bg-foreground text-background hover:bg-foreground/90 active:scale-[0.97] active:bg-foreground/80 animate-send-ready",
              )}>
              {t("chat.send")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

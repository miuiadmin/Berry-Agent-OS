
import { useState, useRef, useCallback, useMemo } from "react";
import { SendHorizontal, Square, Paperclip, ImagePlus, Settings } from "lucide-react";
import { useChatStore } from "@/lib/stores/chat-store";
import { FileUploadButton, AttachmentPreview, type Attachment } from "@/components/chat/file-upload";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";

interface ChatInputProps {
  onSend: (text: string, attachments?: Attachment[]) => void;
  onCancel?: () => void;
  externalAttachments?: Attachment[];
  disabled?: boolean;
}

export function ChatInput({ onSend, onCancel, externalAttachments, disabled }: ChatInputProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** textarea ref，用于控制自动高度调整 */
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const t = useT();

  const allAttachments = useMemo(
    () => [...attachments, ...(externalAttachments ?? [])],
    [attachments, externalAttachments],
  );

  const canSend = text.trim().length > 0 || allAttachments.length > 0;

  const handleSubmit = useCallback(() => {
    if (disabled) {
      toast.error(t("chat.notConnected"));
      return;
    }
    const trimmed = text.trim();
    if ((!trimmed && allAttachments.length === 0) || isStreaming) return;
    onSend(trimmed, allAttachments.length > 0 ? allAttachments : undefined);
    setText("");
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, allAttachments, isStreaming, onSend, disabled]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    /** 自动调整高度：先重置，再按 scrollHeight 设置，上限 300px */
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 300) + "px";
  };

  const handleAttach = useCallback((a: Attachment) => {
    setAttachments((prev) => [...prev, a]);
  }, []);

  const handleRemoveAttachment = useCallback((fileId: string) => {
    setAttachments((prev) => prev.filter((a) => a.fileId !== fileId));
  }, []);

  const charCount = text.length;

  return (
    <div className="border-t border-border bg-background p-3 md:p-4">
      <div className="mx-auto max-w-3xl">
        {/* Single unified card */}
        <div className="rounded-2xl border border-input bg-muted/50 overflow-hidden transition-all duration-200 input-focus-glow">
          {/* Attachments */}
          {allAttachments.length > 0 && (
            <AttachmentPreview attachments={allAttachments} onRemove={handleRemoveAttachment} />
          )}
          {/* Text input — HeroUI TextArea adapter，自动调整高度 */}
          <div className="relative">
            <Textarea
              ref={textareaRef}
              value={text}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder={t("chat.typePlaceholder")}
              aria-label={t("chat.typePlaceholder")}
              rows={1}
              className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[16px] md:text-sm leading-relaxed outline-none border-0 focus:border-0 focus:ring-0"
            />
            {charCount > 500 && (
              <span className="absolute bottom-2 right-3 text-[11px] text-muted-foreground/60">
                {charCount}
              </span>
            )}
          </div>
          {/* Toolbar */}
          <div className="flex items-center justify-between px-2 pb-2 pt-1">
            <div className="flex items-center gap-0.5">
              <FileUploadButton onAttach={handleAttach} disabled={isStreaming} />
              <ToolbarButton disabled aria-disabled="true" aria-label={t("chat.uploadImage")}>
                <ImagePlus className="size-4" />
              </ToolbarButton>
              <ToolbarButton disabled aria-disabled="true" aria-label={t("chat.settings")}>
                <Settings className="size-4" />
              </ToolbarButton>
              {isStreaming && (
                <ToolbarButton onClick={onCancel} variant="destructive" aria-label={t("chat.stopGeneration")}>
                  <Square className="size-3.5 fill-current" />
                </ToolbarButton>
              )}
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSubmit}
              disabled={!canSend || isStreaming || disabled}
              className={cn(
                "btn-press",
                canSend && !isStreaming && !disabled && "animate-send-ready"
              )}
            >
              {t("chat.send")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  disabled,
  variant,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "destructive";
  "aria-label"?: string;
}) {
  return (
    <Button
      type="button"
      variant={variant === "destructive" ? "danger" : "ghost"}
      size="icon-sm"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      {children}
    </Button>
  );
}

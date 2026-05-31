"use client";

import { useState, useRef, useCallback, useMemo } from "react";
import { SendHorizontal, Square, Paperclip, ImagePlus, Settings } from "lucide-react";
import { useChatStore } from "@/lib/stores/chat-store";
import { FileUploadButton, AttachmentPreview, type Attachment } from "@/components/chat/file-upload";
import { cn } from "@/lib/utils";

interface ChatInputProps {
  onSend: (text: string, attachments?: Attachment[]) => void;
  onCancel?: () => void;
  externalAttachments?: Attachment[];
}

export function ChatInput({ onSend, onCancel, externalAttachments }: ChatInputProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const allAttachments = useMemo(
    () => [...attachments, ...(externalAttachments ?? [])],
    [attachments, externalAttachments],
  );

  const canSend = text.trim().length > 0 || allAttachments.length > 0;

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if ((!trimmed && allAttachments.length === 0) || isStreaming) return;
    onSend(trimmed, allAttachments.length > 0 ? allAttachments : undefined);
    setText("");
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, allAttachments, isStreaming, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
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
          {/* Text input */}
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              rows={1}
              className={cn(
                "w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-relaxed outline-none",
                "placeholder:text-muted-foreground"
              )}
            />
            {charCount > 500 && (
              <span className="absolute bottom-2 right-3 text-[10px] text-muted-foreground/60">
                {charCount}
              </span>
            )}
          </div>
          {/* Toolbar */}
          <div className="flex items-center justify-between px-2 pb-2 pt-1">
            <div className="flex items-center gap-0.5">
              <FileUploadButton onAttach={handleAttach} disabled={isStreaming} />
              <ToolbarButton disabled={isStreaming} aria-label="Upload image">
                <ImagePlus className="size-4" />
              </ToolbarButton>
              <ToolbarButton disabled={isStreaming} aria-label="Settings">
                <Settings className="size-4" />
              </ToolbarButton>
              {isStreaming && (
                <ToolbarButton onClick={onCancel} variant="destructive" aria-label="Stop generation">
                  <Square className="size-3.5 fill-current" />
                </ToolbarButton>
              )}
            </div>
            <button
              onClick={handleSubmit}
              disabled={!canSend || isStreaming}
              className={cn(
                "rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 btn-press",
                "min-h-[44px] md:min-h-0 md:px-3 md:py-1.5 md:text-xs",
                canSend && !isStreaming
                  ? "bg-foreground text-background hover:bg-foreground/90 active:bg-foreground/80 active:scale-[0.97] animate-send-ready"
                  : "bg-muted text-muted-foreground cursor-not-allowed"
              )}
            >
              Send
            </button>
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
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center justify-center rounded-lg p-2 md:p-1.5 transition-all duration-150 min-w-[36px] min-h-[36px] md:min-w-0 md:min-h-0 active:scale-90",
        variant === "destructive"
          ? "text-destructive hover:bg-destructive/10 active:bg-destructive/20"
          : "text-muted-foreground hover:bg-accent hover:text-foreground active:bg-accent",
        "disabled:opacity-40 disabled:pointer-events-none"
      )}
    >
      {children}
    </button>
  );
}

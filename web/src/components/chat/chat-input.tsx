"use client";

import { useState, useRef, useCallback, useMemo } from "react";
import { SendHorizontal, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
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
    <div className="border-t border-border bg-background pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] sm:pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
      <AttachmentPreview attachments={allAttachments} onRemove={handleRemoveAttachment} />
      <div className="p-3 sm:p-4 pt-2">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <FileUploadButton onAttach={handleAttach} disabled={isStreaming} />
          <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              rows={1}
              className={cn(
                "w-full resize-none rounded-xl border border-input bg-muted/50 px-4 py-2.5 text-sm leading-relaxed outline-none transition-colors",
                "placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30"
              )}
            />
            {charCount > 500 && (
              <span className="absolute bottom-2 right-3 text-[10px] text-muted-foreground/60">
                {charCount}
              </span>
            )}
          </div>
          {isStreaming ? (
            <Button
              size="icon"
              variant="destructive"
              onClick={onCancel}
              className="shrink-0 size-11 md:size-9"
            >
              <Square className="size-3 fill-current" />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={handleSubmit}
              disabled={!text.trim() && allAttachments.length === 0}
              className="shrink-0 size-11 md:size-9"
            >
              <SendHorizontal className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

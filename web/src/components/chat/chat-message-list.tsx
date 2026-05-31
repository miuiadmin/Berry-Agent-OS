"use client";

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { useChatStore, type ChatMessage, type ChatAttachment } from "@/lib/stores/chat-store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Check, Copy, AlertCircle, RotateCcw, ChevronDown, Pencil, Trash2, X, SendHorizontal, FileText, Download } from "lucide-react";
import { createMarkdownComponents } from "./markdown-components";
import { ThinkingProcess } from "./thinking-process";
import { ClickableImage } from "@/components/ui/image-lightbox";
import { StrawberryLogo } from "@/components/ui/strawberry-logo";

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      // clipboard access denied or insecure context
    });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 md:px-1.5 md:py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground active:bg-accent transition-colors",
        className
      )}
      aria-label="Copy"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

function EditableMessage({
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
    <div className="flex flex-col gap-2 max-w-[90%] sm:max-w-[80%]">
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
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent transition-colors"
        >
          <X className="size-3" />
          Cancel
        </button>
        <button
          onClick={() => {
            const trimmed = text.trim();
            if (trimmed) onSubmit(trimmed);
          }}
          disabled={!text.trim()}
          className="inline-flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-xs text-brand-foreground hover:bg-brand/90 transition-colors disabled:opacity-50"
        >
          <SendHorizontal className="size-3" />
          Send
        </button>
      </div>
    </div>
  );
}

function AttachmentList({ attachments }: { attachments: ChatAttachment[] }) {
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

function MessageBubble({
  message,
  onRetry,
  onEdit,
  onDelete,
}: {
  message: ChatMessage;
  onRetry?: (id: string) => void;
  onEdit?: (id: string, content: string) => void;
  onDelete?: (id: string) => void;
}) {
  const isUser = message.role === "user";
  const isError = message.status === "error";
  const isStreaming = message.status === "streaming";
  const [editing, setEditing] = useState(false);

  const markdownComponents = useMemo(
    () => createMarkdownComponents(isStreaming),
    [isStreaming],
  );

  if (editing && isUser) {
    return (
      <div className="flex flex-col items-end">
        <EditableMessage
          message={message}
          onSubmit={(content) => {
            setEditing(false);
            onEdit?.(message.id, content);
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className={cn("group flex flex-col", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "relative max-w-[90%] sm:max-w-[80%] rounded-2xl px-3 py-2 sm:px-4 sm:py-2.5 text-sm leading-relaxed",
          isError
            ? "bg-destructive/10 border border-destructive/30 text-foreground"
            : isUser
              ? "bg-brand text-brand-foreground"
              : "bg-muted text-foreground"
        )}
      >
        {isStreaming && message.content === "" ? (
          <div className="flex items-center gap-2 py-1">
            <span className="size-1.5 animate-pulse rounded-full bg-current opacity-60" />
            <span className="size-1.5 animate-pulse rounded-full bg-current opacity-60 [animation-delay:150ms]" />
            <span className="size-1.5 animate-pulse rounded-full bg-current opacity-60 [animation-delay:300ms]" />
          </div>
        ) : isUser ? (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        ) : (
          <div className={cn(
            "prose prose-sm dark:prose-invert max-w-none [&_pre]:my-0 [&_pre]:p-0 [&_pre]:bg-transparent [&_code]:text-xs",
            isStreaming && "streaming-cursor",
          )}>
            <ReactMarkdown components={markdownComponents}>{message.content}</ReactMarkdown>
          </div>
        )}
        {isError && (
          <div className="mt-2 text-xs text-destructive space-y-1">
            <div className="flex items-center gap-1.5">
              <AlertCircle className="size-3 shrink-0" />
              <span>{message.error || "Failed to send"}</span>
            </div>
            {onRetry && (
              <button
                onClick={() => onRetry(message.id)}
                className="inline-flex items-center gap-0.5 underline hover:no-underline"
              >
                <RotateCcw className="size-2.5" />
                Retry
              </button>
            )}
          </div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <AttachmentList attachments={message.attachments} />
        )}
      </div>
      <div className="flex items-center gap-1 mt-1 px-1">
        <span className="text-[11px] text-muted-foreground/60">
          {formatTime(message.timestamp)}
        </span>
        {!isStreaming && message.content && (
          <div className="flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
            <CopyButton text={message.content} />
            {isUser && (
              <>
                <button
                  onClick={() => setEditing(true)}
                  className="inline-flex items-center rounded-md p-2 md:p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground active:bg-accent transition-colors"
                  aria-label="Edit message"
                >
                  <Pencil className="size-3" />
                </button>
                <button
                  onClick={() => onDelete?.(message.id)}
                  className="inline-flex items-center rounded-md p-2 md:p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive active:bg-destructive/10 transition-colors"
                  aria-label="Delete message"
                >
                  <Trash2 className="size-3" />
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {!isUser && message.thinkingSteps && message.thinkingSteps.length > 0 && (
        <div className="max-w-[90%] sm:max-w-[80%] mt-1">
          <ThinkingProcess steps={message.thinkingSteps} reasoning={message.reasoning} isActive={isStreaming} />
        </div>
      )}
    </div>
  );
}

export function ChatMessageList({
  onRetry,
  onEdit,
}: {
  onRetry?: (messageId: string) => void;
  onEdit?: (messageId: string, content: string) => void;
}) {
  const messages = useChatStore((s) => s.messages);
  const removeMessage = useChatStore((s) => s.removeMessage);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const prevMsgCountRef = useRef(messages.length);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottom.current = distFromBottom < 80;
    setShowScrollBtn(distFromBottom > 200);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      isNearBottom.current = true;
      setShowScrollBtn(false);
    }
  }, []);

  useEffect(() => {
    if (!scrollRef.current) return;
    const lastMsg = messages[messages.length - 1];
    const isNewUserMessage = messages.length > prevMsgCountRef.current && lastMsg?.role === "user";
    if (isNearBottom.current || isNewUserMessage) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevMsgCountRef.current = messages.length;
  }, [messages]);

  return (
    <div className="relative overflow-hidden h-full">
      {messages.length === 0 ? (
        <div className="flex h-full items-center justify-center p-4">
          <div className="text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-muted animate-float">
              <StrawberryLogo className="size-6" />
            </div>
            <h2 className="text-lg font-semibold text-foreground">Start a conversation</h2>
            <p className="mt-1 text-sm text-muted-foreground">Type a message to begin</p>
          </div>
        </div>
      ) : (
      <ScrollArea ref={scrollRef} className="h-full p-4" onScroll={handleScroll}>
          <div className="mx-auto max-w-3xl space-y-4">
            {messages.map((msg, i) => {
              const isLatest = i === messages.length - 1;
              const animClass = isLatest ? (msg.role === "user" ? "animate-msg-user" : "animate-msg-assistant") : undefined;
              return (
                <div key={msg.id} className={animClass}>
                  <MessageBubble
                    message={msg}
                    onRetry={onRetry}
                    onEdit={onEdit}
                    onDelete={removeMessage}
                  />
                </div>
              );
            })}
          </div>
      </ScrollArea>
      )}
      <button
        onClick={scrollToBottom}
        className={cn(
          "absolute bottom-4 right-4 z-10 flex size-10 md:size-8 items-center justify-center rounded-full border border-border bg-background shadow-md hover:bg-accent active:bg-accent transition-all duration-200",
          showScrollBtn ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 pointer-events-none",
        )}
        aria-label="Scroll to bottom"
      >
        <ChevronDown className="size-4 text-muted-foreground" />
      </button>
    </div>
  );
}

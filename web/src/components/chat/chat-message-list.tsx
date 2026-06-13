/**
 * 聊天消息列表 + 消息气泡。
 *
 * 职责：
 *   - ChatMessageList：消息列表容器（自动滚动 / 滚到底部按钮 / 空状态）
 *   - MessageBubble：单条消息气泡（用户 / 助手 / 错误 / 流式动画）
 *
 * 子组件（从 message-bubble-parts.tsx 导入）：
 *   - CopyButton / EditableMessage / MessageError / BrainReviewBadge /
 *     MessageActions / AttachmentList
 */

import { useRef, useEffect, useState, useCallback, useMemo, memo } from "react";
import ReactMarkdown from "react-markdown";
import { useChatStore, type ChatMessage } from "@/lib/stores/chat-store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import { createMarkdownComponents } from "./markdown-components";
import { ThinkingProcess } from "./thinking-process";
import { ToolCallCards } from "./tool-call-cards";
import { StrawberryLogo } from "@/components/ui/strawberry-logo";
import { useT, useLocale } from "@/lib/i18n";
import {
  CopyButton,
  EditableMessage,
  AttachmentList,
  MessageError,
  BrainReviewBadge,
  MessageActions,
} from "./message-bubble-parts";

/**
 * 格式化消息时间戳
 * @param ts 时间戳（毫秒）
 * @param localeTag 用于 Intl API 的 locale 标签（如 "zh-CN" 或 "en-US"）
 */
function formatTime(ts: number, localeTag: string): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString(localeTag, { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString(localeTag, { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString(localeTag, { hour: "2-digit", minute: "2-digit" });
}

const MessageBubble = memo(function MessageBubble({
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
  const isSending = isUser && message.status === "sending";
  const isUserFailed = isUser && message.status === "failed";
  const [editing, setEditing] = useState(false);
  const t = useT();
  const { locale } = useLocale();

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
            : isUserFailed
              ? "bg-brand/60 border border-warning/40 text-brand-foreground"
              : isUser
                ? "bg-brand text-brand-foreground"
                : "bg-muted text-foreground",
          isSending && "opacity-70",
          isStreaming && !isUser && "animate-stream-pulse",
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
        {/* 错误提示 + 重试（isError=destructive / isUserFailed=warning，UI 复用 MessageError） */}
        {isError && (
          <MessageError
            message={message.error || t("chat.failedToSend")}
            onRetry={onRetry ? () => onRetry(message.id) : undefined}
            variant="destructive"
          />
        )}
        {isUserFailed && (
          <MessageError
            message={t("chat.failedToSend")}
            onRetry={onRetry ? () => onRetry(message.id) : undefined}
            variant="warning"
          />
        )}
        {/* 用户消息发送中指示 */}
        {isSending && (
          <div className="mt-1 text-[11px] text-brand-foreground/50 flex items-center gap-1">
            <span className="size-1 animate-pulse rounded-full bg-current" />
          </div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <AttachmentList attachments={message.attachments} />
        )}
        {/* 13.0 灵魂版：Brain 审核标注（modify/reject 时展示） */}
        {!isUser && message.reviewVerdict && message.reviewVerdict !== "approve" && (
          <BrainReviewBadge
            verdict={message.reviewVerdict as "modify" | "reject"}
            reason={message.reviewReason}
          />
        )}
      </div>
      <div className="flex items-center gap-1 mt-px px-1">
        <span className="text-[11px] text-muted-foreground/60">
          {formatTime(message.timestamp, locale === "zh" ? "zh-CN" : "en-US")}
        </span>
        {!isStreaming && message.content && (
          <MessageActions
            copyText={message.content}
            isUser={isUser}
            onEdit={() => setEditing(true)}
            onDelete={onDelete ? () => onDelete(message.id) : undefined}
          />
        )}
      </div>
      {/* 思考过程 / 工具调用块：外层包裹不加 mt，与上方"时间戳行"紧邻。
          块与块之间剩余的视觉间距来自文本 line-height（行盒留白），并非 margin；
          这是 11px 小字的正常排印行为，详见 thinking-process.tsx 注释。 */}
      {!isUser && ((message.thinkingSteps && message.thinkingSteps.length > 0) || message.reasoning) && (
        <div className="max-w-[90%] sm:max-w-[80%]">
          <ThinkingProcess steps={message.thinkingSteps ?? []} reasoning={message.reasoning} isActive={isStreaming} />
        </div>
      )}
      {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
        <div className="max-w-[90%] sm:max-w-[80%]">
          <ToolCallCards calls={message.toolCalls} isActive={isStreaming} />
        </div>
      )}
    </div>
  );
});

export function ChatMessageList({
  onRetry,
  onEdit,
}: {
  onRetry?: (messageId: string) => void;
  onEdit?: (messageId: string, content: string) => void;
}) {
  const messages = useChatStore((s) => s.messages);
  const removeMessage = useChatStore((s) => s.removeMessage);
  /** 稳定引用，避免每次渲染创建新函数导致 memo 失效 */
  const stableRemoveMessage = useCallback((id: string) => removeMessage(id), [removeMessage]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const t = useT();
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
            <h2 className="text-lg font-semibold text-foreground">{t("chat.startConversation")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("chat.typeToBegin")}</p>
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
                    onDelete={stableRemoveMessage}
                  />
                </div>
              );
            })}
          </div>
      </ScrollArea>
      )}
      <button type="button"
        onClick={scrollToBottom}
        className={cn(
          "absolute bottom-4 right-4 z-10 flex size-11 md:size-8 items-center justify-center rounded-full border border-border bg-background shadow-md hover:bg-accent active:bg-accent transition-all duration-200",
          showScrollBtn ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-2 scale-75 pointer-events-none",
        )}
        aria-label={t("chat.scrollToBottom")}
      >
        <ChevronDown className="size-4 text-muted-foreground" />
      </button>
    </div>
  );
}

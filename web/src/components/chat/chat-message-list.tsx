/**
 * 聊天消息列表 + 单条消息气泡。
 *
 * 职责：
 *   - ChatMessageList：消息列表容器（自动滚动 / 滚到底部按钮 / 空状态）
 *   - MessageBubble：单条消息气泡（用户 / 助手 / 错误 / 流式动画）
 *
 * 子组件（从 message-bubble-parts.tsx 导入）：
 *   CopyButton / EditableMessage / MessageError / BrainReviewBadge /
 *   MessageActions / AttachmentList
 */

import { useRef, useEffect, useState, useCallback, useMemo, memo } from "react";
import ReactMarkdown from "react-markdown";
import { useChatStore, type ChatMessage } from "@/lib/stores/chat-store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { textFromBlocks } from "@/lib/blocks";
import { ChevronDown } from "lucide-react";
import { createMarkdownComponents } from "./markdown-components";
import { MessageTimeline } from "./block-renderers";
import { StrawberryLogo } from "@/components/ui/strawberry-logo";
import { useT, useLocale } from "@/lib/i18n";
import {
  EditableMessage,
  AttachmentList,
  MessageError,
  BrainReviewBadge,
  MessageActions,
} from "./message-bubble-parts";

/** 气泡背景样式 key（消除嵌套三元，Tailwind 要求完整类名字面量） */
type BubbleStyleKey = "error" | "userFailed" | "user" | "assistant";

/** 各场景气泡背景 —— 与下方 styleKeyFor() 一一对应 */
const BUBBLE_STYLE: Record<BubbleStyleKey, string> = {
  error: "bg-destructive/10 border border-destructive/30 text-foreground",
  userFailed: "bg-brand/60 border border-warning/40 text-brand-foreground",
  user: "bg-brand text-brand-foreground",
  assistant: "bg-muted text-foreground",
};

/** 流式启动时的三点等待动画延迟（毫秒） */
const TYPING_DOTS_DELAY = [0, 150, 300] as const;

/**
 * 格式化消息时间戳：今天仅显示时分，否则显示月日 + 时分。
 * @param ts 时间戳（毫秒）
 * @param localeTag Intl locale 标签
 */
function formatTime(ts: number, localeTag: string): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(localeTag, { hour: "2-digit", minute: "2-digit" });
  // 同一天：只返回时分
  if (d.toDateString() === new Date().toDateString()) return time;
  // 跨天：月日 + 时分
  return d.toLocaleDateString(localeTag, { month: "short", day: "numeric" }) + " " + time;
}

/**
 * 单条消息气泡。
 *
 * 渲染分两种主路径：
 *   - user：纯文本气泡（编辑态切到 EditableMessage）
 *   - assistant：优先走 block-first 时间线（doc 22 内联统一），
 *                历史/无 block 消息回退到 content markdown。
 *
 * 流式且无任何 block/content 时显示三点等待动画。
 */
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
  const localeTag = locale === "zh" ? "zh-CN" : "en-US";
  /** markdown 组件映射缓存到 isStreaming 粒度，避免每帧重建 */
  const markdownComponents = useMemo(
    () => createMarkdownComponents(isStreaming),
    [isStreaming],
  );
  // 对话内联（doc 22 Phase C）：block-first 渲染 —— 优先从 TextBlock 取正文（单一事实源），
  // 回退 content（兼容无 text block 的历史消息 / 过渡期）。user 消息无 blocks → 回退 content。
  const displayContent = textFromBlocks(message.blocks, message.content);

  /** 编辑态（仅 user 消息） */
  if (editing && isUser) {
    return (
      <div className="flex flex-col items-end">
        <EditableMessage
          message={message}
          onSubmit={(content) => { setEditing(false); onEdit?.(message.id, content); }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  /** 由消息角色 + status 推导气泡背景 key（替代嵌套三元） */
  const styleKey: BubbleStyleKey = isError
    ? "error"
    : isUserFailed
      ? "userFailed"
      : isUser
        ? "user"
        : "assistant";

  /** 错误 / 失败提示文案与色调（无错时为 null，不渲染） */
  const errorCfg = isError
    ? { msg: message.error || t("chat.failedToSend"), variant: "destructive" as const }
    : isUserFailed
      ? { msg: t("chat.failedToSend"), variant: "warning" as const }
      : null;

  /** 助手消息是否有 block 时间线可渲染 */
  const hasTimeline = !isUser && (message.blocks ?? []).length > 0;
  /** 流式刚启动、尚无任何内容时显示三点等待 */
  const showTypingDots = isStreaming && (message.blocks ?? []).length === 0 && !displayContent;

  return (
    <div className={cn("group flex flex-col", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "relative max-w-[90%] sm:max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed sm:px-4 sm:py-2.5",
          BUBBLE_STYLE[styleKey],
          isSending && "opacity-70",
          isStreaming && !isUser && "animate-stream-pulse",
        )}
      >
        {/*
          气泡正文渲染（doc 22 对话内联）：
          1) 流式且空 → 三点等待动画
          2) user → 纯文本
          3) assistant + 有 blocks → MessageTimeline 时间线穿插
          4) 兜底 → content markdown
        */}
        {showTypingDots ? (
          <div className="flex items-center gap-2 py-1">
            {TYPING_DOTS_DELAY.map((d) => (
              <span
                key={d}
                className="size-1.5 animate-pulse rounded-full bg-current opacity-60"
                style={{ animationDelay: `${d}ms` }}
              />
            ))}
          </div>
        ) : isUser ? (
          <div className="whitespace-pre-wrap break-words">{displayContent}</div>
        ) : hasTimeline ? (
          <MessageTimeline message={message} isActive={isStreaming} markdownComponents={markdownComponents} />
        ) : (
          <div className={cn(
            "prose prose-sm dark:prose-invert max-w-none [&_pre]:my-0 [&_pre]:p-0 [&_pre]:bg-transparent [&_code]:text-xs",
            isStreaming && "streaming-cursor",
          )}>
            <ReactMarkdown components={markdownComponents}>{displayContent}</ReactMarkdown>
          </div>
        )}

        {/* 错误 / 失败提示 */}
        {errorCfg && (
          <MessageError
            message={errorCfg.msg}
            onRetry={onRetry ? () => onRetry(message.id) : undefined}
            variant={errorCfg.variant}
          />
        )}
        {/* 发送中指示（user 消息持久化前） */}
        {isSending && (
          <div className="mt-1 flex items-center gap-1 text-[11px] text-brand-foreground/50">
            <span className="size-1 animate-pulse rounded-full bg-current" />
          </div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <AttachmentList attachments={message.attachments} />
        )}
        {/* Brain 审核标注（仅展示 modify / reject；approve 不显示） */}
        {!isUser && message.reviewVerdict && message.reviewVerdict !== "approve" && (
          <BrainReviewBadge verdict={message.reviewVerdict as "modify" | "reject"} reason={message.reviewReason} />
        )}
      </div>

      {/* 时间戳 + 复制/编辑/删除操作（流式时不显示） */}
      <div className="mt-px flex items-center gap-1 px-1">
        <span className="text-[11px] text-muted-foreground/60">
          {formatTime(message.timestamp, localeTag)}
        </span>
        {!isStreaming && displayContent && (
          <MessageActions
            copyText={displayContent}
            isUser={isUser}
            onEdit={() => setEditing(true)}
            onDelete={onDelete ? () => onDelete(message.id) : undefined}
          />
        )}
      </div>
    </div>
  );
});

/** 滚到底部按钮的显示阈值（距底 px） */
const SCROLL_BTN_THRESHOLD = 200;
/** 自动跟随滚动阈值（距底 px）—— 距离更近则视为"在底部" */
const NEAR_BOTTOM_THRESHOLD = 80;

/**
 * 消息列表容器：自动滚动 + 空状态 + 滚到底部按钮。
 *
 * 自动滚动规则：
 *   - 用户向上滚动离开底部时不自动跟随
 *   - 新消息到来时若用户停在底部附近则跟随
 *   - 用户新发一条消息（列表变长且最后一条是 user）强制滚到底
 */
export function ChatMessageList({
  onRetry,
  onEdit,
}: {
  onRetry?: (messageId: string) => void;
  onEdit?: (messageId: string, content: string) => void;
}) {
  const messages = useChatStore((s) => s.messages);
  const removeMessage = useChatStore((s) => s.removeMessage);
  /** 稳定引用，避免每次渲染创建新函数导致 MessageBubble memo 失效 */
  const stableRemoveMessage = useCallback((id: string) => removeMessage(id), [removeMessage]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const t = useT();
  /** 用户是否停留在列表底部附近（决定是否自动跟随滚动） */
  const isNearBottom = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  /** 上一轮消息数（判断是否新增 user 消息以强制滚到底） */
  const prevMsgCountRef = useRef(messages.length);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const dist = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight;
    isNearBottom.current = dist < NEAR_BOTTOM_THRESHOLD;
    setShowScrollBtn(dist > SCROLL_BTN_THRESHOLD);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    isNearBottom.current = true;
    setShowScrollBtn(false);
  }, []);

  /** 新消息到达时自动滚动（接近底部 或 新 user 消息强制） */
  useEffect(() => {
    if (!scrollRef.current) return;
    const lastMsg = messages[messages.length - 1];
    const isNewUserMsg = messages.length > prevMsgCountRef.current && lastMsg?.role === "user";
    if (isNearBottom.current || isNewUserMsg) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevMsgCountRef.current = messages.length;
  }, [messages]);

  return (
    <div className="relative h-full overflow-hidden">
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
            {messages.map((msg, i) => (
              <div
                key={msg.id}
                className={i === messages.length - 1 ? (msg.role === "user" ? "animate-msg-user" : "animate-msg-assistant") : undefined}
              >
                <MessageBubble message={msg} onRetry={onRetry} onEdit={onEdit} onDelete={stableRemoveMessage} />
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
      {/* 滚到底部按钮（移动端 44px 触控目标） */}
      <button
        type="button"
        onClick={scrollToBottom}
        className={cn(
          "absolute bottom-4 right-4 z-10 flex size-11 md:size-8 items-center justify-center rounded-full border border-border bg-background shadow-md transition-all duration-200 hover:bg-accent active:bg-accent",
          showScrollBtn ? "translate-y-0 scale-100 opacity-100" : "pointer-events-none translate-y-2 scale-75 opacity-0",
        )}
        aria-label={t("chat.scrollToBottom")}
      >
        <ChevronDown className="size-4 text-muted-foreground" />
      </button>
    </div>
  );
}

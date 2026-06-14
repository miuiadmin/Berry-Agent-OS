/**
 * 单个会话列表项（侧边栏一行）。
 *
 * 内聚处理：展示态（标题/元数据/操作按钮）+ 编辑态（重命名输入框）+
 * 删除退场动画。父组件只需提供 select/delete/rename 回调 + isActive/isRemoving 状态。
 */

import { useEffect, useRef, useState } from "react";
import type { ConversationInfo } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Trash2, Pencil, Check, X } from "lucide-react";
import { useT, useDateFormat } from "@/lib/i18n";

/** 标题/首条消息展示长度上限（超出截断 + 省略号） */
const TITLE_MAX = 40;
/**
 * 退场动画兜底超时（毫秒）。
 * 用于 prefers-reduced-motion 等场景：动画事件不触发时强制调用 onExitEnd，
 * 避免会话卡在动画态删不掉。取值略大于 animate-item-exit 的实际时长。
 */
const MAX_EXIT_MS = 400;

/** 操作图标按钮的共享 className（移动端 44px / 桌面端紧凑） */
const ACTION_BTN = "flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md p-2 md:min-h-0 md:min-w-0 md:p-1";

interface ConversationItemProps {
  conv: ConversationInfo;
  isActive: boolean;
  isRemoving: boolean;
  onSelect: () => void;
  onRename: (sid: string, title: string) => void;
  onRequestDelete: () => void;
  /** 退场动画结束回调 —— 携带具体 sessionId，避免父组件从闭包读 removingId 时与并发删除竞态 */
  onExitEnd: (sid: string) => void;
}

/** 字符串截断（超长加省略号），不超过 max 的原样返回 */
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/**
 * 获取会话展示标题（优先 title → firstMessage 截断 → sessionId 截断兜底）。
 * 三个层级避免会话无标题时显示空白。
 */
function displayTitle(conv: ConversationInfo): string {
  if (conv.title) return conv.title;
  if (conv.firstMessage) return truncate(conv.firstMessage, TITLE_MAX);
  return conv.sessionId.slice(0, 16);
}

/**
 * 编辑态预填值。
 * 与 displayTitle 不同：编辑框特意不加省略号「…」，方便用户在尾部继续输入，
 * 而 displayTitle（展示态）超长会加省略号。两者截断长度一致（TITLE_MAX）。
 */
function editPlaceholder(conv: ConversationInfo): string {
  return conv.title || conv.firstMessage?.slice(0, TITLE_MAX) || "";
}

export function ConversationItem({
  conv, isActive, isRemoving, onSelect, onRename, onRequestDelete, onExitEnd,
}: ConversationItemProps) {
  const t = useT();
  const { formatRelative: fmtRelative } = useDateFormat();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  /** 列表项 DOM（用于兜底退场动画超时） */
  const itemRef = useRef<HTMLDivElement | null>(null);
  /** 退场动画兜底计时器（reduced-motion 等场景动画事件不触发时强制 onExitEnd） */
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 进入编辑态时聚焦并全选（便于整体覆盖原标题） */
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  /** 进入编辑态，预填当前标题（无标题时取首条消息截断） */
  const startEditing = () => {
    setEditing(true);
    setEditValue(editPlaceholder(conv));
  };

  /** 提交重命名（空值则视为取消） */
  const submitRename = () => {
    if (editValue.trim()) onRename(conv.sessionId, editValue.trim());
    setEditing(false);
  };

  return (
    <div
      className={cn(
        // min-h-[44px] 保证移动端容器高度容纳 44px 操作按钮（之前 py-2 + 内容 ~36px，44px 按钮溢出底部）
        "conv-item group relative w-full min-h-[44px] cursor-pointer rounded-lg px-3 py-2 text-left text-sm transition-all active:scale-[0.98]",
        isRemoving && "animate-item-exit",
        isActive ? "nav-link-active bg-accent text-accent-foreground" : "hover:bg-accent/50 text-muted-foreground",
      )}
      onClick={() => { if (!isRemoving) onSelect(); }}
      /*
       * 退场动画结束时通知父组件真正删除。
       *
       * 关键场景——prefers-reduced-motion：浏览器在用户启用「减少动态」时可能完全跳过动画，
       * 不触发 animationend → onExitEnd 永不调用 → 会话卡在动画态删不掉。
       * React 的 HTMLAttributes 不暴露 onAnimationCancel，故无法监听动画取消事件；
       * 改用 ref 回调里的 setTimeout 兜底：isRemoving 置 true 后 MAX_EXIT_MS 内未收到
       * animationend 就强制结束。正常动画路径（~200ms）远小于 MAX_EXIT_MS(400ms)，
       * 不会与 animationend 重复触发（兜底触发时 onExitEnd 已是幂等清理）。
       */
      onAnimationEnd={() => { if (isRemoving) onExitEnd(conv.sessionId); }}
      ref={(el) => {
        itemRef.current = el;
        // 兜底：reduced-motion 等场景 animationend 不触发时，限时强制结束
        if (isRemoving && el) {
          if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
          exitTimerRef.current = setTimeout(() => onExitEnd(conv.sessionId), MAX_EXIT_MS);
        } else if (!isRemoving && exitTimerRef.current) {
          clearTimeout(exitTimerRef.current);
          exitTimerRef.current = null;
        }
      }}
    >
      {editing ? (
        /* 编辑态：输入框 + 保存/取消（阻止事件冒泡，避免误触选中） */
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <input ref={inputRef} value={editValue} onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitRename(); if (e.key === "Escape") setEditing(false); }}
            className="min-h-[44px] flex-1 rounded border bg-background px-2 py-1.5 text-[16px] outline-none focus:ring-1 focus:ring-ring md:min-h-0 md:px-1.5 md:py-0.5 md:text-xs" />
          <button type="button" onClick={submitRename} aria-label={t("chat.saveRename")}
            className="min-h-[44px] p-1.5 text-success hover:text-success/80 md:min-h-0 md:p-0.5">
            <Check className="size-3" />
          </button>
          <button type="button" onClick={() => setEditing(false)} aria-label={t("chat.cancelRename")}
            className="min-h-[44px] p-1.5 text-muted-foreground hover:text-foreground active:text-foreground md:min-h-0 md:p-0.5">
            <X className="size-3" />
          </button>
        </div>
      ) : (
        /* 展示态：标题 + 元数据 + 操作按钮 */
        <>
          <div className="truncate pr-20 font-medium md:pr-12">{displayTitle(conv)}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground/70">
            <span>{t("chat.messages", { count: conv.messageCount })}</span>
            <span>{fmtRelative(conv.lastActive)}</span>
          </div>
          {/* 操作按钮：移动端始终可见，桌面端 hover 显示（触屏设备 [@media(hover:none)] 强制显示） */}
          <div className="absolute right-2 top-2.5 flex items-center gap-0.5 opacity-100 transition-all md:opacity-0 md:group-hover:opacity-100 [@media(hover:none)]:opacity-100">
            <button type="button" aria-label={t("chat.renameConversation")}
              onClick={(e) => { e.stopPropagation(); startEditing(); }}
              className={cn(ACTION_BTN, "text-muted-foreground hover:text-foreground active:bg-accent")}>
              <Pencil className="size-3" />
            </button>
            <button type="button" aria-label={t("chat.deleteConversation")}
              onClick={(e) => { e.stopPropagation(); onRequestDelete(); }}
              className={cn(ACTION_BTN, "text-muted-foreground hover:text-destructive active:bg-destructive/10")}>
              <Trash2 className="size-3" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

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

interface ConversationItemProps {
  /** 会话数据 */
  conv: ConversationInfo;
  /** 是否当前选中（高亮） */
  isActive: boolean;
  /** 是否正在播放删除退场动画 */
  isRemoving: boolean;
  /** 选中回调 */
  onSelect: () => void;
  /** 重命名回调（sid + 新标题） */
  onRename: (sid: string, title: string) => void;
  /** 请求删除（父组件弹出确认框） */
  onRequestDelete: () => void;
  /** 删除退场动画结束回调（父组件据此真正调用删除 mutation） */
  onExitEnd: () => void;
}

export function ConversationItem({
  conv,
  isActive,
  isRemoving,
  onSelect,
  onRename,
  onRequestDelete,
  onExitEnd,
}: ConversationItemProps) {
  const t = useT();
  const { formatRelative: fmtRelative } = useDateFormat();
  /** 本项是否处于重命名编辑态（仅一项可同时编辑，状态内聚于本组件） */
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // 进入编辑态时聚焦并全选
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  /** 进入编辑态，用标题或首条消息预填 */
  const startEditing = () => {
    setEditing(true);
    setEditValue(conv.title || conv.firstMessage?.slice(0, 40) || "");
  };

  /** 提交重命名（空值则取消） */
  const submitRename = () => {
    if (editValue.trim()) {
      onRename(conv.sessionId, editValue.trim());
    }
    setEditing(false);
  };

  return (
    <div
      className={cn(
        "conv-item group relative w-full cursor-pointer rounded-lg px-3 py-2 text-left text-sm transition-all active:scale-[0.98]",
        isRemoving && "animate-item-exit",
        isActive
          ? "nav-link-active bg-accent text-accent-foreground"
          : "hover:bg-accent/50 text-muted-foreground",
      )}
      onClick={() => {
        if (!isRemoving) onSelect();
      }}
      onAnimationEnd={() => {
        if (isRemoving) onExitEnd();
      }}
    >
      {editing ? (
        // 编辑态：输入框 + 保存/取消
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              if (e.key === "Escape") setEditing(false);
            }}
            className="flex-1 rounded border bg-background px-2 py-1.5 text-[16px] outline-none focus:ring-1 focus:ring-ring min-h-[44px] md:min-h-0 md:px-1.5 md:py-0.5 md:text-xs"
          />
          <button
            type="button"
            onClick={submitRename}
            aria-label={t("chat.saveRename")}
            className="min-h-[44px] p-1.5 text-success hover:text-success/80 md:min-h-0 md:p-0.5"
          >
            <Check className="size-3" />
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            aria-label={t("chat.cancelRename")}
            className="min-h-[44px] p-1.5 text-muted-foreground hover:text-foreground active:text-foreground md:min-h-0 md:p-0.5"
          >
            <X className="size-3" />
          </button>
        </div>
      ) : (
        // 展示态：标题 + 元数据 + 操作按钮
        <>
          <div className="truncate pr-20 font-medium md:pr-12">
            {conv.title ||
              (conv.firstMessage
                ? conv.firstMessage.slice(0, 40) +
                  (conv.firstMessage.length > 40 ? "..." : "")
                : conv.sessionId.slice(0, 16))}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground/70">
            <span>{t("chat.messages", { count: conv.messageCount })}</span>
            <span>{fmtRelative(conv.lastActive)}</span>
          </div>
          {/* 操作按钮：移动端始终可见，桌面端 hover 显示 */}
          <div className="absolute right-2 top-2.5 flex items-center gap-0.5 opacity-100 transition-all md:opacity-0 md:group-hover:opacity-100 [@media(hover:none)]:opacity-100">
            <button
              type="button"
              aria-label={t("chat.renameConversation")}
              onClick={(e) => {
                e.stopPropagation();
                startEditing();
              }}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md p-2 text-muted-foreground hover:text-foreground active:bg-accent md:min-h-0 md:min-w-0 md:p-1"
            >
              <Pencil className="size-3" />
            </button>
            <button
              type="button"
              aria-label={t("chat.deleteConversation")}
              onClick={(e) => {
                e.stopPropagation();
                onRequestDelete();
              }}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md p-2 text-muted-foreground hover:text-destructive active:bg-destructive/10 md:min-h-0 md:min-w-0 md:p-1"
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

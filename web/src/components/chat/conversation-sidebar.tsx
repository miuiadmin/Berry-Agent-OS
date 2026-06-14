/**
 * 对话侧边栏 —— 对话列表 + 搜索 + 新建 + 删除确认。
 *
 * 在 Chat 页面左侧以抽屉形式展示，移动端点击后自动关闭。
 * Mutations 使用 useConversationMutations（与 ConversationsPage 共用），
 * 唯一的侧边栏特有逻辑是删除退场动画（removingId → onExitEnd）：
 *   1. 用户确认删除 → setRemovingId(sid) → ConversationItem 播退场动画
 *   2. 动画结束 onExitEnd → 真正调用 deleteConversation.mutate
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useChatStore } from "@/lib/stores/chat-store";
import { queries, type ConversationInfo } from "@/lib/api";
import { useDebouncedSearch } from "@/hooks/use-debounced-search";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Search } from "lucide-react";
import { useT } from "@/lib/i18n";
import { ConversationItem } from "./conversation-item";
import { useConversationMutations } from "@/pages/use-conversation-mutations";

interface ConversationSidebarProps {
  /** 选中对话后的回调（用于移动端关闭抽屉） */
  onSelect?: () => void;
}

export function ConversationSidebar({ onSelect }: ConversationSidebarProps) {
  const [search, debouncedSearch] = useDebouncedSearch();
  /** 待删除确认的会话 ID（非 null 时弹确认框） */
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  /**
   * 正在播放退场动画的会话 ID 集合。
   *
   * 改用 Set 而非单值：用户连续快速删除多个会话时（A 动画中又删 B），
   * 单值会被覆盖导致 A 永远停在动画态、且 onExitEnd 读到的 removingId 可能已是 B。
   * Set 允许多个会话同时处于退场动画，onExitEnd 携带具体 sid 精确移除。
   */
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const t = useT();

  // ── 数据查询 ──
  const { data: conversations } = useQuery({
    ...queries.conversations({ search: search || undefined }),
    select: (data) => data as ConversationInfo[],
  });

  // ── Chat store ──
  const sessionId = useChatStore((s) => s.sessionId);
  const setSessionId = useChatStore((s) => s.setSessionId);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setSkipAutoRestore = useChatStore((s) => s.setSkipAutoRestore);

  // ── Mutations（与 ConversationsPage 共用） ──
  const { deleteConversation, renameConversation } = useConversationMutations();

  /**
   * 新建对话：清空当前消息 + 会话 + 关闭抽屉。
   * setSkipAutoRestore(true) 阻止 chat-window 的 auto-restore effect 立刻拉最近对话覆盖（让"新建"按钮有效）。
   */
  const handleNewChat = () => {
    setSkipAutoRestore(true);
    clearMessages();
    setSessionId(null);
    onSelect?.();
  };

  /** 选择已有对话（同一会话直接返回，避免重复 clearMessages） */
  const handleSelect = (sid: string) => {
    if (sid === sessionId) return;
    clearMessages();
    setSessionId(sid);
    onSelect?.();
  };

  return (
    <div className="flex h-full w-72 md:w-64 max-w-[85vw] flex-col border-r bg-background md:bg-muted/30">
      {/* 新建按钮 + 搜索框 */}
      <div className="space-y-2 border-b p-3">
        <button
          type="button"
          onClick={handleNewChat}
          className="w-full rounded-lg border border-dashed border-border px-3 py-2.5 md:py-2 text-sm text-muted-foreground hover:border-foreground/30 hover:text-foreground transition-colors min-h-[44px] md:min-h-0"
        >
          {t("chat.newConversationBtn")}
        </button>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("chat.searchPlaceholder")}
            value={search}
            className="h-11 md:h-8 pl-8 text-[16px] md:text-xs"
            onChange={(e) => debouncedSearch(e.target.value)}
          />
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-1 p-2">
          {conversations?.map((conv) => (
            <ConversationItem
              key={conv.sessionId}
              conv={conv}
              isActive={conv.sessionId === sessionId}
              isRemoving={removingIds.has(conv.sessionId)}
              onSelect={() => handleSelect(conv.sessionId)}
              onRename={(sid, title) => renameConversation.mutate({ sid, title })}
              onRequestDelete={() => setDeleteTarget(conv.sessionId)}
              onExitEnd={(sid) => {
                // 动画结束 → 从 removingIds 移除该 sid + 真正调用删除 mutation。
                // sid 由 ConversationItem 直接透传（不再从 closure 读 removingId），
                // 避免连续删除 A/B 时闭包里读到错误 sid 的竞态。
                setRemovingIds((prev) => {
                  const next = new Set(prev);
                  next.delete(sid);
                  return next;
                });
                deleteConversation.mutate(sid, {
                  onError: () => {
                    // 删除失败：onError 已在 use-conversation-mutations 内 GET 校验 + toast。
                    // 这里无需额外回滚——removingIds 已在上方移除，item 自动从动画态恢复为正常展示态。
                  },
                });
              }}
            />
          ))}
          {!conversations?.length && (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              {search ? t("chat.noMatches") : t("chat.noConversations")}
            </p>
          )}
        </div>
      </ScrollArea>

      {/* 删除确认对话框 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("chat.deleteConfirmTitle")}
        description={t("chat.deleteConfirmDesc")}
        actionLabel={t("common.delete")}
        onAction={() => {
          // 关闭确认框 + 触发退场动画（真正删除在动画结束后）
          if (deleteTarget) {
            setRemovingIds((prev) => new Set(prev).add(deleteTarget));
            setDeleteTarget(null);
          }
        }}
      />
    </div>
  );
}

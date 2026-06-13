/**
 * 对话侧边栏 —— 对话列表 + 搜索 + 新建 + 删除确认。
 *
 * 在 Chat 页面左侧以抽屉形式展示，移动端点击后自动关闭。
 * Mutations 使用 useConversationMutations（与 ConversationsPage 共用），
 * 唯一的侧边栏特有逻辑是删除退场动画（removingId → onExitEnd）。
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
  /** 正在播放退场动画的会话 ID（动画结束才真正删除） */
  const [removingId, setRemovingId] = useState<string | null>(null);
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

  // ── Mutations（与 ConversationsPage 共用） ──
  const { deleteConversation, renameConversation } =
    useConversationMutations();

  /** 新建对话：清空当前状态 */
  const handleNewChat = () => {
    clearMessages();
    setSessionId(null);
    onSelect?.();
  };

  /** 选择已有对话 */
  const handleSelect = (sid: string) => {
    if (sid === sessionId) return;
    clearMessages();
    setSessionId(sid);
    onSelect?.();
  };

  return (
    <div className="flex h-full w-72 md:w-64 max-w-[85vw] flex-col border-r bg-background md:bg-muted/30">
      {/* 新建按钮 + 搜索框 */}
      <div className="border-b p-3 space-y-2">
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
            className="h-11 md:h-8 pl-8 text-[16px] md:text-xs"
            onChange={(e) => debouncedSearch(e.target.value)}
          />
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {conversations?.map((conv) => (
            <ConversationItem
              key={conv.sessionId}
              conv={conv}
              isActive={conv.sessionId === sessionId}
              isRemoving={conv.sessionId === removingId}
              onSelect={() => handleSelect(conv.sessionId)}
              onRename={(sid, title) =>
                renameConversation.mutate({ sid, title })
              }
              onRequestDelete={() => setDeleteTarget(conv.sessionId)}
              onExitEnd={() => {
                if (removingId) deleteConversation.mutate(removingId);
                setRemovingId(null);
              }}
            />
          ))}
          {(!conversations || conversations.length === 0) && (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              {search ? t("chat.noMatches") : t("chat.noConversations")}
            </p>
          )}
        </div>
      </ScrollArea>

      {/* 删除确认对话框 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("chat.deleteConfirmTitle")}
        description={t("chat.deleteConfirmDesc")}
        actionLabel={t("common.delete")}
        onAction={() => {
          if (deleteTarget) {
            const sid = deleteTarget;
            setDeleteTarget(null);
            setRemovingId(sid);
          }
        }}
      />
    </div>
  );
}

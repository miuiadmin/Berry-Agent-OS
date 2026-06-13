
import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useChatStore } from "@/lib/stores/chat-store";
import { queries, apiDelete, renameConversation, type ConversationInfo } from "@/lib/api";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Search } from "lucide-react";
import { useT } from "@/lib/i18n";
import { ConversationItem } from "./conversation-item";

interface ConversationSidebarProps {
  onSelect?: () => void;
}

export function ConversationSidebar({ onSelect }: ConversationSidebarProps) {
  const [search, setSearch] = useState("");
  /** 待删除确认的会话 ID（非 null 时弹确认框） */
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  /** 正在播放退场动画的会话 ID（动画结束才真正删除） */
  const [removingId, setRemovingId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const t = useT();

  const debouncedSearch = useMemo(() => {
    let timer: ReturnType<typeof setTimeout>;
    const debounced = (value: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => setSearch(value), 300);
    };
    /** 组件卸载时清除待处理的防抖定时器 */
    debounced.cancel = () => clearTimeout(timer);
    return debounced;
  }, []);

  // 卸载时清理防抖定时器
  useEffect(() => {
    return () => { debouncedSearch.cancel(); };
  }, [debouncedSearch]);

  const { data: conversations } = useQuery({
    ...queries.conversations({ search: search || undefined }),
    select: (data) => data as ConversationInfo[],
  });

  const sessionId = useChatStore((s) => s.sessionId);
  const setSessionId = useChatStore((s) => s.setSessionId);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setSkipAutoRestore = useChatStore((s) => s.setSkipAutoRestore);

  const deleteConversation = useMutation({
    mutationFn: async (sid: string) => {
      await apiDelete(`/api/conversations/${sid}`);
    },
    onSuccess: (_data, sid) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      toast.success(t("chat.conversationDeleted"));
      if (sid === sessionId) {
        clearMessages();
        setSessionId(null);
        // 标记跳过自动恢复，防止 effect 立刻拉回最近对话
        setSkipAutoRestore(true);
      }
    },
    onError: (err: Error) => {
      toast.error(err.message || t("chat.failedToDelete"));
    },
  });

  const renameMutation = useMutation({
    mutationFn: async ({ sid, title }: { sid: string; title: string }) => {
      await renameConversation(sid, title);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (err: Error) => {
      toast.error(err.message || t("chat.failedToRename"));
    },
  });

  const handleNewChat = () => {
    clearMessages();
    setSessionId(null);
    onSelect?.();
  };

  const handleSelect = (sid: string) => {
    if (sid === sessionId) return;
    clearMessages();
    setSessionId(sid);
    onSelect?.();
  };

  return (
    <div className="flex h-full w-72 md:w-64 max-w-[85vw] flex-col border-r bg-background md:bg-muted/30">
      <div className="border-b p-3 space-y-2">
        <button type="button"
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
              onRename={(sid, title) => renameMutation.mutate({ sid, title })}
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

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
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



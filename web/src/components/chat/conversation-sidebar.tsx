
import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useChatStore } from "@/lib/stores/chat-store";
import { queries, apiDelete, renameConversation, type ConversationInfo } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Search, Trash2, Pencil, Check, X } from "lucide-react";
import { useT, useDateFormat } from "@/lib/i18n";

interface ConversationSidebarProps {
  onSelect?: () => void;
}

export function ConversationSidebar({ onSelect }: ConversationSidebarProps) {
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const t = useT();
  const { formatRelative: fmtRelative } = useDateFormat();

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
      setEditingId(null);
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
    if (sid === sessionId || editingId === sid) return;
    clearMessages();
    setSessionId(sid);
    onSelect?.();
  };

  const startEditing = (conv: ConversationInfo) => {
    setEditingId(conv.sessionId);
    setEditValue(conv.title || conv.firstMessage?.slice(0, 40) || "");
  };

  const submitRename = () => {
    if (editingId && editValue.trim()) {
      renameMutation.mutate({ sid: editingId, title: editValue.trim() });
    } else {
      setEditingId(null);
    }
  };

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  return (
    <div className="flex h-full w-72 md:w-64 max-w-[85vw] flex-col border-r bg-background md:bg-muted/30">
      <div className="border-b p-3 space-y-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleNewChat}
          className="w-full border-dashed"
        >
          {t("chat.newConversationBtn")}
        </Button>
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
            <div
              key={conv.sessionId}
              className={cn(
                "group relative w-full rounded-lg px-3 py-2 text-left text-sm transition-all cursor-pointer active:scale-[0.98] conv-item",
                conv.sessionId === removingId && "animate-item-exit",
                conv.sessionId === sessionId
                  ? "nav-link-active bg-accent text-accent-foreground"
                  : "hover:bg-accent/50 text-muted-foreground"
              )}
              onClick={() => { if (conv.sessionId !== removingId) handleSelect(conv.sessionId); }}
              onAnimationEnd={() => {
                if (conv.sessionId === removingId) {
                  deleteConversation.mutate(removingId);
                  setRemovingId(null);
                }
              }}
            >
              {editingId === conv.sessionId ? (
                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <Input
                    ref={editInputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitRename();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="flex-1"
                  />
                  <Button variant="ghost" size="icon-sm" onClick={submitRename} aria-label={t("chat.saveRename")} className="text-success hover:text-success/80">
                    <Check className="size-3" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setEditingId(null)} aria-label={t("chat.cancelRename")} className="text-muted-foreground hover:text-foreground active:text-foreground">
                    <X className="size-3" />
                  </Button>
                </div>
              ) : (
                <>
                  <div className="truncate font-medium pr-20 md:pr-12">
                    {conv.title || (conv.firstMessage
                      ? conv.firstMessage.slice(0, 40) + (conv.firstMessage.length > 40 ? "..." : "")
                      : conv.sessionId.slice(0, 16))}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground/70">
                    <span>{t("chat.messages", { count: conv.messageCount })}</span>
                    <span>{fmtRelative(conv.lastActive)}</span>
                  </div>
                  <div className="absolute right-2 top-2.5 flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-all">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("chat.renameConversation")}
                      onClick={(e) => {
                        e.stopPropagation();
                        startEditing(conv);
                      }}
                    >
                      <Pencil className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("chat.deleteConversation")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(conv.sessionId);
                      }}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                </>
              )}
            </div>
          ))}
          {(!conversations || conversations.length === 0) && (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              {search ? t("chat.noMatches") : t("chat.noConversations")}
            </p>
          )}
        </div>
      </ScrollArea>

      <AlertDialog
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



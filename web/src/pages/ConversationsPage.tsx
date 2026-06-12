
import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { queries, apiDelete, exportConversation, type ConversationInfo } from "@/lib/api";
import { useChatStore } from "@/lib/stores/chat-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryBoundary } from "@/components/shared/query-boundary";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { useT, useDateFormat } from "@/lib/i18n";
import { MessagesSquare, Trash2, Search, ArrowUpDown, MessageCircle, Download } from "lucide-react";

function ConversationsSkeleton() {
  return (
    <div className="mt-4 space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl border border-border px-4 py-3">
          <Skeleton className="size-4 rounded" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ConversationsPage() {
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();
  useDocumentTitle(t("conversations.title"));
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"recent" | "messages">("recent");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const navigate = useNavigate();
  const sessionId = useChatStore((s) => s.sessionId);
  const setSessionId = useChatStore((s) => s.setSessionId);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setSkipAutoRestore = useChatStore((s) => s.setSkipAutoRestore);

  const conversationsQuery = useQuery({
    ...queries.conversations({ search: search || undefined, sort }),
    select: (data) => data as ConversationInfo[],
  });

  const queryClient = useQueryClient();
  const deleteConversation = useMutation({
    mutationFn: async (sid: string) => {
      await apiDelete(`/api/conversations/${sid}`);
    },
    onSuccess: (_data, sid) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      toast.success(t("conversations.conversationDeleted"));
      // 如果删除的是当前活跃对话，清理状态并阻止自动恢复
      if (sid === sessionId) {
        clearMessages();
        setSessionId(null);
        setSkipAutoRestore(true);
      }
    },
    onError: (err: Error) => {
      toast.error(err.message || t("conversations.failedToDelete"));
    },
  });

  const handleOpenChat = (sessionId: string) => {
    clearMessages();
    setSessionId(sessionId);
    navigate("/chat");
  };

  const handleExport = useCallback(async (conv: ConversationInfo) => {
    try {
      const messages = await exportConversation(conv.sessionId);
      const data = { sessionId: conv.sessionId, title: conv.title, exportedAt: new Date().toISOString(), messages };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `conversation-${conv.sessionId.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t("conversations.exportedConversation"));
    } catch {
      toast.error(t("conversations.failedToExport"));
    }
  }, []);

  const handleExportAll = useCallback(async () => {
    const conversations = conversationsQuery.data;
    if (!conversations?.length) return;
    try {
      const all = await Promise.all(
        conversations.map(async (conv) => {
          const messages = await exportConversation(conv.sessionId);
          return { sessionId: conv.sessionId, title: conv.title, messages };
        }),
      );
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), conversations: all }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `conversations-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t("conversations.exportedCount", { count: all.length }));
    } catch {
      toast.error(t("conversations.failedToExportAll"));
    }
  }, [conversationsQuery.data]);

  const debouncedSearch = useMemo(() => {
    let timer: ReturnType<typeof setTimeout>;
    const fn = (value: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => setSearch(value), 300);
    };
    fn.cancel = () => clearTimeout(timer);
    return fn;
  }, []);

  return (
    <div className="p-4 sm:p-6">
      <h1 className="text-lg font-semibold">{t("conversations.title")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("conversations.subtitle")}</p>

      <div className="mt-4 flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("conversations.searchPlaceholder")}
            className="pl-9 h-10 md:h-[unset]"
            onChange={(e) => debouncedSearch(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSort(sort === "recent" ? "messages" : "recent")}
          className="gap-1.5 min-h-[44px] md:min-h-0"
        >
          <ArrowUpDown className="size-3.5" />
          <span className="hidden sm:inline">{sort === "recent" ? t("conversations.mostRecent") : t("conversations.mostMessages")}</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleExportAll}
          className="gap-1.5 min-h-[44px] md:min-h-0"
          disabled={!conversationsQuery.data?.length}
        >
          <Download className="size-3.5" />
          <span className="hidden sm:inline">{t("conversations.exportAll")}</span>
        </Button>
      </div>

      <QueryBoundary
        query={conversationsQuery}
        skeleton={<ConversationsSkeleton />}
        errorTitle={t("conversations.failedToLoad")}
      >
        {(conversations) => (
          <div className="mt-4 space-y-2">
            {conversations.map((conv, i) => {
              const displayTitle = conv.title || (conv.firstMessage
                ? conv.firstMessage.slice(0, 80) + (conv.firstMessage.length > 80 ? "..." : "")
                : conv.sessionId);
              return (
                <div
                  key={conv.sessionId}
                  className={cn(
                    "flex items-center justify-between rounded-xl border border-border px-4 py-3 cursor-pointer hover:border-foreground/20 active:border-foreground/10 active:scale-[0.99] transition-all conv-item",
                    `stagger-${Math.min(i + 1, 8)}`,
                  )}
                  onClick={() => handleOpenChat(conv.sessionId)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className={cn("text-sm truncate", conv.title ? "font-medium" : "text-muted-foreground italic")}>
                        {displayTitle}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("conversations.messagesCount", { count: conv.messageCount })} · {fmtDT(new Date(conv.lastActive))}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("conversations.exportConversation")}
                      className="min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleExport(conv);
                      }}
                    >
                      <Download className="size-4 text-muted-foreground" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("conversations.deleteConversation")}
                      className="min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(conv.sessionId);
                      }}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              );
            })}
            {conversations.length === 0 && (
              <EmptyState
                icon={search ? Search : MessageCircle}
                title={search ? t("conversations.noMatchingConversations") : t("conversations.noConversations")}
                description={search ? t("conversations.tryDifferentSearch") : t("conversations.startChatting")}
                action={search ? undefined : { label: t("conversations.startConversation"), onClick: () => navigate("/chat") }}
              />
            )}
          </div>
        )}
      </QueryBoundary>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("conversations.deleteConfirmTitle")}
        description={t("conversations.deleteConfirmDesc")}
        actionLabel={t("common.delete")}
        onAction={() => {
          if (deleteTarget) deleteConversation.mutate(deleteTarget);
        }}
      />
    </div>
  );
}


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
import { QueryBoundary } from "@/components/ui/query-boundary";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
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
  useDocumentTitle("Conversations");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"recent" | "messages">("recent");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const navigate = useNavigate();
  const setSessionId = useChatStore((s) => s.setSessionId);
  const clearMessages = useChatStore((s) => s.clearMessages);

  const conversationsQuery = useQuery({
    ...queries.conversations({ search: search || undefined, sort }),
    select: (data) => data as ConversationInfo[],
  });

  const queryClient = useQueryClient();
  const deleteConversation = useMutation({
    mutationFn: async (sessionId: string) => {
      await apiDelete(`/api/conversations/${sessionId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      toast.success("Conversation deleted");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to delete conversation");
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
      toast.success("Exported conversation");
    } catch {
      toast.error("Failed to export conversation");
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
      toast.success(`Exported ${all.length} conversations`);
    } catch {
      toast.error("Failed to export conversations");
    }
  }, [conversationsQuery.data]);

  const debouncedSearch = useMemo(() => {
    let timer: ReturnType<typeof setTimeout>;
    return (value: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => setSearch(value), 300);
    };
  }, []);

  return (
    <div className="p-4 sm:p-6">
      <h1 className="text-lg font-semibold">Conversations</h1>
      <p className="mt-1 text-sm text-muted-foreground">Session history</p>

      <div className="mt-4 flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search sessions..."
            className="pl-9"
            onChange={(e) => debouncedSearch(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSort(sort === "recent" ? "messages" : "recent")}
          className="gap-1.5"
        >
          <ArrowUpDown className="size-3.5" />
          <span className="hidden sm:inline">{sort === "recent" ? "Most Recent" : "Most Messages"}</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleExportAll}
          className="gap-1.5"
          disabled={!conversationsQuery.data?.length}
        >
          <Download className="size-3.5" />
          <span className="hidden sm:inline">Export All</span>
        </Button>
      </div>

      <QueryBoundary
        query={conversationsQuery}
        skeleton={<ConversationsSkeleton />}
        errorTitle="Failed to load conversations"
      >
        {(conversations) => (
          <div className="mt-4 space-y-2">
            {conversations.map((conv) => {
              const displayTitle = conv.title || (conv.firstMessage
                ? conv.firstMessage.slice(0, 80) + (conv.firstMessage.length > 80 ? "..." : "")
                : conv.sessionId);
              return (
                <div
                  key={conv.sessionId}
                  className="flex items-center justify-between rounded-xl border border-border px-4 py-3 cursor-pointer hover:border-foreground/20 transition-colors"
                  onClick={() => handleOpenChat(conv.sessionId)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className={cn("text-sm truncate", conv.title ? "font-medium" : "text-muted-foreground italic")}>
                        {displayTitle}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {conv.messageCount} messages · {new Date(conv.lastActive).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleExport(conv);
                      }}
                    >
                      <Download className="size-4 text-muted-foreground" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
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
                title={search ? "No matching conversations" : "No conversations yet"}
                description={search ? "Try a different search term" : "Start chatting to create your first conversation"}
                action={search ? undefined : { label: "Start a conversation", onClick: () => navigate("/chat") }}
              />
            )}
          </div>
        )}
      </QueryBoundary>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete conversation"
        description="This action cannot be undone. The entire conversation history will be permanently deleted."
        actionLabel="Delete"
        onAction={() => {
          if (deleteTarget) deleteConversation.mutate(deleteTarget);
        }}
      />
    </div>
  );
}

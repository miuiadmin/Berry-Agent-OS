/**
 * 对话历史列表页面。
 *
 * 编排搜索 / 排序 / 删除 / 导出，渲染对话列表。
 * 每条对话可点击打开聊天、导出 JSON、或删除。
 * Mutations + 导出逻辑 → use-conversation-mutations.ts
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { queries, type ConversationInfo } from "@/lib/api";
import { useChatStore } from "@/lib/stores/chat-store";
import { useDebouncedSearch } from "@/hooks/use-debounced-search";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryBoundary } from "@/components/ui/query-boundary";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { useT, useDateFormat } from "@/lib/i18n";
import {
  MessagesSquare,
  Trash2,
  Search,
  ArrowUpDown,
  MessageCircle,
  Download,
} from "lucide-react";
import { useConversationMutations } from "./use-conversation-mutations";

export default function ConversationsPage() {
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();
  useDocumentTitle(t("conversations.title"));

  // ── 状态 ──
  /** 排序方式：按最近活跃 / 按消息数量 */
  const [sort, setSort] = useState<"recent" | "messages">("recent");
  /** 待删除确认的 session ID */
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  /** 搜索关键词（带防抖） */
  const [search, debouncedSearch] = useDebouncedSearch();
  const navigate = useNavigate();

  // ── Chat store ──
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setSessionId = useChatStore((s) => s.setSessionId);

  // ── 数据查询 ──
  const conversationsQuery = useQuery({
    ...queries.conversations({ search: search || undefined, sort }),
    select: (data) => data as ConversationInfo[],
  });

  // ── Mutations ──
  const { deleteConversation, exportSingle, exportAll } =
    useConversationMutations();

  /** 打开对话：清理当前消息 + 设置 session + 跳转 */
  const handleOpenChat = (sid: string) => {
    clearMessages();
    setSessionId(sid);
    navigate("/chat");
  };

  return (
    <div className="p-4 sm:p-6">
      <PageHeader title={t("conversations.title")} subtitle={t("conversations.subtitle")} />

      {/* 工具栏：搜索 + 排序 + 导出全部 */}
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
          onClick={() =>
            setSort(sort === "recent" ? "messages" : "recent")
          }
          className="gap-1.5 min-h-[44px] md:min-h-0"
        >
          <ArrowUpDown className="size-3.5" />
          <span className="hidden sm:inline">
            {sort === "recent"
              ? t("conversations.mostRecent")
              : t("conversations.mostMessages")}
          </span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => exportAll(conversationsQuery.data ?? [])}
          className="gap-1.5 min-h-[44px] md:min-h-0"
          disabled={!conversationsQuery.data?.length}
        >
          <Download className="size-3.5" />
          <span className="hidden sm:inline">
            {t("conversations.exportAll")}
          </span>
        </Button>
      </div>

      {/* 对话列表 */}
      <QueryBoundary
        query={conversationsQuery}
        skeleton={<ConversationsSkeleton />}
        errorTitle={t("conversations.failedToLoad")}
      >
        {(conversations) => (
          <div className="mt-4 space-y-2">
            {conversations.map((conv, i) => (
              <ConversationItem
                key={conv.sessionId}
                conv={conv}
                index={i}
                onOpen={handleOpenChat}
                onExport={exportSingle}
                onDelete={setDeleteTarget}
              />
            ))}
            {conversations.length === 0 && (
              <EmptyState
                icon={search ? Search : MessageCircle}
                title={
                  search
                    ? t("conversations.noMatchingConversations")
                    : t("conversations.noConversations")
                }
                description={
                  search
                    ? t("conversations.tryDifferentSearch")
                    : t("conversations.startChatting")
                }
                action={
                  !search
                    ? {
                        label: t("conversations.startConversation"),
                        onClick: () => navigate("/chat"),
                      }
                    : undefined
                }
              />
            )}
          </div>
        )}
      </QueryBoundary>

      {/* 删除确认对话框 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
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

// ─── 子组件 ─────────────────────────────────────────────────────────

/** 标题最大长度（首条消息截取后超出加省略号） */
const TITLE_MAX = 80;

/** 展示标题：有标题用标题，无标题用首条消息截取，都没有用 sessionId */
function displayTitleFor(conv: ConversationInfo): string {
  if (conv.title) return conv.title;
  if (conv.firstMessage) {
    return conv.firstMessage.length > TITLE_MAX
      ? conv.firstMessage.slice(0, TITLE_MAX) + "..."
      : conv.firstMessage;
  }
  return conv.sessionId;
}

/** 单条对话项（行内展示标题 / 消息数 / 时间 + 操作按钮） */
function ConversationItem({
  conv,
  index,
  onOpen,
  onExport,
  onDelete,
}: {
  conv: ConversationInfo;
  /** 列表序号（用于 stagger 动画） */
  index: number;
  onOpen: (sessionId: string) => void;
  onExport: (conv: ConversationInfo) => void;
  onDelete: (sessionId: string) => void;
}) {
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();

  return (
    <div
      className={cn(
        "flex items-center justify-between rounded-xl border border-border px-4 py-3 cursor-pointer hover:border-foreground/20 active:border-foreground/10 active:scale-[0.99] transition-all conv-item",
        `stagger-${Math.min(index + 1, 8)}`,
      )}
      onClick={() => onOpen(conv.sessionId)}
    >
      {/* 左侧：图标 + 标题 + 副标题 */}
      <div className="flex items-center gap-3 min-w-0">
        <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p
            className={cn(
              "text-sm truncate",
              conv.title ? "font-medium" : "text-muted-foreground italic",
            )}
          >
            {displayTitleFor(conv)}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("conversations.messagesCount", {
              count: conv.messageCount,
            })}{" "}
            · {fmtDT(new Date(conv.lastActive))}
          </p>
        </div>
      </div>

      {/* 右侧：导出 + 删除按钮（44px 触控目标） */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("conversations.exportConversation")}
          className="min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0"
          onClick={(e) => {
            e.stopPropagation();
            onExport(conv);
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
            onDelete(conv.sessionId);
          }}
        >
          <Trash2 className="size-4 text-destructive" />
        </Button>
      </div>
    </div>
  );
}

/** 对话列表骨架屏 */
function ConversationsSkeleton() {
  return (
    <div className="mt-4 space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-xl border border-border px-4 py-3"
        >
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

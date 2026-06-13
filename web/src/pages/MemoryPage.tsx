/**
 * 记忆管理页面。
 *
 * 支持三层记忆（global / agent / workspace）的 CRUD + 搜索 + 验证 + 提升。
 * 页面编排层：筛选 / 列表 / 创建表单 / 删除确认。
 * Mutations → use-memory-mutations.ts
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain, Plus, Search, Trash2, ArrowUpRight, RefreshCw } from "lucide-react";
import { memoryApi, type MemoryEntry } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { QueryBoundary } from "@/components/ui/query-boundary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { useT, useDateFormat } from "@/lib/i18n";
import { useMemoryMutations } from "./use-memory-mutations";

type Layer = "agent" | "workspace" | "global";

export default function MemoryPage() {
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();
  useDocumentTitle(t("memory.title"));

  // ── 筛选 + 表单状态 ──
  /** 当前选中的 layer */
  const [layer, setLayer] = useState<Layer>("global");
  /** 当前 scope ID（user/agent/workspace 标识） */
  const [scopeId, setScopeId] = useState("default");
  /** 搜索关键词 */
  const [searchQuery, setSearchQuery] = useState("");
  /** 创建表单状态 */
  const [createState, setCreateState] = useState({ show: false, key: "", value: "" });
  /** 删除确认目标 */
  const [deleteTarget, setDeleteTarget] = useState<{ layer: string; id: string } | null>(null);

  // ── 数据查询 ──
  /** 当前 scope 的记忆列表 */
  const listQuery = useQuery({
    queryKey: ["memory", layer, scopeId],
    queryFn: () => {
      if (layer === "agent") return memoryApi.listAgent(scopeId);
      if (layer === "workspace") return memoryApi.listWorkspace(scopeId);
      return memoryApi.listGlobal(scopeId);
    },
    enabled: scopeId.length > 0,
  });

  /** 搜索（recall）查询 */
  const recallQuery = useQuery({
    queryKey: ["memory-recall", searchQuery],
    queryFn: (ctx) => memoryApi.recall(searchQuery, { limit: 50 }, ctx.signal),
    enabled: searchQuery.trim().length > 0,
  });

  // ── Mutations ──
  const { createMut, deleteMut, promoteMut, verifyMut } = useMemoryMutations(
    layer,
    scopeId,
    () => setCreateState({ show: false, key: "", value: "" }),
  );

  // ── 辅助：layer 配置 ──
  const layerPlaceholder: Record<Layer, string> = {
    agent: t("memory.enterAgentName"),
    workspace: t("memory.enterWorkspaceId"),
    global: t("memory.enterUserId"),
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* 页面头部 */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Brain className="size-5 text-brand" />
            {t("memory.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("memory.subtitle")}</p>
        </div>
        <Button
          onClick={() =>
            setCreateState((s) => ({ ...s, show: !s.show }))
          }
          size="sm"
          className="h-11 md:h-9"
        >
          <Plus className="mr-1 size-4" />
          {t("memory.addMemory")}
        </Button>
      </div>

      {/* Layer tabs + scope 选择 */}
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <Tabs value={layer} onValueChange={(v) => setLayer(v as Layer)}>
          <TabsList>
            <TabsTrigger value="global">{t("memory.global")}</TabsTrigger>
            <TabsTrigger value="agent">{t("memory.agent")}</TabsTrigger>
            <TabsTrigger value="workspace">{t("memory.workspace")}</TabsTrigger>
          </TabsList>
        </Tabs>
        {layer !== "global" && (
          <Input
            placeholder={layerPlaceholder[layer]}
            value={scopeId}
            onChange={(e) => setScopeId(e.target.value)}
            className="max-w-xs h-11 md:h-8"
          />
        )}
      </div>

      {/* 创建表单 */}
      {createState.show && (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <Input
              placeholder={t("memory.keyPlaceholder")}
              value={createState.key}
              onChange={(e) =>
                setCreateState((s) => ({ ...s, key: e.target.value }))
              }
              className="h-11 md:h-8"
            />
            <textarea
              placeholder={t("memory.valuePlaceholder")}
              value={createState.value}
              onChange={(e) =>
                setCreateState((s) => ({ ...s, value: e.target.value }))
              }
              rows={3}
              className="flex w-full rounded-md border bg-transparent px-3 py-2 text-[16px] md:text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={
                  !createState.key.trim() ||
                  !createState.value.trim() ||
                  createMut.isPending
                }
                onClick={() =>
                  createMut.mutate({
                    key: createState.key,
                    value: createState.value,
                  })
                }
              >
                {t("common.create")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setCreateState({ show: false, key: "", value: "" })
                }
              >
                {t("common.cancel")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 搜索框 */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t("memory.searchPlaceholder")}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9 h-11 md:h-8"
        />
      </div>

      {/* 记忆列表 */}
      <QueryBoundary query={listQuery} skeleton={<MemorySkeleton />}>
        {(memories) => {
          const entries: MemoryEntry[] = searchQuery.trim()
            ? (recallQuery.data?.results ?? [])
            : memories;

          return entries.length === 0 ? (
            <EmptyState
              icon={Brain}
              title={t("memory.noMemories")}
              description={
                searchQuery.trim()
                  ? t("memory.noMemoriesSearch")
                  : t("memory.noMemoriesDesc")
              }
              action={
                !searchQuery.trim()
                  ? {
                      label: t("memory.addMemory"),
                      onClick: () =>
                        setCreateState((s) => ({ ...s, show: true })),
                    }
                  : undefined
              }
            />
          ) : (
            <div className="space-y-2">
              {entries.map((entry) => (
                <MemoryCard
                  key={entry.id}
                  entry={entry}
                  fmtDT={fmtDT}
                  t={t}
                  onVerify={() => verifyMut.mutate(entry.id)}
                  onPromote={() =>
                    promoteMut.mutate({ id: entry.id, target: "global" })
                  }
                  onDelete={() =>
                    setDeleteTarget({ layer: entry.layer, id: entry.id })
                  }
                  verifyPending={verifyMut.isPending}
                  promotePending={promoteMut.isPending}
                />
              ))}
            </div>
          );
        }}
      </QueryBoundary>

      {/* 删除确认对话框 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("memory.deleteThisMemory")}
        description={t("memory.deleteConfirmDesc")}
        actionLabel={t("common.delete")}
        onAction={() => {
          if (deleteTarget) {
            deleteMut.mutate({
              entryLayer: deleteTarget.layer,
              id: deleteTarget.id,
            });
            setDeleteTarget(null);
          }
        }}
      />
    </div>
  );
}

// ─── 子组件 ─────────────────────────────────────────────────────────

/** 单条记忆卡片：key / layer badge / value / 操作按钮 */
function MemoryCard({
  entry,
  fmtDT,
  t,
  onVerify,
  onPromote,
  onDelete,
  verifyPending,
  promotePending,
}: {
  entry: MemoryEntry;
  fmtDT: (date: Date) => string;
  t: (key: string) => string;
  onVerify: () => void;
  onPromote: () => void;
  onDelete: () => void;
  verifyPending: boolean;
  promotePending: boolean;
}) {
  return (
    <Card className="group">
      <CardContent className="flex items-start gap-3 py-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{entry.key}</span>
            <Badge variant="outline" className="shrink-0 text-[11px]">
              {t(`memory.${entry.layer}`) ?? entry.layer}
            </Badge>
            {entry.verified && (
              <Badge variant="secondary" className="shrink-0 text-[11px]">
                {t("memory.verified")}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground line-clamp-2 whitespace-pre-wrap">
            {entry.value}
          </p>
          <p className="text-[11px] text-muted-foreground/70">
            {fmtDT(new Date(entry.createdAt))}
            {entry.source ? ` · ${entry.source}` : ""}
          </p>
        </div>
        {/* 操作按钮：移动端常驻，桌面端 hover 显示 */}
        <div className="flex shrink-0 gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="icon"
            className="size-11 md:size-8"
            title={t("memory.verify")}
            aria-label={t("memory.verify")}
            disabled={verifyPending}
            onClick={onVerify}
          >
            <RefreshCw className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 md:size-8"
            title={t("memory.promote")}
            aria-label={t("memory.promote")}
            disabled={promotePending}
            onClick={onPromote}
          >
            <ArrowUpRight className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "size-11 md:size-8 text-destructive hover:text-destructive",
            )}
            title={t("common.delete")}
            aria-label={t("common.delete")}
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** 记忆列表骨架屏 */
function MemorySkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="py-3">
            <div className="space-y-2">
              <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

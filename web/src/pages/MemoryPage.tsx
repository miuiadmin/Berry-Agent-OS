/**
 * 记忆管理页面。
 *
 * 支持三层记忆（global / agent / workspace）的 CRUD + 搜索 + 验证 + 提升。
 * 页面编排层：筛选 / 列表 / 创建表单 / 删除确认。
 * Mutations → use-memory-mutations.ts
 * 共享组件：PageHeader / TextAreaField → ui/
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain, Plus, Search, Trash2, ArrowUpRight, RefreshCw } from "lucide-react";
import { memoryApi, type MemoryEntry } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { QueryBoundary } from "@/components/ui/query-boundary";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { CardListSkeleton } from "@/components/ui/card-list-skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextAreaField } from "@/components/ui/text-area-field";
import { useT, useDateFormat } from "@/lib/i18n";
import { useMemoryMutations } from "./use-memory-mutations";

type Layer = "agent" | "workspace" | "global";

export default function MemoryPage() {
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();
  useDocumentTitle(t("memory.title"));

  // ── 筛选 + 表单状态 ──
  const [layer, setLayer] = useState<Layer>("global");
  const [scopeId, setScopeId] = useState("default");
  const [searchQuery, setSearchQuery] = useState("");
  const [createState, setCreateState] = useState({ show: false, key: "", value: "" });
  const [deleteTarget, setDeleteTarget] = useState<{ layer: string; id: string } | null>(null);

  // ── 数据查询 ──
  const listQuery = useQuery({
    queryKey: ["memory", layer, scopeId],
    queryFn: () => {
      if (layer === "agent") return memoryApi.listAgent(scopeId);
      if (layer === "workspace") return memoryApi.listWorkspace(scopeId);
      return memoryApi.listGlobal(scopeId);
    },
    enabled: scopeId.length > 0,
  });

  const recallQuery = useQuery({
    queryKey: ["memory-recall", searchQuery],
    queryFn: (ctx) => memoryApi.recall(searchQuery, { limit: 50 }, ctx.signal),
    enabled: searchQuery.trim().length > 0,
  });

  // ── Mutations ──
  const { createMut, deleteMut, promoteMut, verifyMut } = useMemoryMutations(
    layer, scopeId,
    () => setCreateState({ show: false, key: "", value: "" }),
  );

  /** layer → scope 输入框 placeholder */
  const layerPlaceholder: Record<Layer, string> = {
    agent: t("memory.enterAgentName"),
    workspace: t("memory.enterWorkspaceId"),
    global: t("memory.enterUserId"),
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader title={t("memory.title")} subtitle={t("memory.subtitle")} icon={Brain} iconClass="text-brand">
        <Button onClick={() => setCreateState((s) => ({ ...s, show: !s.show }))} size="sm" className="h-11 md:h-9">
          <Plus className="mr-1 size-4" />
          {t("memory.addMemory")}
        </Button>
      </PageHeader>

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
              onChange={(e) => setCreateState((s) => ({ ...s, key: e.target.value }))}
              className="h-11 md:h-8"
            />
            <TextAreaField
              placeholder={t("memory.valuePlaceholder")}
              value={createState.value}
              onChange={(e) => setCreateState((s) => ({ ...s, value: e.target.value }))}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={!createState.key.trim() || !createState.value.trim() || createMut.isPending}
                onClick={() => createMut.mutate({ key: createState.key, value: createState.value })}
              >
                {t("common.create")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setCreateState({ show: false, key: "", value: "" })}>
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
      <QueryBoundary query={listQuery} skeleton={<CardListSkeleton count={3} bars={["h-4 w-1/3", "h-3 w-2/3"]} />}>
        {(memories) => {
          const entries: MemoryEntry[] = searchQuery.trim()
            ? (recallQuery.data?.results ?? [])
            : memories;

          return entries.length === 0 ? (
            <EmptyState
              icon={Brain}
              title={t("memory.noMemories")}
              description={searchQuery.trim() ? t("memory.noMemoriesSearch") : t("memory.noMemoriesDesc")}
              action={!searchQuery.trim() ? {
                label: t("memory.addMemory"),
                onClick: () => setCreateState((s) => ({ ...s, show: true })),
              } : undefined}
            />
          ) : (
            <div className="space-y-2">
              {entries.map((entry) => (
                <MemoryCard
                  key={entry.id} entry={entry} fmtDT={fmtDT} t={t}
                  onVerify={() => verifyMut.mutate(entry.id)}
                  onPromote={() => promoteMut.mutate({ id: entry.id, target: "global" })}
                  onDelete={() => setDeleteTarget({ layer: entry.layer, id: entry.id })}
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
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("memory.deleteThisMemory")}
        description={t("memory.deleteConfirmDesc")}
        actionLabel={t("common.delete")}
        onAction={() => {
          if (deleteTarget) {
            deleteMut.mutate({ entryLayer: deleteTarget.layer, id: deleteTarget.id });
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
  entry, fmtDT, t, onVerify, onPromote, onDelete, verifyPending, promotePending,
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
              <Badge variant="secondary" className="shrink-0 text-[11px]">{t("memory.verified")}</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground line-clamp-2 whitespace-pre-wrap">{entry.value}</p>
          <p className="text-[11px] text-muted-foreground/70">
            {fmtDT(new Date(entry.createdAt))}
            {entry.source ? ` · ${entry.source}` : ""}
          </p>
        </div>
        {/* 操作按钮：移动端常驻，桌面端 hover 显示 */}
        <div className="flex shrink-0 gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
          <IconButton title={t("memory.verify")} disabled={verifyPending} onClick={onVerify}>
            <RefreshCw className="size-3.5" />
          </IconButton>
          <IconButton title={t("memory.promote")} disabled={promotePending} onClick={onPromote}>
            <ArrowUpRight className="size-3.5" />
          </IconButton>
          <IconButton title={t("common.delete")} onClick={onDelete} destructive>
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
      </CardContent>
    </Card>
  );
}

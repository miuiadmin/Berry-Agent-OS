import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Brain, Plus, Search, Trash2, ArrowUpRight, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { memoryApi, type MemoryEntry } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { QueryBoundary } from "@/components/shared/query-boundary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useT, useDateFormat } from "@/lib/i18n";

type Layer = "agent" | "workspace" | "global";

const LAYER_CONFIG: Record<Layer, { labelKey: string; placeholderKey: string }> = {
  agent: { labelKey: "memory.agent", placeholderKey: "memory.enterAgentName" },
  workspace: { labelKey: "memory.workspace", placeholderKey: "memory.enterWorkspaceId" },
  global: { labelKey: "memory.global", placeholderKey: "memory.enterUserId" },
};

function MemorySkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="py-3">
            <div className="space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function MemoryPage() {
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();
  useDocumentTitle(t("memory.title"));
  const qc = useQueryClient();

  const [layer, setLayer] = useState<Layer>("global");
  const [scopeId, setScopeId] = useState("default");
  const [searchQuery, setSearchQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  /** 删除确认对话框状态 */
  const [deleteTarget, setDeleteTarget] = useState<{ layer: string; id: string } | null>(null);

  // List memories for current scope
  const listQuery = useQuery({
    queryKey: ["memory", layer, scopeId],
    queryFn: () => {
      if (layer === "agent") return memoryApi.listAgent(scopeId);
      if (layer === "workspace") return memoryApi.listWorkspace(scopeId);
      return memoryApi.listGlobal(scopeId);
    },
    enabled: scopeId.length > 0,
  });

  // Recall (search) query
  const recallQuery = useQuery({
    queryKey: ["memory-recall", searchQuery],
    queryFn: () => memoryApi.recall(searchQuery, { limit: 50 }),
    enabled: searchQuery.trim().length > 0,
  });

  // Create mutation
  const createMut = useMutation({
    mutationFn: (data: { key: string; value: string }) => {
      if (layer === "agent") return memoryApi.createAgent({ agentId: scopeId, ...data });
      if (layer === "workspace") return memoryApi.createWorkspace({ workspaceId: scopeId, ...data });
      return memoryApi.createGlobal({ userId: scopeId, ...data });
    },
    onSuccess: () => {
      toast.success(t("memory.memoryCreated"));
      qc.invalidateQueries({ queryKey: ["memory", layer, scopeId] });
      setShowCreate(false);
      setNewKey("");
      setNewValue("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Delete mutation
  const deleteMut = useMutation({
    mutationFn: ({ entryLayer, id }: { entryLayer: string; id: string }) =>
      memoryApi.delete(entryLayer, id),
    onSuccess: () => {
      toast.success(t("memory.memoryDeleted"));
      qc.invalidateQueries({ queryKey: ["memory", layer, scopeId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Promote mutation
  const promoteMut = useMutation({
    mutationFn: ({ id, target }: { id: string; target: string }) =>
      memoryApi.promote(id, target),
    onSuccess: () => {
      toast.success(t("memory.memoryPromoted"));
      qc.invalidateQueries({ queryKey: ["memory", layer, scopeId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Verify mutation
  const verifyMut = useMutation({
    mutationFn: (id: string) => memoryApi.verify(id),
    onSuccess: () => {
      toast.success(t("memory.memoryVerified"));
      qc.invalidateQueries({ queryKey: ["memory", layer, scopeId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Brain className="size-5 text-brand" />
            {t("memory.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("memory.subtitle")}
          </p>
        </div>
        <Button
          onClick={() => setShowCreate(!showCreate)}
          size="sm"
          className="h-11 md:h-9"
        >
          <Plus className="mr-1 size-4" />
          {t("memory.addMemory")}
        </Button>
      </div>

      {/* Layer tabs + scope selector */}
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
            placeholder={t(LAYER_CONFIG[layer].placeholderKey)}
            value={scopeId}
            onChange={(e) => setScopeId(e.target.value)}
            className="max-w-xs h-11 md:h-8"
          />
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">{t("memory.newMemory")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              placeholder={t("memory.keyPlaceholder")}
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              className="h-11 md:h-8"
            />
            <Textarea
              placeholder={t("memory.valuePlaceholder")}
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              rows={3}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={!newKey.trim() || !newValue.trim() || createMut.isPending}
                onClick={() => createMut.mutate({ key: newKey, value: newValue })}
              >
                {t("common.create")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowCreate(false)}>
                {t("common.cancel")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t("memory.searchPlaceholder")}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9 h-11 md:h-8"
        />
      </div>

      {/* Memory list — always use listQuery for the boundary */}
      <QueryBoundary query={listQuery} skeleton={<MemorySkeleton />}>
        {(memories) => {
          // If user is searching, merge recall results instead
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
                  ? { label: t("memory.addMemory"), onClick: () => setShowCreate(true) }
                  : undefined
              }
            />
          ) : (
            <div className="space-y-2">
              {entries.map((entry) => (
                <Card key={entry.id} className="group">
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
                    <div className="flex shrink-0 gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-11 md:size-8"
                        title={t("memory.verify")}
                        aria-label={t("memory.verify")}
                        disabled={verifyMut.isPending}
                        onClick={() => verifyMut.mutate(entry.id)}
                      >
                        <RefreshCw className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-11 md:size-8"
                        title={t("memory.promote")}
                        aria-label={t("memory.promote")}
                        disabled={promoteMut.isPending}
                        onClick={() => promoteMut.mutate({ id: entry.id, target: "global" })}
                      >
                        <ArrowUpRight className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn("size-11 md:size-8 text-destructive hover:text-destructive")}
                        title={t("common.delete")}
                        aria-label={t("common.delete")}
                        onClick={() => setDeleteTarget({ layer: entry.layer, id: entry.id })}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          );
        }}
      </QueryBoundary>

      {/* 删除确认对话框 */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("memory.deleteThisMemory")}
        description={t("memory.deleteConfirmDesc")}
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

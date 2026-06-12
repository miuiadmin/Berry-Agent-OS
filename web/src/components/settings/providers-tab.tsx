import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiGet, apiPost, apiPut, apiDelete } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import {
  Plus,
  Server,
  Trash2,
  Wifi,
  WifiOff,
  ChevronRight,
  Zap,
  Brain,
  Crown,
  Pencil,
  Save,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────

interface ModelEntry {
  id: string;
  name: string;
  contextWindow: number;
  defaultMaxTokens: number;
  supportsThinking: boolean;
  supportsAttachments: boolean;
  inputPricePer1M?: number;
  outputPricePer1M?: number;
}

interface ProviderChannel {
  id: string;
  name: string;
  kind: string;
  baseUrl?: string;
  apiKey?: string;
  enabled: boolean;
  configured: boolean;
  modelCount: number;
  models: ModelEntry[];
}

interface TierTarget {
  channel: string;
  model: string;
}

interface TierMapping {
  fast?: TierTarget;
  default?: TierTarget;
  high?: TierTarget;
}

interface ChannelsResponse {
  ok: boolean;
  channels: ProviderChannel[];
}

interface TiersResponse {
  ok: boolean;
  tiers: TierMapping;
}

interface KindsResponse {
  ok: boolean;
  kinds: string[];
  supported?: string[];
}

interface CatalogResponse {
  ok: boolean;
  kind: string;
  models: ModelEntry[];
}

const PROVIDER_KIND_LABEL_KEYS: Record<string, string> = {
  anthropic: "providers.anthropic",
  openai: "providers.openai",
  "openai-compatible": "providers.openaiCompatible",
  "google-gemini": "providers.googleGemini",
  "azure-openai": "providers.azureOpenai",
  bedrock: "providers.awsBedrock",
};

const TIER_CONFIG = [
  { key: "fast" as const, labelKey: "providers.tierFast", icon: Zap, color: "text-success" },
  { key: "default" as const, labelKey: "providers.tierDefault", icon: Brain, color: "text-info" },
  { key: "high" as const, labelKey: "providers.tierHigh", icon: Crown, color: "text-warning" },
];

// ─── Main Component ───────────────────────────────────────────────

export function ProvidersTab() {
  const t = useT();
  const queryClient = useQueryClient();

  // ── Queries ──
  const { data: channelsData, isLoading: channelsLoading } = useQuery({
    queryKey: ["providers", "channels"],
    queryFn: () => apiGet<ChannelsResponse>("/api/providers/channels"),
  });
  const { data: tiersData } = useQuery({
    queryKey: ["providers", "tiers"],
    queryFn: () => apiGet<TiersResponse>("/api/providers/tiers"),
  });
  const { data: kindsData } = useQuery({
    queryKey: ["providers", "kinds"],
    queryFn: () => apiGet<KindsResponse>("/api/providers/kinds"),
  });

  const channels = channelsData?.channels ?? [];
  const tiers = tiersData?.tiers ?? {};
  const kinds = kindsData?.kinds ?? [];

  // ── Dialog state ──
  const [channelDialog, setChannelDialog] = useState<"add" | "edit" | null>(null);
  const [editingChannel, setEditingChannel] = useState<ProviderChannel | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // ── Form state ──
  const [formKind, setFormKind] = useState("");
  const [formId, setFormId] = useState("");
  const [formName, setFormName] = useState("");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  const [formEnabled, setFormEnabled] = useState(true);

  // ── Catalog query (fetched when user picks a kind in add mode) ──
  const { data: catalogData } = useQuery({
    queryKey: ["providers", "catalogs", formKind],
    queryFn: () => apiGet<CatalogResponse>(`/api/providers/catalogs/${formKind}`),
    enabled: channelDialog === "add" && !!formKind,
  });

  // ── Tier editor state ──
  const [editingTiers, setEditingTiers] = useState<TierMapping>({});
  const [tiersInitialized, setTiersInitialized] = useState(false);
  const [selectedTierChannel, setSelectedTierChannel] = useState<Record<string, string>>({});

  useEffect(() => {
    if (tiers && !tiersInitialized) {
      setEditingTiers(tiers);
      setSelectedTierChannel({
        fast: tiers.fast?.channel ?? "",
        default: tiers.default?.channel ?? "",
        high: tiers.high?.channel ?? "",
      });
      setTiersInitialized(true);
    }
  }, [tiers, tiersInitialized]);

  // Reset tier editor when server data changes after save
  useEffect(() => {
    if (tiersInitialized && tiers) {
      setEditingTiers(tiers);
      setSelectedTierChannel({
        fast: tiers.fast?.channel ?? "",
        default: tiers.default?.channel ?? "",
        high: tiers.high?.channel ?? "",
      });
    }
  }, [tiers, tiersInitialized]);

  // ── Mutations ──
  const testMutation = useMutation({
    mutationFn: async (channelId: string) => {
      return apiPost<{ ok: boolean; message?: string; error?: string }>(
        `/api/providers/channels/${channelId}/test`,
      );
    },
    onSuccess: (data) => {
      if (data.ok) {
        toast.success(t("providers.connectionSuccessful"));
      } else {
        toast.error(data.error ?? t("providers.connectionFailed"));
      }
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: {
      id: string;
      name: string;
      kind: string;
      baseUrl?: string;
      apiKey?: string;
      enabled: boolean;
    }) => {
      return apiPost<{ ok: boolean; channelId: string }>("/api/providers/channels", data);
    },
    onSuccess: () => {
      toast.success(t("providers.channelCreated"));
      refresh();
      closeChannelDialog();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      channelId,
      updates,
    }: {
      channelId: string;
      updates: Record<string, unknown>;
    }) => {
      return apiPut<{ ok: boolean }>(`/api/providers/channels/${channelId}`, updates);
    },
    onSuccess: () => {
      toast.success(t("providers.channelUpdated"));
      refresh();
      closeChannelDialog();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (channelId: string) => {
      return apiDelete(`/api/providers/channels/${channelId}`);
    },
    onSuccess: () => {
      toast.success(t("providers.channelDeleted"));
      refresh();
      setDeleteTarget(null);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const saveTiersMutation = useMutation({
    mutationFn: async (t: TierMapping) => {
      return apiPut<{ ok: boolean; tiers: TierMapping }>("/api/providers/tiers", t);
    },
    onSuccess: () => {
      toast.success(t("providers.tierMappingSaved"));
      refresh();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  // ── Helpers ──
  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["providers"] });
  }, [queryClient]);

  const closeChannelDialog = () => {
    setChannelDialog(null);
    setEditingChannel(null);
    setFormKind("");
    setFormId("");
    setFormName("");
    setFormBaseUrl("");
    setFormApiKey("");
    setFormEnabled(true);
  };

  const openAddDialog = () => {
    closeChannelDialog();
    setChannelDialog("add");
  };

  const openEditDialog = (ch: ProviderChannel) => {
    closeChannelDialog();
    setEditingChannel(ch);
    setFormKind(ch.kind);
    setFormId(ch.id);
    setFormName(ch.name);
    setFormBaseUrl(ch.baseUrl ?? "");
    setFormApiKey(""); // always blank — server masks it
    setFormEnabled(ch.enabled);
    setChannelDialog("edit");
  };

  const handleChannelSubmit = () => {
    if (channelDialog === "add") {
      createMutation.mutate({
        id: formId.trim(),
        name: formName.trim() || formId.trim(),
        kind: formKind,
        baseUrl: formBaseUrl.trim() || undefined,
        apiKey: formApiKey.trim() || undefined,
        enabled: true,
      });
    } else if (channelDialog === "edit" && editingChannel) {
      const updates: Record<string, unknown> = {};
      if (formName.trim()) updates.name = formName.trim();
      if (formBaseUrl.trim()) updates.baseUrl = formBaseUrl.trim();
      if (formApiKey.trim()) updates.apiKey = formApiKey.trim();
      updates.enabled = formEnabled;
      updateMutation.mutate({ channelId: editingChannel.id, updates });
    }
  };

  const deleteTargetChannel = deleteTarget
    ? channels.find((c) => c.id === deleteTarget)
    : null;

  // ── Render ──
  if (channelsLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Channel List */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="text-base">{t("providers.providerChannels")}</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              {t("providers.providerChannelsDesc")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={openAddDialog}
            className=""
          >
            <Plus className="size-4" />
            {t("providers.addChannel")}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {channels.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center">
              <Server className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                {t("providers.noChannels")}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={openAddDialog}
                className="mt-3 "
              >
                <Plus className="size-4" />
                {t("providers.addFirstChannel")}
              </Button>
            </div>
          ) : (
            channels.map((ch) => (
              <ChannelCard
                key={ch.id}
                channel={ch}
                onTest={() => testMutation.mutate(ch.id)}
                isTesting={testMutation.isPending}
                onEdit={() => openEditDialog(ch)}
                onDelete={() => setDeleteTarget(ch.id)}
              />
            ))
          )}
        </CardContent>
      </Card>

      {/* Tier Mapping */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="text-base">{t("providers.tierMapping")}</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              {t("providers.tierMappingDesc")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => saveTiersMutation.mutate(editingTiers)}
            disabled={saveTiersMutation.isPending}
            className=""
          >
            <Save className="size-4" />
            {t("providers.saveTiers")}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {TIER_CONFIG.map(({ key, labelKey, icon: Icon, color }) => {
            const channel = selectedTierChannel[key] ?? "";
            const selectedCh = channels.find((c) => c.id === channel);
            const models = selectedCh?.models ?? [];
            const target = editingTiers[key];

            return (
              <div
                key={key}
                className="rounded-lg border border-border px-3 py-3 space-y-2"
              >
                <div className="flex items-center gap-2">
                  <Icon className={cn("size-4 shrink-0", color)} />
                  <span className="text-sm font-medium">{t(labelKey)}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Select
                    value={channel}
                    onValueChange={(ch) => {
                      setSelectedTierChannel((prev) => ({ ...prev, [key]: ch }));
                      setEditingTiers((prev) => ({
                        ...prev,
                        [key]: ch ? { channel: ch, model: "" } : undefined,
                      }));
                    }}
                    placeholder={t("chat.notConfigured")}
                    options={channels.map((c) => ({
                      key: c.id,
                      label: `${c.name} (${c.kind})`,
                    }))}
                  />
                  <Select
                    value={target?.model ?? ""}
                    onValueChange={(model) => {
                      setEditingTiers((prev) => ({
                        ...prev,
                        [key]: channel ? { channel, model } : undefined,
                      }));
                    }}
                    disabled={!channel || models.length === 0}
                    placeholder={t("providers.selectModel")}
                    options={models.map((m) => ({ key: m.id, label: m.name }))}
                  />
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("providers.deleteChannel")}
        description={t("providers.deleteChannelConfirm", { name: deleteTargetChannel?.name ?? (deleteTarget as string) })}
        actionLabel={t("common.delete")}
        onAction={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget);
        }}
      />

      {/* Add/Edit dialog */}
      <ChannelFormDialog
        mode={channelDialog === "edit" ? "edit" : "add"}
        open={!!channelDialog}
        onOpenChange={(open) => {
          if (!open) closeChannelDialog();
        }}
        kinds={kinds}
        formKind={formKind}
        setFormKind={setFormKind}
        formId={formId}
        setFormId={setFormId}
        formName={formName}
        setFormName={setFormName}
        formBaseUrl={formBaseUrl}
        setFormBaseUrl={setFormBaseUrl}
        formApiKey={formApiKey}
        setFormApiKey={setFormApiKey}
        formEnabled={formEnabled}
        setFormEnabled={setFormEnabled}
        catalogModels={catalogData?.models ?? []}
        onSubmit={handleChannelSubmit}
        isPending={createMutation.isPending || updateMutation.isPending}
      />
    </div>
  );
}

// ─── Channel Form Dialog ──────────────────────────────────────────

function ChannelFormDialog({
  mode,
  open,
  onOpenChange,
  kinds,
  formKind,
  setFormKind,
  formId,
  setFormId,
  formName,
  setFormName,
  formBaseUrl,
  setFormBaseUrl,
  formApiKey,
  setFormApiKey,
  formEnabled,
  setFormEnabled,
  catalogModels,
  onSubmit,
  isPending,
}: {
  mode: "add" | "edit";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kinds: string[];
  formKind: string;
  setFormKind: (v: string) => void;
  formId: string;
  setFormId: (v: string) => void;
  formName: string;
  setFormName: (v: string) => void;
  formBaseUrl: string;
  setFormBaseUrl: (v: string) => void;
  formApiKey: string;
  setFormApiKey: (v: string) => void;
  formEnabled: boolean;
  setFormEnabled: (v: boolean) => void;
  catalogModels: ModelEntry[];
  onSubmit: () => void;
  isPending: boolean;
}) {
  const isEdit = mode === "edit";
  const t = useT();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("providers.editChannel") : t("providers.addChannelTitle")}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? t("providers.editChannelDesc")
              : t("providers.addChannelDesc")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5 mt-2">
          {/* Kind */}
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t("providers.providerKind")}
            </label>
            <Select
              value={formKind}
              onValueChange={(k) => {
                setFormKind(k);
                if (!isEdit) setFormId("");
              }}
              disabled={isEdit}
              placeholder={t("providers.selectKind")}
              options={kinds.map((k) => ({
                key: k,
                label: t(PROVIDER_KIND_LABEL_KEYS[k] ?? k),
              }))}
            />
          </div>

          {/* ID */}
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t("providers.channelId")}
            </label>
            <Input
              value={formId}
              onChange={(e) => setFormId(e.target.value)}
              disabled={isEdit}
              placeholder={t("providers.channelIdPlaceholder")}
              className="h-10 md:h-8 disabled:opacity-50"
            />
          </div>

          {/* Name */}
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t("providers.displayName")}
            </label>
            <Input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder={t("providers.displayNamePlaceholder")}
              className="h-10 md:h-8"
            />
          </div>

          {/* Base URL */}
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t("providers.baseUrl")}
            </label>
            <Input
              value={formBaseUrl}
              onChange={(e) => setFormBaseUrl(e.target.value)}
              placeholder={t("providers.baseUrlPlaceholder")}
              className="h-10 md:h-8"
            />
          </div>

          {/* API Key */}
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t("providers.apiKey")} {isEdit && t("providers.apiKeyKeepCurrent")}
            </label>
            <Input
              type="password"
              value={formApiKey}
              onChange={(e) => setFormApiKey(e.target.value)}
              placeholder={isEdit ? t("providers.apiKeyEditPlaceholder") : t("providers.apiKeyPlaceholder")}
              className="h-10 md:h-8"
            />
          </div>

          {/* Enabled (edit only) */}
          {isEdit && (
            <div className="flex items-center gap-2">
              <Switch checked={formEnabled} onCheckedChange={setFormEnabled} />
              <span className="text-sm text-muted-foreground">
                {formEnabled ? t("common.enabled") : t("common.disabled")}
              </span>
            </div>
          )}

          {/* Model catalog preview (add only) */}
          {!isEdit && formKind && catalogModels.length > 0 && (
            <div className="rounded-lg border border-border p-3 max-h-40 overflow-y-auto">
              <p className="text-[11px] font-medium text-muted-foreground mb-2">
                {t("providers.builtinModels", { kind: t(PROVIDER_KIND_LABEL_KEYS[formKind] ?? formKind) })}:
              </p>
              <div className="space-y-1">
                {catalogModels.map((m) => (
                  <div
                    key={m.id}
                    className="text-xs font-mono text-muted-foreground truncate"
                  >
                    {m.id}
                  </div>
                ))}
              </div>
            </div>
          )}

          <DialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <Button
              variant="outline"
              type="button"
              onClick={() => onOpenChange(false)}
              className="w-full sm:w-auto "
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={
                isPending ||
                !formKind ||
                !formId ||
                (!isEdit && !formApiKey)
              }
              className="w-full sm:w-auto "
            >
              {isPending ? t("common.saving") : isEdit ? t("common.update") : t("common.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Channel Card ─────────────────────────────────────────────────

function ChannelCard({
  channel,
  onTest,
  isTesting,
  onEdit,
  onDelete,
}: {
  channel: ProviderChannel;
  onTest: () => void;
  isTesting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const t = useT();

  return (
    <div className="rounded-lg border border-border">
      {/* Header — two rows on mobile, single row on desktop */}
      <div className="px-3 py-2.5 md:py-2">
        {/* Row 1: expand + status + name */}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-label={t("providers.toggleModels")}
            className="shrink-0 size-11 md:size-7"
          >
            <ChevronRight className={cn("size-4 transition-transform duration-200", expanded && "rotate-90")} />
          </Button>

          {channel.enabled ? (
            <Wifi className="size-3.5 text-success shrink-0" />
          ) : (
            <WifiOff className="size-3.5 text-muted-foreground shrink-0" />
          )}
          <span className="text-sm font-medium truncate flex-1">{channel.name}</span>
          <span className="text-[11px] text-muted-foreground font-mono shrink-0 hidden sm:inline">
            {t(PROVIDER_KIND_LABEL_KEYS[channel.kind] ?? channel.kind)}
          </span>

          {/* Desktop: actions inline */}
          <span className="text-xs text-muted-foreground shrink-0 hidden md:inline">
            {t("providers.modelsCount", { count: String(channel.modelCount) })}
          </span>
          <div className="hidden md:flex items-center gap-0.5">
            <Button variant="ghost" size="sm" onClick={onEdit} className="shrink-0 size-7" aria-label={t("providers.editChannel")}>
              <Pencil className="size-3.5" />
            </Button>
            <Button variant="ghost" size="sm" onClick={onDelete} className="shrink-0  size-7 text-muted-foreground" aria-label={t("providers.deleteChannel")}>
              <Trash2 className="size-3.5" />
            </Button>
            <Button variant="ghost" size="sm" onClick={onTest} disabled={isTesting || !channel.configured} className="shrink-0 text-xs h-7">
              {isTesting ? t("providers.testChannelRunning") : t("providers.testChannel")}
            </Button>
          </div>
        </div>

        {/* Mobile: actions row */}
        <div className="flex items-center gap-1 mt-1.5 pl-10 md:hidden">
          <span className="text-xs text-muted-foreground mr-auto">
            {t("providers.modelsCount", { count: String(channel.modelCount) })} · {t(PROVIDER_KIND_LABEL_KEYS[channel.kind] ?? channel.kind)}
          </span>
          <Button variant="ghost" size="sm" onClick={onEdit} className="shrink-0 size-8" aria-label={t("providers.editChannel")}>
            <Pencil className="size-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete} className="shrink-0  size-8 text-muted-foreground" aria-label={t("providers.deleteChannel")}>
            <Trash2 className="size-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onTest} disabled={isTesting || !channel.configured} className="shrink-0 text-xs ">
            {isTesting ? "..." : t("providers.testChannel")}
          </Button>
        </div>
      </div>

      {/* Models list (expandable) */}
      {expanded && channel.models.length > 0 && (
        <div className="border-t border-border px-3 py-2 max-h-64 overflow-y-auto">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 gap-y-1 text-xs">
            <span className="font-medium text-muted-foreground">{t("providers.model")}</span>
            <span className="font-medium text-muted-foreground text-right">{t("providers.context")}</span>
            <span className="font-medium text-muted-foreground text-right">{t("providers.maxOut")}</span>
            <span className="font-medium text-muted-foreground text-right">{t("providers.priceInOut")}</span>

            {channel.models.map((m) => (
              <ModelRow key={m.id} model={m} />
            ))}
          </div>
        </div>
      )}

      {expanded && channel.models.length === 0 && (
        <div className="border-t border-border px-3 py-3 text-xs text-muted-foreground text-center">
          {t("providers.noModelsForChannel")}
        </div>
      )}
    </div>
  );
}

// ─── Model Row ────────────────────────────────────────────────────

function ModelRow({ model }: { model: ModelEntry }) {
  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
  };

  return (
    <>
      <span className="font-mono truncate" title={model.id}>
        {model.name}
      </span>
      <span className="text-right text-muted-foreground">
        {formatTokens(model.contextWindow)}
      </span>
      <span className="text-right text-muted-foreground">
        {formatTokens(model.defaultMaxTokens)}
      </span>
      <span className="text-right text-muted-foreground">
        {model.inputPricePer1M != null
          ? `$${model.inputPricePer1M}/${model.outputPricePer1M ?? "-"}`
          : "—"}
      </span>
    </>
  );
}

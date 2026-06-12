/**
 * Provider 设置面板（主组件）。
 *
 * 职责：
 *   - 拉取 channels / tiers / kinds 三组数据
 *   - 维护 channel 新增 / 编辑 / 删除的交互状态
 *   - 维护 tier 映射编辑器状态（三档模型档位）
 *
 * 渲染细节下放到子组件：
 *   - {@link ChannelCard} / 模型行 → channel-card.tsx
 *   - {@link ChannelFormDialog}（表单状态内聚）→ channel-form-dialog.tsx
 *   - 类型 / 常量 / SelectChevron → providers-types.ts
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiGet, apiPost, apiPut, apiDelete } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { Plus, Server, Save } from "lucide-react";
import {
  type ProviderChannel,
  type TierMapping,
  type ChannelsResponse,
  type TiersResponse,
  type KindsResponse,
  TIER_CONFIG,
  SELECT_BASE,
  SelectChevron,
} from "./providers-types";
import { ChannelCard } from "./channel-card";
import { ChannelFormDialog, type ChannelFormData } from "./channel-form-dialog";

export function ProvidersTab() {
  const t = useT();
  const queryClient = useQueryClient();

  // ── 数据查询 ──
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

  // ── 弹窗状态 ──
  /** 当前打开的渠道弹窗模式（null = 关闭） */
  const [channelDialog, setChannelDialog] = useState<"add" | "edit" | null>(null);
  /** 编辑模式下的目标渠道（add 模式为 null） */
  const [editingChannel, setEditingChannel] = useState<ProviderChannel | null>(null);
  /** 待删除的渠道 ID（非 null 时弹出确认框） */
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // ── tier 编辑器状态 ──
  const tierEditor = useTierEditor(tiers);

  // ── Mutations ──
  const { testChannel, createChannel, updateChannel, deleteChannel, saveTiers, pendingFlags } =
    useProviderMutations(() => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      setChannelDialog(null);
      setEditingChannel(null);
      setDeleteTarget(null);
    });

  /** 删除确认框展示用的渠道对象 */
  const deleteTargetChannel = deleteTarget
    ? channels.find((c) => c.id === deleteTarget)
    : null;

  if (channelsLoading) {
    return <LoadingSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* 渠道列表 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="text-base">
              {t("providers.providerChannels")}
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("providers.providerChannelsDesc")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={openAdd}
            className="min-h-[44px] md:min-h-0"
          >
            <Plus className="size-4" />
            {t("providers.addChannel")}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {channels.length === 0 ? (
            <EmptyChannels onAdd={openAdd} />
          ) : (
            channels.map((ch) => (
              <ChannelCard
                key={ch.id}
                channel={ch}
                onTest={() => testChannel(ch.id)}
                isTesting={pendingFlags.testing}
                onEdit={() => openEdit(ch)}
                onDelete={() => setDeleteTarget(ch.id)}
              />
            ))
          )}
        </CardContent>
      </Card>

      {/* tier 映射编辑器 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="text-base">
              {t("providers.tierMapping")}
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("providers.tierMappingDesc")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => saveTiers(tierEditor.editingTiers)}
            disabled={pendingFlags.savingTiers}
            className="min-h-[44px] md:min-h-0"
          >
            <Save className="size-4" />
            {t("providers.saveTiers")}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <TierEditor channels={channels} editor={tierEditor} />
        </CardContent>
      </Card>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("providers.deleteChannel")}
        description={t("providers.deleteChannelConfirm", {
          name: deleteTargetChannel?.name ?? (deleteTarget as string),
        })}
        actionLabel={t("common.delete")}
        onAction={() => {
          if (deleteTarget) deleteChannel(deleteTarget);
        }}
      />

      {/* 新增 / 编辑表单弹窗 */}
      <ChannelFormDialog
        mode={channelDialog === "edit" ? "edit" : "add"}
        open={!!channelDialog}
        onOpenChange={(open) => {
          if (!open) {
            setChannelDialog(null);
            setEditingChannel(null);
          }
        }}
        kinds={kinds}
        editingChannel={editingChannel}
        onSubmit={(data: ChannelFormData) => {
          if (channelDialog === "edit" && editingChannel) {
            // 编辑：只提交变更字段（apiKey 留空 = 服务端保持不变）
            const updates: Record<string, unknown> = {};
            if (data.name) updates.name = data.name;
            if (data.baseUrl) updates.baseUrl = data.baseUrl;
            if (data.apiKey) updates.apiKey = data.apiKey;
            updates.enabled = data.enabled;
            updateChannel(editingChannel.id, updates);
          } else {
            // 新增
            createChannel(data);
          }
        }}
        isPending={pendingFlags.creating || pendingFlags.updating}
      />
    </div>
  );

  // ── 本地辅助：打开弹窗 ──

  /** 打开新增弹窗 */
  function openAdd() {
    setEditingChannel(null);
    setChannelDialog("add");
  }

  /** 打开编辑弹窗（回填目标渠道） */
  function openEdit(ch: ProviderChannel) {
    setEditingChannel(ch);
    setChannelDialog("edit");
  }
}

// ─── Loading / Empty 子组件 ───────────────────────────────────────

/** 加载骨架屏（3 行占位） */
function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      <div className="h-10 w-full animate-pulse rounded-md bg-muted" />
      <div className="h-24 w-full animate-pulse rounded-md bg-muted" />
      <div className="h-24 w-full animate-pulse rounded-md bg-muted" />
    </div>
  );
}

/** 无渠道时的空状态 */
function EmptyChannels({ onAdd }: { onAdd: () => void }) {
  const t = useT();
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center">
      <Server className="mx-auto mb-2 size-8 text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">
        {t("providers.noChannels")}
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={onAdd}
        className="mt-3 min-h-[44px] md:min-h-0"
      >
        <Plus className="size-4" />
        {t("providers.addFirstChannel")}
      </Button>
    </div>
  );
}

// ─── Tier 编辑器 ──────────────────────────────────────────────────

/** tier 编辑器状态（从服务端 tiers 初始化，本地编辑，保存时提交） */
function useTierEditor(tiers: TierMapping) {
  const [editingTiers, setEditingTiers] = useState<TierMapping>({});
  const [tiersInitialized, setTiersInitialized] = useState(false);
  /** 每个 tier 当前选中的 channel（用于联动显示该 channel 下的模型列表） */
  const [selectedTierChannel, setSelectedTierChannel] = useState<
    Record<string, string>
  >({});

  /** 从服务端 tiers 重建本地编辑状态 */
  function syncFromServer(serverTiers: TierMapping) {
    setEditingTiers(serverTiers);
    setSelectedTierChannel({
      fast: serverTiers.fast?.channel ?? "",
      default: serverTiers.default?.channel ?? "",
      high: serverTiers.high?.channel ?? "",
    });
  }

  // 首次加载 + 保存后服务端数据变化时，同步本地状态
  useEffect(() => {
    if (!tiersInitialized) {
      syncFromServer(tiers);
      setTiersInitialized(true);
    } else {
      syncFromServer(tiers);
    }
  }, [tiers, tiersInitialized]);

  return {
    editingTiers,
    setEditingTiers,
    selectedTierChannel,
    setSelectedTierChannel,
  };
}

/** tier 映射编辑器 UI：三档（fast/default/high）各选 channel + model */
function TierEditor({
  channels,
  editor,
}: {
  channels: ProviderChannel[];
  editor: ReturnType<typeof useTierEditor>;
}) {
  const t = useT();
  const { editingTiers, setEditingTiers, selectedTierChannel, setSelectedTierChannel } =
    editor;

  return (
    <>
      {TIER_CONFIG.map(({ key, labelKey, icon: Icon, color }) => {
        const channel = selectedTierChannel[key] ?? "";
        const selectedCh = channels.find((c) => c.id === channel);
        const models = selectedCh?.models ?? [];
        const target = editingTiers[key];

        return (
          <div
            key={key}
            className="space-y-2 rounded-lg border border-border px-3 py-3"
          >
            <div className="flex items-center gap-2">
              <Icon className={cn("size-4 shrink-0", color)} />
              <span className="text-sm font-medium">{t(labelKey)}</span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {/* channel 选择 */}
              <div className="relative">
                <select
                  value={channel}
                  onChange={(e) => {
                    const ch = e.target.value;
                    setSelectedTierChannel((prev) => ({ ...prev, [key]: ch }));
                    setEditingTiers((prev) => ({
                      ...prev,
                      [key]: ch ? { channel: ch, model: "" } : undefined,
                    }));
                  }}
                  className={SELECT_BASE}
                >
                  <option value="">{t("chat.notConfigured")}</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.kind})
                    </option>
                  ))}
                </select>
                <SelectChevron />
              </div>
              {/* model 选择（依赖已选 channel 的模型列表） */}
              <div className="relative">
                <select
                  value={target?.model ?? ""}
                  onChange={(e) => {
                    const model = e.target.value;
                    setEditingTiers((prev) => ({
                      ...prev,
                      [key]: channel ? { channel, model } : undefined,
                    }));
                  }}
                  disabled={!channel || models.length === 0}
                  className={SELECT_BASE}
                >
                  <option value="">{t("providers.selectModel")}</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <SelectChevron />
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

// ─── Provider Mutations ───────────────────────────────────────────

/** 所有 provider 相关 mutation 的集合，统一 toast 反馈 + 成功后刷新 */
function useProviderMutations(onSuccess: () => void) {
  const t = useT();

  const testMutation = useMutation({
    mutationFn: (channelId: string) =>
      apiPost<{ ok: boolean; message?: string; error?: string }>(
        `/api/providers/channels/${channelId}/test`,
      ),
    onSuccess: (data) => {
      if (data.ok) toast.success(t("providers.connectionSuccessful"));
      else toast.error(data.error ?? t("providers.connectionFailed"));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const createMutation = useMutation({
    mutationFn: (data: ChannelFormData) =>
      apiPost<{ ok: boolean; channelId: string }>(
        "/api/providers/channels",
        data,
      ),
    onSuccess: () => {
      toast.success(t("providers.channelCreated"));
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({
      channelId,
      updates,
    }: {
      channelId: string;
      updates: Record<string, unknown>;
    }) =>
      apiPut<{ ok: boolean }>(`/api/providers/channels/${channelId}`, updates),
    onSuccess: () => {
      toast.success(t("providers.channelUpdated"));
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (channelId: string) =>
      apiDelete(`/api/providers/channels/${channelId}`),
    onSuccess: () => {
      toast.success(t("providers.channelDeleted"));
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const saveTiersMutation = useMutation({
    mutationFn: (tm: TierMapping) =>
      apiPut<{ ok: boolean; tiers: TierMapping }>("/api/providers/tiers", tm),
    onSuccess: () => {
      toast.success(t("providers.tierMappingSaved"));
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return {
    testChannel: testMutation.mutate,
    createChannel: createMutation.mutate,
    updateChannel: (channelId: string, updates: Record<string, unknown>) =>
      updateMutation.mutate({ channelId, updates }),
    deleteChannel: deleteMutation.mutate,
    saveTiers: saveTiersMutation.mutate,
    pendingFlags: {
      testing: testMutation.isPending,
      creating: createMutation.isPending,
      updating: updateMutation.isPending,
      savingTiers: saveTiersMutation.isPending,
    },
  };
}

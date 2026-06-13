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
 *   - {@link TierEditor} + useTierEditor → tier-editor.tsx
 *   - useProviderMutations → use-provider-mutations.ts
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n";
import { Plus, Server, Save } from "lucide-react";
import {
  type ProviderChannel,
  type ChannelsResponse,
  type TiersResponse,
  type KindsResponse,
} from "./providers-types";
import { ChannelCard } from "./channel-card";
import { ChannelFormDialog, type ChannelFormData } from "./channel-form-dialog";
import { TierEditor, useTierEditor } from "./tier-editor";
import { useProviderMutations } from "./use-provider-mutations";

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

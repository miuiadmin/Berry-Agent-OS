/**
 * TierEditor — Provider 三档模型映射编辑器。
 *
 * 从 providers-tab.tsx 提取，包含：
 *   - useTierEditor hook：管理 tier 编辑状态
 *   - TierEditor 组件：三档（fast/default/high）各选 channel + model
 */

import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import {
  type ProviderChannel,
  type TierMapping,
  type TierTarget,
  TIER_CONFIG,
} from "./providers-types";
import { SelectField } from "@/components/ui/select-field";

/** 每 tier 当前选中 channel 的索引：tier key → channel id（空串表示未选） */
type SelectedChannelMap = Record<string, string>;

/**
 * 浅比较两个 TierMapping：key 集合相同且每键的 {channel,model} 都相等。
 * 用于判断"服务端数据是否真的变了"，避免无谓的本地覆盖（保护用户未保存编辑）。
 */
function tierMappingEqual(a: TierMapping, b: TierMapping): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    // TierMapping 是固定三键（fast/default/high）的可选接口；用 as 索引绕过 TS 的
    // "string 不能索引字面量键接口"限制（Object.keys 只能给 string[]，无法收窄回 TierKey）。
    const av = (a as Record<string, TierTarget | undefined>)[k];
    const bv = (b as Record<string, TierTarget | undefined>)[k];
    if ((av?.channel ?? "") !== (bv?.channel ?? "")) return false;
    if ((av?.model ?? "") !== (bv?.model ?? "")) return false;
  }
  return true;
}

// ─── useTierEditor Hook ──────────────────────────────────────────

/**
 * tier 编辑器状态管理 hook。
 * 从服务端 tiers 初始化本地编辑状态，保存时由父组件提交 editingTiers。
 */
export function useTierEditor(tiers: TierMapping) {
  /** 本地编辑中的 tier 映射（保存时整体提交，支持"恢复未保存改动"前的回滚） */
  const [editingTiers, setEditingTiers] = useState<TierMapping>({});
  /** 每个 tier 当前选中的 channel（用于联动显示该 channel 下的模型列表） */
  const [selectedTierChannel, setSelectedTierChannel] = useState<SelectedChannelMap>({});
  /**
   * 最近一次"已知来自服务端"的 tiers 快照。
   *
   * 用于区分两种 tiers prop 变化：
   *   - 服务端真变化（与快照不同）→ 需要重建本地编辑态
   *   - 用户已编辑、服务端数据未变（与快照相同，仅 refetch 重传）→ 必须跳过覆盖，
   *     否则窗口聚焦/重连/revalidate 时的后台 refetch 会静默丢弃用户未保存编辑。
   */
  const lastServerTiersRef = useRef<TierMapping>({});

  /** 从服务端 tiers 重建本地编辑状态（初始化 + 保存后服务端数据回流时） */
  function syncFromServer(serverTiers: TierMapping) {
    setEditingTiers(serverTiers);
    // 从 TIER_CONFIG 派生 channel 映射，避免硬编码 fast/default/high 三键字面量
    setSelectedTierChannel(
      Object.fromEntries(
        TIER_CONFIG.map(({ key }) => [key, serverTiers[key]?.channel ?? ""]),
      ),
    );
    lastServerTiersRef.current = serverTiers;
  }

  // 仅在"服务端数据真变化"时同步本地状态。
  // 关键：用 lastServerTiersRef 守门——若 tiers prop 与上次同步的服务端快照一致
  // （典型场景：React Query 后台 refetch 返回了相同数据，或保存成功后 onSuccess 触发的
  // invalidate 让相同数据回流），就跳过 syncFromServer，保护用户正在编辑的未保存改动。
  useEffect(() => {
    if (tierMappingEqual(tiers, lastServerTiersRef.current)) return;
    syncFromServer(tiers);
    // syncFromServer 内部已更新 ref，故依赖数组只列 tiers（ref 读写不进 deps）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiers]);

  return {
    editingTiers,
    setEditingTiers,
    selectedTierChannel,
    setSelectedTierChannel,
  };
}

// ─── TierEditor Component ────────────────────────────────────────

export function TierEditor({
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
        // 已选 channel 下的模型列表（用于联动 model 下拉）
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
              {/*
               * channel + model 双下拉联动：
               *   - 切换 channel → 重置该 tier 的 model（避免指向新 channel 不存在的 model）
               *   - 清空 channel → model 下拉禁用（disabled 依赖 !channel）
               * 两下拉通过 selectedTierChannel[key] 与 editingTiers[key] 隐式耦合，
               * 故分别挂 aria-label 关联 tier 名称，供读屏软件单独识别。
               */}
              <SelectField
                value={channel}
                aria-label={`${t(labelKey)} · ${t("providers.providerChannels")}`}
                onChange={(e) => {
                  const ch = e.target.value;
                  setSelectedTierChannel((prev) => ({ ...prev, [key]: ch }));
                  setEditingTiers((prev) => ({
                    ...prev,
                    [key]: ch ? { channel: ch, model: "" } : undefined,
                  }));
                }}
              >
                <option value="">{t("chat.notConfigured")}</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.kind})
                  </option>
                ))}
              </SelectField>
              <SelectField
                value={target?.model ?? ""}
                aria-label={`${t(labelKey)} · ${t("providers.model")}`}
                onChange={(e) => {
                  const model = e.target.value;
                  setEditingTiers((prev) => ({
                    ...prev,
                    [key]: channel ? { channel, model } : undefined,
                  }));
                }}
                disabled={!channel || models.length === 0}
              >
                <option value="">{t("providers.selectModel")}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </SelectField>
            </div>
          </div>
        );
      })}
    </>
  );
}

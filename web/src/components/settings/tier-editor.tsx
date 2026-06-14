/**
 * TierEditor — Provider 三档模型映射编辑器。
 *
 * 从 providers-tab.tsx 提取，包含：
 *   - useTierEditor hook：管理 tier 编辑状态
 *   - TierEditor 组件：三档（fast/default/high）各选 channel + model
 */

import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import {
  type ProviderChannel,
  type TierMapping,
  TIER_CONFIG,
} from "./providers-types";
import { SelectField } from "@/components/ui/select-field";

/** 每 tier 当前选中 channel 的索引：tier key → channel id（空串表示未选） */
type SelectedChannelMap = Record<string, string>;

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

  /** 从服务端 tiers 重建本地编辑状态（初始化 + 保存后服务端数据回流时） */
  function syncFromServer(serverTiers: TierMapping) {
    setEditingTiers(serverTiers);
    // 从 TIER_CONFIG 派生 channel 映射，避免硬编码 fast/default/high 三键字面量
    setSelectedTierChannel(
      Object.fromEntries(
        TIER_CONFIG.map(({ key }) => [key, serverTiers[key]?.channel ?? ""]),
      ),
    );
  }

  // 首次加载 + 保存后服务端数据变化时，同步本地状态
  useEffect(() => {
    syncFromServer(tiers);
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
              {/* channel 选择：切换时重置该 tier 的 model（避免指向新 channel 不存在的 model） */}
              <SelectField
                value={channel}
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
              {/* model 选择：依赖已选 channel 的模型列表，未选 channel 或无模型时禁用 */}
              <SelectField
                value={target?.model ?? ""}
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

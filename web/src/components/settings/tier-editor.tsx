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
  SELECT_BASE,
  SelectChevron,
} from "./providers-types";

// ─── useTierEditor Hook ──────────────────────────────────────────

/** tier 编辑器状态（从服务端 tiers 初始化，本地编辑，保存时提交） */
export function useTierEditor(tiers: TierMapping) {
  /** 本地编辑中的 tier 映射 */
  const [editingTiers, setEditingTiers] = useState<TierMapping>({});
  /** 是否已从服务端同步过初始值 */
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

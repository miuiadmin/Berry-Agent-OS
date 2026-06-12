/**
 * Provider Channel 卡片 + 模型行。
 *
 * 展示单个已配置渠道的信息（名称 / 状态 / 模型数量），
 * 支持展开查看模型详情（上下文窗口 / 最大输出 / 价格），
 * 以及编辑 / 删除 / 测试连接操作。
 */

import { useState } from "react";
import {
  Wifi,
  WifiOff,
  ChevronRight,
  Pencil,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import {
  type ProviderChannel,
  type ModelEntry,
  PROVIDER_KIND_LABEL_KEYS,
} from "./providers-types";

// ─── Channel Card ──────────────────────────────────────────────────

interface ChannelCardProps {
  /** 渠道数据 */
  channel: ProviderChannel;
  /** 测试连接回调 */
  onTest: () => void;
  /** 是否正在测试连接 */
  isTesting: boolean;
  /** 编辑回调 */
  onEdit: () => void;
  /** 删除回调 */
  onDelete: () => void;
}

/**
 * 单个渠道卡片。
 *
 * 桌面端：展开按钮 + 状态灯 + 名称 + 类型 + 模型数 + 操作按钮（一行）
 * 移动端：名称 + 状态（第一行），操作按钮（第二行），保证 44px 触控目标
 */
export function ChannelCard({
  channel,
  onTest,
  isTesting,
  onEdit,
  onDelete,
}: ChannelCardProps) {
  const [expanded, setExpanded] = useState(false);
  const t = useT();

  return (
    <div className="rounded-lg border border-border">
      {/* 头部：展开 + 状态 + 名称 + 操作 */}
      <div className="px-3 py-2.5 md:py-2">
        {/* 桌面+移动端共享行 */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-label={t("providers.toggleModels")}
            className="flex size-11 shrink-0 items-center justify-center rounded transition-colors hover:bg-accent md:size-7"
          >
            <ChevronRight
              className={cn(
                "size-4 transition-transform duration-200",
                expanded && "rotate-90",
              )}
            />
          </button>

          {channel.enabled ? (
            <Wifi className="size-3.5 shrink-0 text-success" />
          ) : (
            <WifiOff className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="flex-1 truncate text-sm font-medium">
            {channel.name}
          </span>
          <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:inline">
            {t(PROVIDER_KIND_LABEL_KEYS[channel.kind] ?? channel.kind)}
          </span>

          {/* 桌面端操作按钮（内联） */}
          <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
            {t("providers.modelsCount", {
              count: String(channel.modelCount),
            })}
          </span>
          <div className="hidden items-center gap-0.5 md:flex">
            <ActionButtons
              onEdit={onEdit}
              onDelete={onDelete}
              onTest={onTest}
              isTesting={isTesting}
              canTest={channel.configured}
              layout="desktop"
            />
          </div>
        </div>

        {/* 移动端操作行 */}
        <div className="mt-1.5 flex items-center gap-1 pl-10 md:hidden">
          <span className="mr-auto text-xs text-muted-foreground">
            {t("providers.modelsCount", {
              count: String(channel.modelCount),
            })}{" "}
            · {t(PROVIDER_KIND_LABEL_KEYS[channel.kind] ?? channel.kind)}
          </span>
          <ActionButtons
            onEdit={onEdit}
            onDelete={onDelete}
            onTest={onTest}
            isTesting={isTesting}
            canTest={channel.configured}
            layout="mobile"
          />
        </div>
      </div>

      {/* 模型列表（展开时显示） */}
      {expanded && channel.models.length > 0 && (
        <div className="max-h-64 overflow-y-auto border-t border-border px-3 py-2">
          <ModelTable models={channel.models} />
        </div>
      )}
      {expanded && channel.models.length === 0 && (
        <div className="border-t border-border px-3 py-3 text-center text-xs text-muted-foreground">
          {t("providers.noModelsForChannel")}
        </div>
      )}
    </div>
  );
}

// ─── 操作按钮组 ────────────────────────────────────────────────────

/** 操作按钮组（编辑 / 删除 / 测试），桌面端紧凑、移动端 44px 触控目标 */
function ActionButtons({
  onEdit,
  onDelete,
  onTest,
  isTesting,
  canTest,
  layout,
}: {
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  isTesting: boolean;
  canTest: boolean;
  layout: "desktop" | "mobile";
}) {
  const t = useT();
  const mobile = layout === "mobile";

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={onEdit}
        aria-label={t("providers.editChannel")}
        className={cn(
          "shrink-0",
          mobile
            ? "size-8 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0"
            : "size-7",
        )}
      >
        <Pencil className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onDelete}
        aria-label={t("providers.deleteChannel")}
        className={cn(
          "shrink-0 text-muted-foreground",
          mobile
            ? "size-8 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0"
            : "size-7",
        )}
      >
        <Trash2 className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onTest}
        disabled={isTesting || !canTest}
        className={cn(
          "shrink-0 text-xs",
          mobile ? "min-h-[44px] md:min-h-0" : "h-7",
        )}
      >
        {isTesting ? t("providers.testChannelRunning") : t("providers.testChannel")}
      </Button>
    </>
  );
}

// ─── 模型表格 ──────────────────────────────────────────────────────

/** 模型列表网格（4 列：名称 / 上下文 / 最大输出 / 价格） */
function ModelTable({ models }: { models: ModelEntry[] }) {
  const t = useT();

  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 gap-y-1 text-xs">
      <span className="font-medium text-muted-foreground">
        {t("providers.model")}
      </span>
      <span className="text-right font-medium text-muted-foreground">
        {t("providers.context")}
      </span>
      <span className="text-right font-medium text-muted-foreground">
        {t("providers.maxOut")}
      </span>
      <span className="text-right font-medium text-muted-foreground">
        {t("providers.priceInOut")}
      </span>

      {models.map((m) => (
        <ModelRow key={m.id} model={m} />
      ))}
    </div>
  );
}

// ─── 模型行 ────────────────────────────────────────────────────────

/** 格式化 token 数（如 200K / 1.5M） */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/** 单个模型行（4 列数据，Fragment 包裹以配合 CSS Grid） */
function ModelRow({ model }: { model: ModelEntry }) {
  return (
    <>
      <span className="truncate font-mono" title={model.id}>
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

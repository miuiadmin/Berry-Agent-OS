/**
 * Provider Channel 卡片 + 模型行。
 *
 * 展示单个已配置渠道的信息（名称 / 状态 / 模型数量），
 * 支持展开查看模型详情（上下文窗口 / 最大输出 / 价格），
 * 以及编辑 / 删除 / 测试连接操作。
 */

import { useState } from "react";
import { Wifi, WifiOff, ChevronRight, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { formatTokensCompact } from "@/lib/format";
import { type ProviderChannel, type ModelEntry, PROVIDER_KIND_LABEL_KEYS } from "./providers-types";

/** Lucide 图标组件的最小契约 */
type IconType = React.ComponentType<{ className?: string }>;

/** 桌面/移动两套尺寸 className，避免每个 Action 组件都重复三元 */
const actionSizing = {
  icon: { desktop: "size-7", mobile: "size-8 min-h-[44px] min-w-[44px]" },
  button: { desktop: "h-7", mobile: "min-h-[44px]" },
} as const;

/** 图标操作按钮（编辑/删除）：桌面 28px，移动 44px 触控目标 */
function ActionIcon({ icon: Icon, label, onClick, mobile, className }: {
  icon: IconType;
  label: string;
  onClick: () => void;
  mobile?: boolean;
  className?: string;
}) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} aria-label={label}
      className={cn("shrink-0", mobile ? actionSizing.icon.mobile : actionSizing.icon.desktop, className)}>
      <Icon className="size-3.5" />
    </Button>
  );
}

/** 文字操作按钮（测试连接）：桌面 28px，移动 44px 触控目标 */
function ActionButton({ label, onClick, disabled, mobile }: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  mobile?: boolean;
}) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} disabled={disabled}
      className={cn("shrink-0 text-xs", mobile ? actionSizing.button.mobile : actionSizing.button.desktop)}>
      {label}
    </Button>
  );
}

/** 操作按钮组（编辑 + 删除 + 测试，桌面/移动复用） */
function ActionBar({ onEdit, onDelete, onTest, isTesting, configured, mobile }: {
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  isTesting: boolean;
  configured: boolean;
  mobile?: boolean;
}) {
  const t = useT();
  return (
    <>
      <ActionIcon icon={Pencil} label={t("providers.editChannel")} onClick={onEdit} mobile={mobile} />
      <ActionIcon icon={Trash2} label={t("providers.deleteChannel")} onClick={onDelete} mobile={mobile} className="text-muted-foreground" />
      <ActionButton
        label={isTesting ? t("providers.testChannelRunning") : t("providers.testChannel")}
        onClick={onTest} disabled={isTesting || !configured} mobile={mobile}
      />
    </>
  );
}

/** 单个模型行（Fragment 包裹，每个 span 占据 grid 的一格） */
function ModelRow({ model }: { model: ModelEntry }) {
  return (
    <>
      <span className="truncate font-mono" title={model.id}>{model.name}</span>
      <span className="text-right text-muted-foreground">{formatTokensCompact(model.contextWindow)}</span>
      <span className="text-right text-muted-foreground">{formatTokensCompact(model.defaultMaxTokens)}</span>
      <span className="text-right text-muted-foreground">
        {model.inputPricePer1M != null ? `$${model.inputPricePer1M}/${model.outputPricePer1M ?? "-"}` : "—"}
      </span>
    </>
  );
}

/** 模型列表网格（4 列：名称 / 上下文 / 最大输出 / 价格） */
function ModelTable({ models }: { models: ModelEntry[] }) {
  const t = useT();
  /** 表头配置：align 控制列内文字对齐（右列数字靠右） */
  const HEADERS = [
    { label: t("providers.model"), align: "" },
    { label: t("providers.context"), align: "text-right" },
    { label: t("providers.maxOut"), align: "text-right" },
    { label: t("providers.priceInOut"), align: "text-right" },
  ] as const;

  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 gap-y-1 text-xs">
      {HEADERS.map((h) => <span key={h.label} className={cn("font-medium text-muted-foreground", h.align)}>{h.label}</span>)}
      {models.map((m) => <ModelRow key={m.id} model={m} />)}
    </div>
  );
}

// ─── Channel Card ──────────────────────────────────────────────────

interface ChannelCardProps {
  channel: ProviderChannel;
  onTest: () => void;
  isTesting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

/**
 * 单个渠道卡片。
 * 桌面端：操作按钮内联；移动端：操作按钮第二行，保证 44px 触控目标。
 */
export function ChannelCard({ channel, onTest, isTesting, onEdit, onDelete }: ChannelCardProps) {
  const [expanded, setExpanded] = useState(false);
  const t = useT();
  const kindLabel = t(PROVIDER_KIND_LABEL_KEYS[channel.kind] ?? channel.kind);
  const modelsCount = t("providers.modelsCount", { count: String(channel.modelCount) });
  /** 操作组共享的 props（桌面/移动只是 mobile flag 不同） */
  const actionProps = { onEdit, onDelete, onTest, isTesting, configured: channel.configured };

  return (
    <div className="rounded-lg border border-border">
      <div className="px-3 py-2.5 md:py-2">
        {/* 共享行：展开按钮 + 状态 + 名称 */}
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}
            aria-label={t("providers.toggleModels")}
            className="flex size-11 shrink-0 items-center justify-center rounded transition-colors hover:bg-accent md:size-7">
            <ChevronRight className={cn("size-4 transition-transform duration-200", expanded && "rotate-90")} />
          </button>
          {channel.enabled
            ? <Wifi className="size-3.5 shrink-0 text-success" />
            : <WifiOff className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="flex-1 truncate text-sm font-medium">{channel.name}</span>

          {/* 桌面端：类型 + 模型数 + 操作（内联） */}
          <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:inline">{kindLabel}</span>
          <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">{modelsCount}</span>
          <div className="hidden items-center gap-0.5 md:flex">
            <ActionBar {...actionProps} />
          </div>
        </div>

        {/* 移动端：类型 + 模型数 + 操作（第二行，pl-10 对齐展开按钮右侧） */}
        <div className="mt-1.5 flex items-center gap-1 pl-10 md:hidden">
          <span className="mr-auto text-xs text-muted-foreground">{modelsCount} · {kindLabel}</span>
          <ActionBar {...actionProps} mobile />
        </div>
      </div>

      {/* 模型列表（展开时显示，空渠道显示占位提示） */}
      {expanded && (
        channel.models.length > 0 ? (
          <div className="max-h-64 overflow-y-auto border-t border-border px-3 py-2">
            <ModelTable models={channel.models} />
          </div>
        ) : (
          <div className="border-t border-border px-3 py-3 text-center text-xs text-muted-foreground">
            {t("providers.noModelsForChannel")}
          </div>
        )
      )}
    </div>
  );
}

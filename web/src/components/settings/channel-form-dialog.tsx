/**
 * Provider Channel 新增 / 编辑表单弹窗。
 *
 * 设计：表单状态完全内聚于本组件 —— 不再由父组件透传 7 组 form* state，
 * 而是在弹窗打开时根据 mode / editingChannel 自行初始化，
 * 提交时通过 onSubmit(formData) 回传干净的表单数据。
 * 所有字段收归单个 form 状态对象，避免 7 个独立 useState 散落。
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useT } from "@/lib/i18n";
import {
  type ModelEntry,
  type ProviderChannel,
  type CatalogResponse,
  PROVIDER_KIND_LABEL_KEYS,
} from "./providers-types";
import { SelectField } from "@/components/ui/select-field";

/** 表单提交数据（父组件据此发请求） */
export interface ChannelFormData {
  /** 渠道 ID */
  id: string;
  /** 展示名 */
  name: string;
  /** provider 类型 */
  kind: string;
  /** 自定义 base URL（可选） */
  baseUrl?: string;
  /** API Key（可选 —— 编辑时留空表示保持不变） */
  apiKey?: string;
  /** 是否启用 */
  enabled: boolean;
}

/** 表单状态类型（所有字段收归一个对象） */
interface FormState {
  kind: string;
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

interface ChannelFormDialogProps {
  /** 模式：新增 / 编辑 */
  mode: "add" | "edit";
  /** 是否打开 */
  open: boolean;
  /** 打开状态变更回调（关闭时父组件收尾） */
  onOpenChange: (open: boolean) => void;
  /** 可选 provider 类型列表 */
  kinds: string[];
  /** 编辑模式下的原始渠道数据（add 模式为 null） */
  editingChannel?: ProviderChannel | null;
  /** 提交回调 */
  onSubmit: (data: ChannelFormData) => void;
  /** 提交中（禁用按钮） */
  isPending: boolean;
}

/** 空表单初始值 */
const EMPTY_FORM: FormState = {
  kind: "",
  id: "",
  name: "",
  baseUrl: "",
  apiKey: "",
  enabled: true,
};

/** 根据编辑渠道生成初始表单状态（apiKey 永远留空 —— 服务端 mask） */
function initForm(mode: "add" | "edit", channel?: ProviderChannel | null): FormState {
  if (mode === "edit" && channel) {
    return {
      kind: channel.kind,
      id: channel.id,
      name: channel.name,
      baseUrl: channel.baseUrl ?? "",
      apiKey: "",
      enabled: channel.enabled,
    };
  }
  return { ...EMPTY_FORM };
}

export function ChannelFormDialog({
  mode,
  open,
  onOpenChange,
  kinds,
  editingChannel,
  onSubmit,
  isPending,
}: ChannelFormDialogProps) {
  const isEdit = mode === "edit";
  const t = useT();

  // ── 表单状态（单对象，替代 7 个独立 useState） ──
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  /** 更新单个表单字段 */
  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * 弹窗打开时初始化表单：
   *   - edit 模式：从 editingChannel 回填
   *   - add 模式：清空为初始值
   */
  useEffect(() => {
    if (!open) return;
    setForm(initForm(mode, editingChannel));
  }, [open, mode, editingChannel]);

  /**
   * add 模式下，按选中的 provider kind 拉取内置模型目录（用于预览）。
   * edit 模式不需要目录（模型列表已在 channel 中）。
   */
  const { data: catalogData } = useQuery({
    queryKey: ["providers", "catalogs", form.kind],
    queryFn: () =>
      apiGet<CatalogResponse>(`/api/providers/catalogs/${form.kind}`),
    enabled: mode === "add" && !!form.kind && open,
  });
  const catalogModels: ModelEntry[] = catalogData?.models ?? [];

  /** 提交表单（仅组装数据，不直接发请求） */
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit({
      id: form.id.trim(),
      name: form.name.trim() || form.id.trim(),
      kind: form.kind,
      baseUrl: form.baseUrl.trim() || undefined,
      apiKey: form.apiKey.trim() || undefined,
      enabled: form.enabled,
    });
  }

  // ── 校验：add 需填 kind/id/apiKey，edit 需 kind/id ──
  const canSubmit =
    !isPending && !!form.kind && !!form.id && (!(!isEdit && !form.apiKey));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("providers.editChannel") : t("providers.addChannelTitle")}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? t("providers.editChannelDesc")
              : t("providers.addChannelDesc")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="mt-2 space-y-5">
          {/* provider 类型选择 */}
          <Field label={t("providers.providerKind")}>
            <SelectField
              value={form.kind}
              onChange={(e) => {
                setField("kind", e.target.value);
                if (!isEdit) setField("id", "");
              }}
              disabled={isEdit}
            >
              <option value="">{t("providers.selectKind")}</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {t(PROVIDER_KIND_LABEL_KEYS[k] ?? k)}
                </option>
              ))}
            </SelectField>
          </Field>

          {/* 渠道 ID（编辑时不可改） */}
          <Field label={t("providers.channelId")}>
            <Input
              value={form.id}
              onChange={(e) => setField("id", e.target.value)}
              disabled={isEdit}
              placeholder={t("providers.channelIdPlaceholder")}
              className="h-10 md:h-8 disabled:opacity-50"
            />
          </Field>

          {/* 展示名 */}
          <Field label={t("providers.displayName")}>
            <Input
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              placeholder={t("providers.displayNamePlaceholder")}
              className="h-10 md:h-8"
            />
          </Field>

          {/* Base URL */}
          <Field label={t("providers.baseUrl")}>
            <Input
              value={form.baseUrl}
              onChange={(e) => setField("baseUrl", e.target.value)}
              placeholder={t("providers.baseUrlPlaceholder")}
              className="h-10 md:h-8"
            />
          </Field>

          {/* API Key（编辑时留空 = 保持不变） */}
          <Field
            label={`${t("providers.apiKey")}${
              isEdit ? ` ${t("providers.apiKeyKeepCurrent")}` : ""
            }`}
          >
            <Input
              type="password"
              value={form.apiKey}
              onChange={(e) => setField("apiKey", e.target.value)}
              placeholder={
                isEdit
                  ? t("providers.apiKeyEditPlaceholder")
                  : t("providers.apiKeyPlaceholder")
              }
              className="h-10 md:h-8"
            />
          </Field>

          {/* 启用开关（仅编辑模式） */}
          {isEdit && (
            <div className="flex items-center gap-2">
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setField("enabled", v)}
              />
              <span className="text-sm text-muted-foreground">
                {form.enabled ? t("common.enabled") : t("common.disabled")}
              </span>
            </div>
          )}

          {/* 内置模型目录预览（仅 add 模式 + 有目录数据） */}
          {!isEdit && form.kind && catalogModels.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-lg border border-border p-3">
              <p className="mb-2 text-[11px] font-medium text-muted-foreground">
                {t("providers.builtinModels", {
                  kind: t(PROVIDER_KIND_LABEL_KEYS[form.kind] ?? form.kind),
                })}
                :
              </p>
              <div className="space-y-1">
                {catalogModels.map((m) => (
                  <div
                    key={m.id}
                    className="truncate font-mono text-xs text-muted-foreground"
                  >
                    {m.id}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 操作按钮：移动端全宽，桌面端自适应；触控目标 44px */}
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
            <Button
              variant="outline"
              type="button"
              onClick={() => onOpenChange(false)}
              className="w-full min-h-[44px] md:min-h-0 sm:w-auto"
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
              className="w-full min-h-[44px] md:min-h-0 sm:w-auto"
            >
              {isPending
                ? t("common.saving")
                : isEdit
                  ? t("common.update")
                  : t("common.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── 字段包装（label + children） ──────────────────────────────────

/** 表单字段：统一 label + 控件的间距与排版 */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

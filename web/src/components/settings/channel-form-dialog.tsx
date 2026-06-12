/**
 * Provider Channel 新增 / 编辑表单弹窗。
 *
 * 设计：表单状态完全内聚于本组件 —— 不再由父组件透传 7 组 form* state，
 * 而是在弹窗打开时根据 mode / editingChannel 自行初始化，
 * 提交时通过 onSubmit(formData) 回传干净的表单数据。
 *
 * 这样父组件只需关心"打开哪个渠道编辑 / 创建请求"，无需维护表单字段细节。
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
  SELECT_BASE,
  SelectChevron,
} from "./providers-types";

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
const EMPTY_FORM = {
  kind: "",
  id: "",
  name: "",
  baseUrl: "",
  apiKey: "",
  enabled: true,
};

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

  // ── 表单字段 ──
  const [formKind, setFormKind] = useState("");
  const [formId, setFormId] = useState("");
  const [formName, setFormName] = useState("");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  const [formEnabled, setFormEnabled] = useState(true);

  /**
   * 弹窗打开时初始化表单：
   *   - edit 模式：从 editingChannel 回填（apiKey 永远留空 —— 服务端 mask）
   *   - add 模式：清空为初始值
   */
  useEffect(() => {
    if (!open) return;
    if (isEdit && editingChannel) {
      setFormKind(editingChannel.kind);
      setFormId(editingChannel.id);
      setFormName(editingChannel.name);
      setFormBaseUrl(editingChannel.baseUrl ?? "");
      setFormApiKey("");
      setFormEnabled(editingChannel.enabled);
    } else {
      setFormKind(EMPTY_FORM.kind);
      setFormId(EMPTY_FORM.id);
      setFormName(EMPTY_FORM.name);
      setFormBaseUrl(EMPTY_FORM.baseUrl);
      setFormApiKey(EMPTY_FORM.apiKey);
      setFormEnabled(EMPTY_FORM.enabled);
    }
  }, [open, isEdit, editingChannel]);

  /**
   * add 模式下，按选中的 provider kind 拉取内置模型目录（用于预览）。
   * edit 模式不需要目录（模型列表已在 channel 中）。
   */
  const { data: catalogData } = useQuery({
    queryKey: ["providers", "catalogs", formKind],
    queryFn: () =>
      apiGet<CatalogResponse>(`/api/providers/catalogs/${formKind}`),
    enabled: mode === "add" && !!formKind && open,
  });
  const catalogModels: ModelEntry[] = catalogData?.models ?? [];

  /** 提交表单（仅组装数据，不直接发请求） */
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit({
      id: formId.trim(),
      name: formName.trim() || formId.trim(),
      kind: formKind,
      baseUrl: formBaseUrl.trim() || undefined,
      apiKey: formApiKey.trim() || undefined,
      enabled: formEnabled,
    });
  }

  // ── 校验：add 需填 kind/id/apiKey，edit 需 kind/id ──
  const canSubmit =
    !isPending && !!formKind && !!formId && (!(!isEdit && !formApiKey));

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
            <div className="relative">
              <select
                value={formKind}
                onChange={(e) => {
                  setFormKind(e.target.value);
                  // add 模式切换类型时清空 ID（不同类型的 ID 命名规则不同）
                  if (!isEdit) setFormId("");
                }}
                disabled={isEdit}
                className={SELECT_BASE}
              >
                <option value="">{t("providers.selectKind")}</option>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {t(PROVIDER_KIND_LABEL_KEYS[k] ?? k)}
                  </option>
                ))}
              </select>
              <SelectChevron />
            </div>
          </Field>

          {/* 渠道 ID（编辑时不可改） */}
          <Field label={t("providers.channelId")}>
            <Input
              value={formId}
              onChange={(e) => setFormId(e.target.value)}
              disabled={isEdit}
              placeholder={t("providers.channelIdPlaceholder")}
              className="h-10 md:h-8 disabled:opacity-50"
            />
          </Field>

          {/* 展示名 */}
          <Field label={t("providers.displayName")}>
            <Input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder={t("providers.displayNamePlaceholder")}
              className="h-10 md:h-8"
            />
          </Field>

          {/* Base URL */}
          <Field label={t("providers.baseUrl")}>
            <Input
              value={formBaseUrl}
              onChange={(e) => setFormBaseUrl(e.target.value)}
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
              value={formApiKey}
              onChange={(e) => setFormApiKey(e.target.value)}
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
                checked={formEnabled}
                onCheckedChange={setFormEnabled}
              />
              <span className="text-sm text-muted-foreground">
                {formEnabled ? t("common.enabled") : t("common.disabled")}
              </span>
            </div>
          )}

          {/* 内置模型目录预览（仅 add 模式 + 有目录数据） */}
          {!isEdit && formKind && catalogModels.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-lg border border-border p-3">
              <p className="mb-2 text-[11px] font-medium text-muted-foreground">
                {t("providers.builtinModels", {
                  kind: t(PROVIDER_KIND_LABEL_KEYS[formKind] ?? formKind),
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

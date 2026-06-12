/**
 * Settings 页面的通用配置表单组件。
 *
 * 根据 fields 数组驱动渲染：text/number/password → Input，boolean → Switch。
 * 统一处理错误展示、标签、布局。被 SettingsPage 的多个 tab 复用。
 */

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/** 字段定义：驱动 ConfigSection 渲染哪种控件 */
export interface FieldDef {
  /** 字段 key（对应 config[section][key]） */
  key: string;
  /** 标签文本 */
  label: string;
  /** 控件类型 */
  type: "text" | "number" | "password" | "boolean";
}

interface ConfigSectionProps {
  /** 区块标题 */
  title: string;
  /** 区块描述（可选，显示在标题下方） */
  description?: string;
  /** 配置分区名（对应 config 对象的顶级 key） */
  section: string;
  /** 完整配置对象（从中取 config[section] 作为本区块数据） */
  config: Record<string, unknown>;
  /** 字段变更回调（section + key + value） */
  onUpdate: (section: string, key: string, value: unknown) => void;
  /** 校验错误 { "section.key": "错误消息" } */
  errors: Record<string, string>;
  /** 字段定义列表 */
  fields: FieldDef[];
}

/**
 * 通用配置表单区块。
 *
 * 传入 section + fields，自动渲染对应类型的输入控件。
 * 布尔 → Switch + 状态文字；数字/密码/文本 → Input。
 * 有错误时 Input 加 destructive 边框 + 红色错误提示。
 */
export function ConfigSection({
  title,
  description,
  section,
  config,
  onUpdate,
  errors,
  fields,
}: ConfigSectionProps) {
  const t = useT();
  /** 取出本区块对应的配置子对象 */
  const sectionData = (config[section] as Record<string, unknown>) ?? {};

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {fields.map((field) => {
          /** 字段级错误 key（格式 section.key） */
          const errorKey = `${section}.${field.key}`;
          const fieldError = errors[errorKey];

          return (
            <div key={field.key} className="grid gap-1.5">
              <label
                htmlFor={`${section}-${field.key}`}
                className="text-xs font-medium text-muted-foreground"
              >
                {field.label}
              </label>

              {field.type === "boolean" ? (
                <div className="flex items-center gap-2">
                  <Switch
                    id={`${section}-${field.key}`}
                    checked={!!sectionData[field.key]}
                    onCheckedChange={(v) => onUpdate(section, field.key, v)}
                  />
                  <span className="text-sm text-muted-foreground">
                    {sectionData[field.key]
                      ? t("common.enabled")
                      : t("common.disabled")}
                  </span>
                </div>
              ) : (
                <Input
                  id={`${section}-${field.key}`}
                  type={
                    field.type === "password"
                      ? "password"
                      : field.type === "number"
                        ? "number"
                        : "text"
                  }
                  inputMode={field.type === "number" ? "numeric" : undefined}
                  value={(sectionData[field.key] as string | number) ?? ""}
                  onChange={(e) =>
                    onUpdate(
                      section,
                      field.key,
                      field.type === "number"
                        ? Number(e.target.value)
                        : e.target.value,
                    )
                  }
                  className={cn(
                    "h-10 md:h-8",
                    fieldError &&
                      "border-destructive focus:border-destructive focus:ring-destructive/30",
                  )}
                />
              )}

              {/* 字段级错误提示（带 slide-down 动画） */}
              {fieldError && (
                <p className="animate-slide-down text-[11px] text-destructive">
                  {fieldError}
                </p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

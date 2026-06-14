/**
 * Settings Tab 内容组件。
 *
 * 从 SettingsPage.tsx 提取，负责根据当前 tab 渲染对应的配置面板。
 * providers tab 由 ProvidersTab 独立组件承载，channels tab 由本文件 ChannelsTab 承载，
 * 其余 tab（budget / memory / skills / observability / web）使用 ConfigSection 通用组件 +
 * 数据驱动的 TAB_FIELDS 表。
 *
 * 校验逻辑（validateConfig）也导出在此，供 SettingsPage 实时调用。
 */

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Radio, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, type TFunction } from "@/lib/i18n";
import { ProvidersTab } from "@/components/settings/providers-tab";
import { ConfigSection, type FieldDef } from "./settings-config-section";

export type TabKey = "providers" | "budget" | "memory" | "skills" | "channels" | "observability" | "web";

/** 端口合法范围（1 ~ 65535，排除 0 和 2^16） */
const PORT_MIN = 1;
const PORT_MAX = 65535;

/**
 * Channels tab 的 Telegram 配置示例（YAML）。
 * 抽成常量：原本内联在 JSX 的 <pre> 里，多行字符串与缩进容易在编辑时破坏对齐；
 * 单独定义让"示例文本"与"渲染"解耦，调整示例只改这一处。
 */
const TELEGRAM_YAML_SAMPLE = `channels:
  telegram:
    token: "your-bot-token"
    allowedUserIds:
      - 123456789`;

/**
 * 各 tab 的配置字段定义（避免 switch 里重复 JSX 结构）。
 *
 * 复用 settings-config-section 的 FieldDef 类型——重构前这里重复定义了一份
 * 近乎相同的 `{ key, labelKey, type }` 形状，与 FieldDef 漂移风险高
 *（例如 FieldDef 加了 "password" type 这里不会感知）。
 * 现在 TAB_FIELDS 的字段项是"带 labelKey 的 FieldDef 蓝本"，
 * 渲染时 map 成完整 FieldDef（labelKey → label 翻译）。
 */
type TabFieldDef = Omit<FieldDef, "label"> & { labelKey: string };

interface TabFieldsEntry {
  tab: TabKey;
  titleKey: string;
  descKey: string;
  section: string;
  fields: TabFieldDef[];
}

const TAB_FIELDS: TabFieldsEntry[] = [
  {
    tab: "budget",
    titleKey: "settings.budgetLimits",
    descKey: "settings.budgetLimitsDesc",
    section: "budget",
    fields: [
      { key: "sessionLimit", labelKey: "settings.sessionLimit", type: "number" },
      { key: "agentLimit", labelKey: "settings.agentLimit", type: "number" },
      { key: "taskLimit", labelKey: "settings.taskLimit", type: "number" },
      { key: "dailyLimit", labelKey: "settings.dailyLimit", type: "number" },
    ],
  },
  {
    tab: "memory",
    titleKey: "settings.memorySettings",
    descKey: "settings.memorySettingsDesc",
    section: "memory",
    fields: [
      { key: "evolutionEnabled", labelKey: "settings.evolutionEnabled", type: "boolean" },
      { key: "consolidationInterval", labelKey: "settings.consolidationInterval", type: "number" },
      { key: "maxResults", labelKey: "settings.maxResults", type: "number" },
    ],
  },
  {
    tab: "skills",
    titleKey: "settings.skillsSettings",
    descKey: "settings.skillsSettingsDesc",
    section: "skills",
    fields: [
      { key: "promptMode", labelKey: "settings.promptMode", type: "text" },
      { key: "maxPromptChars", labelKey: "settings.maxPromptChars", type: "number" },
      { key: "maxDescriptionChars", labelKey: "settings.maxDescriptionChars", type: "number" },
      { key: "shellInjection", labelKey: "settings.shellInjection", type: "boolean" },
    ],
  },
  {
    tab: "observability",
    titleKey: "settings.observability",
    descKey: "settings.observabilityDesc",
    section: "observability",
    fields: [
      { key: "level", labelKey: "settings.logLevel", type: "text" },
      { key: "captureOutput", labelKey: "settings.captureOutput", type: "boolean" },
    ],
  },
  {
    tab: "web",
    titleKey: "settings.webServer",
    descKey: "settings.webServerDesc",
    section: "web",
    fields: [
      { key: "enabled", labelKey: "settings.enabled", type: "boolean" },
      { key: "port", labelKey: "settings.port", type: "number" },
      { key: "host", labelKey: "settings.host", type: "text" },
    ],
  },
];

export function TabContent({
  tab,
  config,
  onUpdate,
  errors,
}: {
  tab: TabKey;
  config: Record<string, unknown>;
  onUpdate: (section: string, key: string, value: unknown) => void;
  errors: Record<string, string>;
}) {
  const t = useT();

  // providers 和 channels 是独立组件，不走通用 ConfigSection。
  // 原因：这两个 tab 需要比单 Input/Switch 更丰富的 UI——
  //   - providers：每个 LLM 供应商是独立卡片（含 model 列表、API key 输入、连通性测试），
  //     远超 FieldDef 的"一个字段一行表单"模型。
  //   - channels：展示 Telegram YAML 示例 + 配置状态指示灯 + 更多渠道占位，
  //     也需要自定义排版。其余 tab（budget/memory/skills/observability/web）字段
  //     形状规整，能完全数据驱动，故走 ConfigSection。
  if (tab === "providers") return <ProvidersTab />;
  if (tab === "channels") return <ChannelsTab config={config} />;

  // 其余 tab 用数据驱动渲染
  const def = TAB_FIELDS.find((d) => d.tab === tab);
  if (!def) return null;

  // TabFieldDef → FieldDef：labelKey 翻译成 label
  const fields: FieldDef[] = def.fields.map((f) => ({ ...f, label: t(f.labelKey) }));

  return (
    <ConfigSection
      title={t(def.titleKey)}
      description={t(def.descKey)}
      section={def.section}
      config={config}
      onUpdate={onUpdate}
      errors={errors}
      fields={fields}
    />
  );
}

/** 渠道设置 tab（Telegram 配置预览 + 更多渠道提示） */
function ChannelsTab({ config }: { config: Record<string, unknown> }) {
  const t = useT();
  const hasTelegram = !!(config.channels as Record<string, unknown> | undefined)?.telegram;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.channelSettings")}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("settings.channelSettingsDesc")}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Telegram 配置预览 */}
        <div className="rounded-lg border border-border p-4">
          <div className="flex items-center gap-2">
            <Radio className="size-4 text-info" />
            <h4 className="text-sm font-medium">{t("settings.telegram")}</h4>
          </div>
          <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
            {t("settings.telegramInstructions")}
          </p>
          {/* YAML 示例（const 提取，避免多行字符串缩进与 JSX 混淆） */}
          <pre className="mt-2 rounded-md bg-muted/50 p-3 text-[11px] font-mono text-muted-foreground overflow-x-auto">
            {TELEGRAM_YAML_SAMPLE}
          </pre>
          {/* 配置状态指示：已配置 → 绿点；未配置 → 灰点 */}
          <div className="mt-3 flex items-center gap-2">
            <span className={cn("inline-flex size-2 rounded-full", hasTelegram ? "bg-success" : "bg-muted-foreground/30")} />
            <span className={cn("text-xs", hasTelegram ? "text-success font-medium" : "text-muted-foreground")}>
              {hasTelegram ? t("settings.configured") : t("common.notConfigured")}
            </span>
          </div>
        </div>

        {/* 更多渠道提示 */}
        <div className="rounded-lg border border-dashed border-border p-4">
          <div className="flex items-center gap-2">
            <Globe className="size-4 text-muted-foreground" />
            <h4 className="text-sm font-medium text-muted-foreground">{t("settings.moreChannels")}</h4>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t("settings.moreChannelsDesc")}</p>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── 配置校验 ──────────────────────────────────────────────────────

/**
 * 配置校验函数。
 *
 * 检查 web.port 范围 + budget.* / memory.* 非负数等字段的合法性，
 * 返回错误键值对（key = "section.field"，value = 错误消息）。
 *
 * 设计：每个 section 用同一份 validateNumericField 校验器，
 * 通过 rule 参数（{ min? / max? }）控制具体规则，
 * 避免为"端口范围"和"非负数"写两套结构相同的循环。
 *
 * @param cfg 完整配置对象
 * @param t   i18n 翻译函数（用真实 TFunction 类型而非 `(key:string)=>string` 窄化签名，
 *            这样错误消息未来需要插值时——如 "port 必须 1–65535" 注入 port 值——
 *            不会因签名收窄而无法传 params。）
 */
export function validateConfig(
  cfg: Record<string, unknown>,
  t: TFunction,
): Record<string, string> {
  const errs: Record<string, string> = {};

  // web.port：1 ~ 65535。
  // 注：用户清空输入框时，settings-config-section 的 updateField 对 number 类型
  // 执行 Number(e.target.value)，Number("") === 0，0 < min(1) 会立即触发 port range
  // 错误——这是预期行为（清空即非法），不是"算合法等后端拒绝"。
  validateNumericField(cfg, "web", "port", { min: PORT_MIN, max: PORT_MAX }, t("settings.portRange"), errs);

  // budget / memory：非负数（>= 0）
  const nonNegativeMsg = t("settings.mustBeNonNegative");
  for (const key of ["sessionLimit", "agentLimit", "taskLimit", "dailyLimit"]) {
    validateNumericField(cfg, "budget", key, { min: 0 }, nonNegativeMsg, errs);
  }
  for (const key of ["consolidationInterval", "maxResults"]) {
    validateNumericField(cfg, "memory", key, { min: 0 }, nonNegativeMsg, errs);
  }

  return errs;
}

/** 数值字段校验规则 */
interface NumericRule {
  /** 最小值（含），不传则不检查下界 */
  min?: number;
  /** 最大值（含），不传则不检查上界 */
  max?: number;
}

/**
 * 通用数值字段校验：读 cfg[section][key]，按 rule 检查范围。
 *
 * - 字段缺失 / 空字符串 → 跳过（不报错，让后端在保存时做必填校验）
 * - NaN → 跳过（用户输入非数字字符时不立即报错，失焦/保存时再处理）
 * - 数值越界 → 写入错误消息
 *
 * @param cfg     完整配置对象
 * @param section 区段名
 * @param key     字段名
 * @param rule    校验规则（min/max）
 * @param errMsg  校验失败时写入的错误消息
 * @param errs    错误收集对象（in-place 写入）
 */
function validateNumericField(
  cfg: Record<string, unknown>,
  section: string,
  key: string,
  rule: NumericRule,
  errMsg: string,
  errs: Record<string, string>,
) {
  const data = cfg[section] as Record<string, unknown> | undefined;
  if (!data) return;
  const raw = data[key];
  // 空字符串 / undefined → 跳过（必填校验由后端负责，前端只校验"有值时是否合法"）
  if (raw === "" || raw == null) return;
  const val = Number(raw);
  if (isNaN(val)) return;
  if (rule.min !== undefined && val < rule.min) {
    errs[`${section}.${key}`] = errMsg;
    return;
  }
  if (rule.max !== undefined && val > rule.max) {
    errs[`${section}.${key}`] = errMsg;
  }
}

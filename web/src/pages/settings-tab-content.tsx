/**
 * Settings Tab 内容组件。
 *
 * 从 SettingsPage.tsx 提取，负责根据当前 tab 渲染对应的配置面板。
 * providers tab 由 ProvidersTab 独立组件承载，其余 tab 使用 ConfigSection 通用组件。
 */

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Radio, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { ProvidersTab } from "@/components/settings/providers-tab";
import { ConfigSection } from "./settings-config-section";

export type TabKey = "providers" | "budget" | "memory" | "skills" | "channels" | "observability" | "web";

/** 各 tab 的配置字段定义（避免 switch 里重复 JSX 结构） */
const TAB_FIELDS: Array<{
  tab: TabKey;
  titleKey: string;
  descKey: string;
  section: string;
  fields: Array<{ key: string; labelKey: string; type: "text" | "number" | "boolean" }>;
}> = [
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

  // providers 和 channels 是独立组件，不走通用 ConfigSection
  if (tab === "providers") return <ProvidersTab />;
  if (tab === "channels") return <ChannelsTab config={config} />;

  // 其余 tab 用数据驱动渲染
  const def = TAB_FIELDS.find((d) => d.tab === tab);
  if (!def) return null;

  return (
    <ConfigSection
      title={t(def.titleKey)}
      description={t(def.descKey)}
      section={def.section}
      config={config}
      onUpdate={onUpdate}
      errors={errors}
      fields={def.fields.map((f) => ({ ...f, label: t(f.labelKey) }))}
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
          <pre className="mt-2 rounded-md bg-muted/50 p-3 text-[11px] font-mono text-muted-foreground overflow-x-auto">
{`channels:
  telegram:
    token: "your-bot-token"
    allowedUserIds:
      - 123456789`}
          </pre>
          {/* 配置状态指示 */}
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
 * 检查 web.port / budget.* / memory.* 等字段的合法性，
 * 返回错误键值对（key = "section.field"，value = 错误消息）。
 */
export function validateConfig(
  cfg: Record<string, unknown>,
  t: (key: string) => string,
): Record<string, string> {
  const errs: Record<string, string> = {};

  // web.port 范围校验
  const web = cfg.web as Record<string, unknown> | undefined;
  if (web) {
    const port = Number(web.port);
    if (web.port !== "" && (isNaN(port) || port < 1 || port > 65535)) {
      errs["web.port"] = t("settings.portRange");
    }
  }

  // 非负数批量校验
  validateNonNegative(cfg, "budget", ["sessionLimit", "agentLimit", "taskLimit", "dailyLimit"], t, errs);
  validateNonNegative(cfg, "memory", ["consolidationInterval", "maxResults"], t, errs);

  return errs;
}

/** 批量校验某个 section 下多个字段是否为非负数 */
function validateNonNegative(
  cfg: Record<string, unknown>,
  section: string,
  keys: string[],
  t: (key: string) => string,
  errs: Record<string, string>,
) {
  const data = cfg[section] as Record<string, unknown> | undefined;
  if (!data) return;
  for (const key of keys) {
    const val = Number(data[key]);
    if (data[key] !== "" && !isNaN(val) && val < 0) {
      errs[`${section}.${key}`] = t("settings.mustBeNonNegative");
    }
  }
}

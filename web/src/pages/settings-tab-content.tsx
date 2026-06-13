/**
 * Settings Tab 内容组件。
 *
 * 从 SettingsPage.tsx 提取，负责根据当前 tab 渲染对应的配置面板。
 * providers tab 由 ProvidersTab 独立组件承载，其余 tab 使用 ConfigSection 通用组件。
 */

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Radio, Globe } from "lucide-react";
import { useT } from "@/lib/i18n";
import { ProvidersTab } from "@/components/settings/providers-tab";
import { ConfigSection } from "./settings-config-section";

export type TabKey = "providers" | "budget" | "memory" | "skills" | "channels" | "observability" | "web";

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
  switch (tab) {
    case "providers":
      return <ProvidersTab />;
    case "budget":
      return (
        <ConfigSection
          title={t("settings.budgetLimits")}
          description={t("settings.budgetLimitsDesc")}
          section="budget"
          config={config}
          onUpdate={onUpdate}
          errors={errors}
          fields={[
            { key: "sessionLimit", label: t("settings.sessionLimit"), type: "number" },
            { key: "agentLimit", label: t("settings.agentLimit"), type: "number" },
            { key: "taskLimit", label: t("settings.taskLimit"), type: "number" },
            { key: "dailyLimit", label: t("settings.dailyLimit"), type: "number" },
          ]}
        />
      );
    case "memory":
      return (
        <ConfigSection
          title={t("settings.memorySettings")}
          description={t("settings.memorySettingsDesc")}
          section="memory"
          config={config}
          onUpdate={onUpdate}
          errors={errors}
          fields={[
            { key: "evolutionEnabled", label: t("settings.evolutionEnabled"), type: "boolean" },
            { key: "consolidationInterval", label: t("settings.consolidationInterval"), type: "number" },
            { key: "maxResults", label: t("settings.maxResults"), type: "number" },
          ]}
        />
      );
    case "skills":
      return (
        <ConfigSection
          title={t("settings.skillsSettings")}
          description={t("settings.skillsSettingsDesc")}
          section="skills"
          config={config}
          onUpdate={onUpdate}
          errors={errors}
          fields={[
            { key: "promptMode", label: t("settings.promptMode"), type: "text" },
            { key: "maxPromptChars", label: t("settings.maxPromptChars"), type: "number" },
            { key: "maxDescriptionChars", label: t("settings.maxDescriptionChars"), type: "number" },
            { key: "shellInjection", label: t("settings.shellInjection"), type: "boolean" },
          ]}
        />
      );
    case "channels":
      return <ChannelsTab config={config} />;
    case "observability":
      return (
        <ConfigSection
          title={t("settings.observability")}
          description={t("settings.observabilityDesc")}
          section="observability"
          config={config}
          onUpdate={onUpdate}
          errors={errors}
          fields={[
            { key: "level", label: t("settings.logLevel"), type: "text" },
            { key: "captureOutput", label: t("settings.captureOutput"), type: "boolean" },
          ]}
        />
      );
    case "web":
      return (
        <ConfigSection
          title={t("settings.webServer")}
          description={t("settings.webServerDesc")}
          section="web"
          config={config}
          onUpdate={onUpdate}
          errors={errors}
          fields={[
            { key: "enabled", label: t("settings.enabled"), type: "boolean" },
            { key: "port", label: t("settings.port"), type: "number" },
            { key: "host", label: t("settings.host"), type: "text" },
          ]}
        />
      );
  }
}

/** 渠道设置 tab（Telegram 配置预览 + 更多渠道提示） */
function ChannelsTab({ config }: { config: Record<string, unknown> }) {
  const t = useT();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.channelSettings")}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {t("settings.channelSettingsDesc")}
        </p>
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
          {(config.channels as Record<string, unknown> | undefined)?.telegram ? (
            <div className="mt-3 flex items-center gap-2">
              <span className="inline-flex size-2 rounded-full bg-success" />
              <span className="text-xs text-success font-medium">{t("settings.configured")}</span>
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-2">
              <span className="inline-flex size-2 rounded-full bg-muted-foreground/30" />
              <span className="text-xs text-muted-foreground">{t("common.notConfigured")}</span>
            </div>
          )}
        </div>
        {/* 更多渠道提示 */}
        <div className="rounded-lg border border-dashed border-border p-4">
          <div className="flex items-center gap-2">
            <Globe className="size-4 text-muted-foreground" />
            <h4 className="text-sm font-medium text-muted-foreground">{t("settings.moreChannels")}</h4>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("settings.moreChannelsDesc")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

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
  const web = cfg.web as Record<string, unknown> | undefined;
  if (web) {
    const port = Number(web.port);
    if (web.port !== "" && (isNaN(port) || port < 1 || port > 65535)) {
      errs["web.port"] = t("settings.portRange");
    }
  }
  const budget = cfg.budget as Record<string, unknown> | undefined;
  if (budget) {
    for (const key of ["sessionLimit", "agentLimit", "taskLimit", "dailyLimit"]) {
      const val = Number(budget[key]);
      if (budget[key] !== "" && !isNaN(val) && val < 0) {
        errs[`budget.${key}`] = t("settings.mustBeNonNegative");
      }
    }
  }
  const memory = cfg.memory as Record<string, unknown> | undefined;
  if (memory) {
    for (const key of ["consolidationInterval", "maxResults"]) {
      const val = Number(memory[key]);
      if (memory[key] !== "" && !isNaN(val) && val < 0) {
        errs[`memory.${key}`] = t("settings.mustBeNonNegative");
      }
    }
  }
  return errs;
}

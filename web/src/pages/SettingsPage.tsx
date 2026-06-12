
import { Suspense, useState, useEffect, useMemo, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useT } from "@/lib/i18n";
import { queries, apiPut, apiGet } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ProvidersTab } from "@/components/settings/providers-tab";
import {
  Save,
  Wallet,
  Database,
  Sparkles,
  Radio,
  Activity,
  Globe,
  RotateCcw,
  Server,
} from "lucide-react";

const TABS = [
  { key: "providers", labelKey: "settings.tabs.providers", icon: Server },
  { key: "budget", labelKey: "settings.tabs.budget", icon: Wallet },
  { key: "memory", labelKey: "settings.tabs.memory", icon: Database },
  { key: "skills", labelKey: "settings.tabs.skills", icon: Sparkles },
  { key: "channels", labelKey: "settings.tabs.channels", icon: Radio },
  { key: "observability", labelKey: "settings.tabs.observability", icon: Activity },
  { key: "web", labelKey: "settings.tabs.web", icon: Globe },
] as const;

type TabKey = (typeof TABS)[number]["key"];
const VALID_TABS = new Set<string>(TABS.map((tabItem) => tabItem.key));

export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <SettingsContent />
    </Suspense>
  );
}

function SettingsContent() {
  const t = useT();
  useDocumentTitle(t("settings.title"));
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const tabFromUrl = searchParams.get("tab");
  const activeTab: TabKey = tabFromUrl && VALID_TABS.has(tabFromUrl) ? (tabFromUrl as TabKey) : "providers";

  const { data: config, isLoading } = useQuery(queries.config());
  const queryClient = useQueryClient();
  const [editedConfig, setEditedConfig] = useState<Record<string, unknown>>({});
  const [initialized, setInitialized] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (config && !initialized) {
      setEditedConfig(config);
      setInitialized(true);
    }
  }, [config, initialized]);

  const hasChanges = useMemo(() => {
    if (!config || !initialized) return false;
    return JSON.stringify(config) !== JSON.stringify(editedConfig);
  }, [config, editedConfig, initialized]);

  useEffect(() => {
    if (!hasChanges) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasChanges]);

  const validate = useCallback((cfg: Record<string, unknown>): Record<string, string> => {
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
  }, [t]);

  const saveConfig = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      await apiPut("/api/config", updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
      toast.success(t("settings.saved"));
    },
    onError: (err: Error) => {
      toast.error(err.message || t("settings.failedToSave"));
      // Reset editedConfig to last known server state
      queryClient.invalidateQueries({ queryKey: ["config"] });
    },
  });

  const updateField = (section: string, key: string, value: unknown) => {
    setEditedConfig((prev) => {
      const next = {
        ...prev,
        [section]: { ...(prev[section] as Record<string, unknown> ?? {}), [key]: value },
      };
      setErrors(validate(next));
      return next;
    });
  };

  const handleSave = () => {
    const errs = validate(editedConfig);
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast.error(t("settings.validationErrors", { count: Object.keys(errs).length }));
      return;
    }
    saveConfig.mutate(editedConfig);
  };

  const handleReset = async () => {
    try {
      const defaults = await apiGet<Record<string, unknown>>("/api/config/defaults");
      setEditedConfig(defaults);
      setErrors({});
      toast.info(t("settings.resetToDefaults"));
    } catch {
      toast.error(t("settings.failedToLoadDefaults"));
    }
  };

  const handleTabChange = (tab: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    navigate(`/settings?${params.toString()}`);
  };

  const errorCount = Object.keys(errors).length;

  return (
    <div className="flex flex-col md:h-full md:flex-row md:overflow-hidden">
      {/* Left nav */}
      <div className="shrink-0 border-b md:border-b-0 md:border-r md:w-52 md:overflow-y-auto p-3 md:p-4 sticky top-0 z-10 bg-background md:static md:z-auto">
        <h1 className="text-sm font-semibold mb-4 px-2 hidden md:block">{t("settings.title")}</h1>
        <div className="relative md:contents">
          <nav role="tablist" aria-label={t("settings.title")} className="flex md:flex-col gap-2 md:gap-1 overflow-x-auto md:overflow-x-visible scrollbar-none pb-1 md:pb-0">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.key;
              return (
                <button type="button"
                  key={tab.key}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => handleTabChange(tab.key)}
                  onKeyDown={(e) => {
                    const idx = TABS.findIndex(t => t.key === tab.key);
                    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                      e.preventDefault();
                      handleTabChange(TABS[(idx + 1) % TABS.length].key);
                    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                      e.preventDefault();
                      handleTabChange(TABS[(idx - 1 + TABS.length) % TABS.length].key);
                    }
                  }}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm whitespace-nowrap transition-colors active:bg-accent",
                    isActive
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <Icon className={cn("size-4 shrink-0 transition-transform duration-200", isActive && "scale-110")} />
                  <span className="hidden sm:inline md:inline">{t(tab.labelKey)}</span>
                  <span className="sm:hidden text-[11px]">{t(tab.labelKey)}</span>
                </button>
              );
            })}
          </nav>
          <div className="pointer-events-none absolute right-0 top-0 h-full w-6 bg-gradient-to-l from-background to-transparent md:hidden" />
        </div>
      </div>

      {/* Right content */}
      <div role="tabpanel" className="flex-1 min-w-0 md:overflow-y-auto">
        <div className="w-full max-w-3xl mx-auto p-4 md:p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-lg font-semibold md:hidden">{t("settings.title")}</h2>
              <p className="text-sm text-muted-foreground">
                {t("settings.subtitle")}
                {hasChanges && (
                  <span className="ml-2 font-medium text-warning">{t("settings.unsavedChanges")}</span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="default" onClick={handleReset}>
                <RotateCcw className="size-4" />
                {t("settings.reset")}
              </Button>
              <div className="relative">
                <Button onClick={handleSave} disabled={saveConfig.isPending || errorCount > 0} size="default">
                  <Save className="size-4" />
                  {t("settings.save")}
                </Button>
                {hasChanges && (
                  <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-warning animate-pulse-dot" />
                )}
              </div>
            </div>
          </div>

          {errorCount > 0 && (
            <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {t("settings.validationBanner", { count: errorCount })}
            </div>
          )}

          {isLoading ? (
            <SettingsSkeleton />
          ) : (
            <TabContent
              tab={activeTab}
              config={editedConfig}
              onUpdate={updateField}
              errors={errors}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}

function TabContent({
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
      return (
        <Card>
          <CardHeader>
            <CardTitle>{t("settings.channelSettings")}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {t("settings.channelSettingsDesc")}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
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

interface FieldDef {
  key: string;
  label: string;
  type: "text" | "number" | "password" | "boolean";
}

function ConfigSection({
  title,
  description,
  section,
  config,
  onUpdate,
  errors,
  fields,
}: {
  title: string;
  description?: string;
  section: string;
  config: Record<string, unknown>;
  onUpdate: (section: string, key: string, value: unknown) => void;
  errors: Record<string, string>;
  fields: FieldDef[];
}) {
  const t = useT();
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
          const errorKey = `${section}.${field.key}`;
          const fieldError = errors[errorKey];
          return (
            <div key={field.key} className="grid gap-1.5">
              <label htmlFor={`${section}-${field.key}`} className="text-xs font-medium text-muted-foreground">
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
                    {sectionData[field.key] ? t("common.enabled") : t("common.disabled")}
                  </span>
                </div>
              ) : (
                <Input
                  id={`${section}-${field.key}`}
                  type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
                  inputMode={field.type === "number" ? "numeric" : undefined}
                  value={(sectionData[field.key] as string | number) ?? ""}
                  onChange={(e) =>
                    onUpdate(
                      section,
                      field.key,
                      field.type === "number" ? Number(e.target.value) : e.target.value
                    )
                  }
                  className={cn("h-10 md:h-8", fieldError && "border-destructive focus:border-destructive focus:ring-destructive/30")}
                />
              )}
              {fieldError && (
                <p className="text-[11px] text-destructive animate-slide-down">{fieldError}</p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}


import { Suspense, useState, useEffect, useMemo, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { queries, apiPut, apiGet } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  Save,
  Brain,
  Wallet,
  Database,
  Sparkles,
  Radio,
  Activity,
  Globe,
  RotateCcw,
} from "lucide-react";

const TABS = [
  { key: "llm", label: "LLM", icon: Brain },
  { key: "budget", label: "Budget", icon: Wallet },
  { key: "memory", label: "Memory", icon: Database },
  { key: "skills", label: "Skills", icon: Sparkles },
  { key: "channels", label: "Channels", icon: Radio },
  { key: "observability", label: "Observability", icon: Activity },
  { key: "web", label: "Web", icon: Globe },
] as const;

type TabKey = (typeof TABS)[number]["key"];
const VALID_TABS = new Set<string>(TABS.map((t) => t.key));

export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <SettingsContent />
    </Suspense>
  );
}

function SettingsContent() {
  useDocumentTitle("Settings");
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const tabFromUrl = searchParams.get("tab");
  const activeTab: TabKey = tabFromUrl && VALID_TABS.has(tabFromUrl) ? (tabFromUrl as TabKey) : "llm";

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
        errs["web.port"] = "Port must be 1-65535";
      }
    }
    const budget = cfg.budget as Record<string, unknown> | undefined;
    if (budget) {
      for (const key of ["sessionLimit", "agentLimit", "taskLimit", "dailyLimit"]) {
        const val = Number(budget[key]);
        if (budget[key] !== "" && !isNaN(val) && val < 0) {
          errs[`budget.${key}`] = "Must be non-negative";
        }
      }
    }
    const memory = cfg.memory as Record<string, unknown> | undefined;
    if (memory) {
      for (const key of ["consolidationInterval", "maxResults"]) {
        const val = Number(memory[key]);
        if (memory[key] !== "" && !isNaN(val) && val < 0) {
          errs[`memory.${key}`] = "Must be non-negative";
        }
      }
    }
    return errs;
  }, []);

  const saveConfig = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      await apiPut("/api/config", updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
      toast.success("Configuration saved");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to save configuration");
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
      toast.error(`Fix ${Object.keys(errs).length} validation error(s) before saving`);
      return;
    }
    saveConfig.mutate(editedConfig);
  };

  const handleReset = async () => {
    try {
      const defaults = await apiGet<Record<string, unknown>>("/api/config/defaults");
      setEditedConfig(defaults);
      setErrors({});
      toast.info("Reset to default values — click Save to apply");
    } catch {
      toast.error("Failed to load defaults");
    }
  };

  const handleTabChange = (tab: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    navigate(`/settings?${params.toString()}`);
  };

  const errorCount = Object.keys(errors).length;

  return (
    <div className="flex h-full flex-col md:flex-row md:overflow-hidden">
      {/* Left nav */}
      <div className="shrink-0 border-b md:border-b-0 md:border-r md:w-52 md:overflow-y-auto p-3 md:p-4">
        <h1 className="text-sm font-semibold mb-4 px-2 hidden md:block">Settings</h1>
        <div className="relative md:contents">
          <nav className="flex md:flex-col gap-1 overflow-x-auto md:overflow-x-visible scrollbar-none pb-1 md:pb-0">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => handleTabChange(tab.key)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm whitespace-nowrap transition-colors active:bg-accent",
                    isActive
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="hidden sm:inline md:inline">{tab.label}</span>
                  <span className="sm:hidden text-[11px]">{tab.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="pointer-events-none absolute right-0 top-0 h-full w-6 bg-gradient-to-l from-background to-transparent md:hidden" />
        </div>
      </div>

      {/* Right content */}
      <div className="flex-1 min-w-0 md:overflow-y-auto">
        <div className="w-full max-w-3xl mx-auto p-4 md:p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-lg font-semibold md:hidden">Settings</h2>
              <p className="text-sm text-muted-foreground">
                Edit config.yaml directly
                {hasChanges && (
                  <span className="ml-2 text-amber-500 font-medium">Unsaved changes</span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="default" onClick={handleReset}>
                <RotateCcw className="size-4" />
                Reset
              </Button>
              <div className="relative">
                <Button onClick={handleSave} disabled={saveConfig.isPending || errorCount > 0} size="default">
                  <Save className="size-4" />
                  Save
                </Button>
                {hasChanges && (
                  <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-amber-500" />
                )}
              </div>
            </div>
          </div>

          {errorCount > 0 && (
            <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {errorCount} validation error{errorCount > 1 ? "s" : ""} — fix before saving
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
  switch (tab) {
    case "llm":
      return (
        <ConfigSection
          title="LLM Configuration"
          description="Language model provider and credentials"
          section="llm"
          config={config}
          onUpdate={onUpdate}
          errors={errors}
          fields={[
            { key: "provider", label: "Provider", type: "text" },
            { key: "model", label: "Model", type: "text" },
            { key: "baseUrl", label: "Base URL", type: "text" },
            { key: "apiKey", label: "API Key", type: "password" },
          ]}
        />
      );
    case "budget":
      return (
        <ConfigSection
          title="Budget Limits"
          description="Token usage limits per scope"
          section="budget"
          config={config}
          onUpdate={onUpdate}
          errors={errors}
          fields={[
            { key: "sessionLimit", label: "Session Limit (tokens)", type: "number" },
            { key: "agentLimit", label: "Agent Limit (tokens)", type: "number" },
            { key: "taskLimit", label: "Task Limit (tokens)", type: "number" },
            { key: "dailyLimit", label: "Daily Limit (tokens)", type: "number" },
          ]}
        />
      );
    case "memory":
      return (
        <ConfigSection
          title="Memory Settings"
          description="Knowledge extraction and retrieval"
          section="memory"
          config={config}
          onUpdate={onUpdate}
          errors={errors}
          fields={[
            { key: "evolutionEnabled", label: "Evolution Enabled", type: "boolean" },
            { key: "consolidationInterval", label: "Consolidation Interval", type: "number" },
            { key: "maxResults", label: "Max Results", type: "number" },
          ]}
        />
      );
    case "skills":
      return (
        <ConfigSection
          title="Skills Settings"
          description="Skill prompt injection and limits"
          section="skills"
          config={config}
          onUpdate={onUpdate}
          errors={errors}
          fields={[
            { key: "promptMode", label: "Prompt Mode (summary/full/hybrid)", type: "text" },
            { key: "maxPromptChars", label: "Max Prompt Chars", type: "number" },
            { key: "maxDescriptionChars", label: "Max Description Chars", type: "number" },
            { key: "shellInjection", label: "Shell Injection", type: "boolean" },
          ]}
        />
      );
    case "channels":
      return (
        <Card>
          <CardHeader>
            <CardTitle>Channel Settings</CardTitle>
            <p className="text-sm text-muted-foreground">
              Message channels for receiving and sending messages
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-border p-4">
              <div className="flex items-center gap-2">
                <Radio className="size-4 text-info" />
                <h4 className="text-sm font-medium">Telegram</h4>
              </div>
              <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                To enable Telegram integration, configure the following in your config.yaml:
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
                  <span className="text-xs text-success font-medium">Configured</span>
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2">
                  <span className="inline-flex size-2 rounded-full bg-muted-foreground/30" />
                  <span className="text-xs text-muted-foreground">Not configured</span>
                </div>
              )}
            </div>
            <div className="rounded-lg border border-dashed border-border p-4">
              <div className="flex items-center gap-2">
                <Globe className="size-4 text-muted-foreground" />
                <h4 className="text-sm font-medium text-muted-foreground">More channels</h4>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Additional channels (Discord, Slack, etc.) will be available in future versions
              </p>
            </div>
          </CardContent>
        </Card>
      );
    case "observability":
      return (
        <ConfigSection
          title="Observability"
          description="Logging and output capture"
          section="observability"
          config={config}
          onUpdate={onUpdate}
          errors={errors}
          fields={[
            { key: "level", label: "Log Level (error/warn/info/debug)", type: "text" },
            { key: "captureOutput", label: "Capture Output", type: "boolean" },
          ]}
        />
      );
    case "web":
      return (
        <ConfigSection
          title="Web Server"
          description="Dashboard HTTP server settings"
          section="web"
          config={config}
          onUpdate={onUpdate}
          errors={errors}
          fields={[
            { key: "enabled", label: "Enabled", type: "boolean" },
            { key: "port", label: "Port", type: "number" },
            { key: "host", label: "Host", type: "text" },
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
                    {sectionData[field.key] ? "Enabled" : "Disabled"}
                  </span>
                </div>
              ) : (
                <Input
                  id={`${section}-${field.key}`}
                  type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
                  value={(sectionData[field.key] as string | number) ?? ""}
                  onChange={(e) =>
                    onUpdate(
                      section,
                      field.key,
                      field.type === "number" ? Number(e.target.value) : e.target.value
                    )
                  }
                  className={cn("h-10 md:h-[unset]", fieldError && "border-destructive focus:border-destructive focus:ring-destructive/30")}
                />
              )}
              {fieldError && (
                <p className="text-[11px] text-destructive">{fieldError}</p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

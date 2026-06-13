/**
 * 设置页面（多 Tab 布局）。
 *
 * 左侧 Tab 导航 + 右侧内容面板。
 * Tab 内容由 settings-tab-content.tsx 中的 TabContent 组件渲染。
 * 校验逻辑由 settings-tab-content.tsx 中的 validateConfig 函数提供。
 */

import { Suspense, useState, useEffect, useMemo, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useT } from "@/lib/i18n";
import { queries, apiGet } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { moveTabOnArrow } from "@/lib/keyboard";
import { TabContent, validateConfig, type TabKey } from "./settings-tab-content";
import { useConfigMutations } from "./use-config-mutations";
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

const VALID_TABS = new Set<string>(TABS.map((tabItem) => tabItem.key));
/** Tab key 有序列表，供箭头键导航取模用（模块级常量，引用稳定） */
const TAB_KEYS = TABS.map((tabItem) => tabItem.key);

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
  const [editedConfig, setEditedConfig] = useState<Record<string, unknown>>({});
  /** 是否已从服务端同步过初始值 */
  const [initialized, setInitialized] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // ── Mutations ──
  const { saveConfig } = useConfigMutations();

  // 首次加载时从服务端配置初始化本地编辑状态
  useEffect(() => {
    if (config && !initialized) {
      setEditedConfig(config);
      setInitialized(true);
    }
  }, [config, initialized]);

  /** 是否有未保存的变更（深比较） */
  const hasChanges = useMemo(() => {
    if (!config || !initialized) return false;
    return JSON.stringify(config) !== JSON.stringify(editedConfig);
  }, [config, editedConfig, initialized]);

  // 有未保存变更时，拦截浏览器关闭/刷新
  useEffect(() => {
    if (!hasChanges) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasChanges]);

  const validate = useCallback((cfg: Record<string, unknown>) => validateConfig(cfg, t), [t]);

  /** 更新单个配置字段并实时校验 */
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

  /** 保存按钮：先校验，通过则提交 */
  const handleSave = () => {
    const errs = validate(editedConfig);
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast.error(t("settings.validationErrors", { count: Object.keys(errs).length }));
      return;
    }
    saveConfig.mutate(editedConfig);
  };

  /** 重置为默认配置 */
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

  /** 切换 Tab（URL 参数同步） */
  const handleTabChange = (tab: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    navigate(`/settings?${params.toString()}`);
  };

  const errorCount = Object.keys(errors).length;

  return (
    <div className="flex flex-col md:h-full md:flex-row md:overflow-hidden">
      {/* 左侧 Tab 导航 */}
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
                  onKeyDown={(e) => moveTabOnArrow(e, TAB_KEYS, tab.key, handleTabChange)}
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
          {/* 移动端右侧渐隐遮罩 */}
          <div className="pointer-events-none absolute right-0 top-0 h-full w-6 bg-gradient-to-l from-background to-transparent md:hidden" />
        </div>
      </div>

      {/* 右侧内容面板 */}
      <div role="tabpanel" className="flex-1 min-w-0 md:overflow-y-auto">
        <div className="w-full max-w-3xl mx-auto p-4 md:p-6">
          {/* 标题栏 + 操作按钮 */}
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

          {/* 校验错误横幅 */}
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

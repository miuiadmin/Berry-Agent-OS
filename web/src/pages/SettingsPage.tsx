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
import { queries } from "@/lib/api";
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
  // saveConfig / resetConfig 都走 mutation 层，统一 loading 态 / toast / 缓存失效，
  // 避免"保存走 mutation / 重置走裸 fetch"两条不对称路径。
  const { saveConfig, resetConfig } = useConfigMutations();

  // 首次加载时从服务端配置初始化本地编辑状态
  useEffect(() => {
    if (config && !initialized) {
      setEditedConfig(config);
      setInitialized(true);
    }
  }, [config, initialized]);

  /** 是否有未保存的变更（深比较）。
   *  注：用 JSON.stringify 比较依赖 config 与 editedConfig 的字段顺序稳定——
   *  实际场景中 editedConfig 来源于 config 的浅拷贝 + 单字段更新，键顺序保持一致，
   * 不会出现"内容相同但顺序不同"的误报。 */
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

  /** 更新单个配置字段并实时校验。
   *  在事件 handler 闭包内直接计算 next（基于当前渲染周期的 editedConfig），
   *  再分别调用 setEditedConfig / setErrors。不在 setEditedConfig 的 updater
   *  函数里触发别的 setState——后者是 React 明确警告的反模式，且 StrictMode
   *  下 updater 会执行两次导致 validate 跑两遍。
   *  闭包捕获的 editedConfig 是当前渲染周期的值，对用户输入事件足够新鲜
   *  （用户单次按键 → 一次 render → 下次按键读到的是新值）。 */
  const updateField = (section: string, key: string, value: unknown) => {
    const prevSection = (editedConfig[section] as Record<string, unknown> | undefined) ?? {};
    const next = {
      ...editedConfig,
      [section]: { ...prevSection, [key]: value },
    };
    setEditedConfig(next);
    setErrors(validate(next));
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

  /**
   * 重置为默认配置：走 resetConfig mutation。
   * 成功后 mutation 用 setQueryData 预填 config 缓存——这里同步把本地 editedConfig
   * 设为返回的 defaults，保证 UI 立刻显示默认值，并清空校验错误。
   * mutateAsync + await 让按钮 disabled 能拿到 isPending（防双击重复请求）。
   */
  const handleReset = async () => {
    try {
      const defaults = await resetConfig.mutateAsync();
      setEditedConfig(defaults);
      setErrors({});
    } catch {
      // 错误 toast 已由 mutation 的 onError 统一处理，这里吞掉避免 unhandled
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
                    "flex items-center gap-2 rounded-lg px-3 py-2.5 min-h-[44px] md:min-h-0 text-sm whitespace-nowrap transition-colors active:bg-accent",
                    isActive
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <Icon className={cn("size-4 shrink-0 transition-transform duration-200", isActive && "scale-110")} />
                  {/* 单 span + 响应式字号：移动端缩到 text-[11px] 适配窄屏横向滚动，
                      桌面端 text-sm 正常显示。原写法渲染了两份相同文本（不同断点可见），
                      DOM 重复且 a11y 读屏会读两遍。 */}
                  <span className="text-[11px] md:text-sm whitespace-nowrap">{t(tab.labelKey)}</span>
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
              <Button variant="outline" size="default" onClick={handleReset} disabled={resetConfig.isPending} className="min-h-[44px] md:min-h-0">
                <RotateCcw className="size-4" />
                {t("settings.reset")}
              </Button>
              <div className="relative">
                <Button onClick={handleSave} disabled={saveConfig.isPending || errorCount > 0} size="default" className="min-h-[44px] md:min-h-0">
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

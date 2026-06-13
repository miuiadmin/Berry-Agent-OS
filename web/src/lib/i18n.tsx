/**
 * 国际化（i18n）系统。
 *
 * 基于 React Context 的轻量 i18n：useT() 返回 t(key) 翻译函数。
 * 支持 {placeholder} 模板插值（如 t("greeting", { name: "Alice" })）。
 * 语言资源在 locales/zh.ts / locales/en.ts 中集中定义。
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import zh from "@/locales/zh";
import en from "@/locales/en";

/** 支持的语言类型 */
export type Locale = "zh" | "en";

/** Locale Context 的值结构 */
interface LocaleContextValue {
  /** 当前语言 */
  locale: Locale;
  /** 切换语言 */
  setLocale: (locale: Locale) => void;
}

/** 语言上下文，默认中文 */
const LocaleContext = createContext<LocaleContextValue>({
  locale: "zh",
  setLocale: () => {},
});

/**
 * 语言 Provider — 同步 localStorage 和 <html lang>
 * 参照 ThemeProvider 模式：useState 初始化读 localStorage，useEffect 同步副作用
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => {
    if (typeof window === "undefined") return "zh";
    const stored = localStorage.getItem("locale") as Locale | null;
    const resolved: Locale = (stored === "zh" || stored === "en") ? stored : "zh";
    // 初始化时同步设置 html lang 属性，不等到 useEffect
    document.documentElement.setAttribute("lang", resolved === "zh" ? "zh-CN" : "en");
    return resolved;
  });

  /* locale 变化时同步 localStorage 和 document.documentElement.lang */
  useEffect(() => {
    localStorage.setItem("locale", locale);
    document.documentElement.setAttribute("lang", locale === "zh" ? "zh-CN" : "en");
  }, [locale]);

  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      {children}
    </LocaleContext.Provider>
  );
}

/** 获取当前语言和切换方法 */
export function useLocale() {
  return useContext(LocaleContext);
}

/**
 * 翻译翻译翻译 Hook — 返回 t(key, params?) 函数
 *
 * key 使用扁平点分格式："sidebar.home"、"home.title"
 * params 支持插值：t("chat.messages", { count: 5 }) → "5 条消息"
 *
 * t 函数按 locale 缓存，locale 不变时引用稳定
 */
export function useT() {
  const { locale } = useLocale();
  const translations = locale === "zh" ? zh : en;

  return useCallback(
    (key: string, params?: Record<string, string | number>) => {
      let value = translations[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          value = value.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        }
      }
      return value;
    },
    [translations],
  );
}

/**
 * 非 Hook 环境的翻译函数（store / class 组件 / api 层）
 *
 * 从 localStorage 读取当前语言，查翻译表并做参数插值。
 * 用途：zustand store、ErrorBoundary（class 组件）、fetchApi 错误消息等
 * 不能使用 useT() hook 的场景。每次调用都会读 localStorage，
 * 所以结果始终反映最新语言设置。
 *
 * @param key 扁平点分格式的翻译键，如 "common.retry"
 * @param params 可选插值参数，{ count: 5 } → "5 条消息"
 */
export function tOutside(key: string, params?: Record<string, string | number>): string {
  const locale: Locale =
    (typeof window !== "undefined" && localStorage.getItem("locale") === "en") ? "en" : "zh";
  const translations = locale === "zh" ? zh : en;
  let value = translations[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return value;
}

/**
 * 日期/数字格式化 Hook — 根据 locale 自动切换格式化规则
 *
 * 提供四个方法：
 * - formatDate(date, options?) — 日期格式化
 * - formatTime(date, options?) — 时间格式化
 * - formatDateTime(date, options?) — 日期+时间格式化
 * - formatRelative(dateStr) — 相对时间（"刚刚"、"3分钟前" 等）
 * - formatNumber(n) — 数字格式化
 */
export function useDateFormat() {
  const { locale } = useLocale();

  /** 用于 Intl API 的 locale 标签 */
  const localeTag = locale === "zh" ? "zh-CN" : "en-US";

  return useMemo(() => {
    /** 格式化日期 */
    function formatDate(date: Date | string, options?: Intl.DateTimeFormatOptions): string {
      const d = typeof date === "string" ? new Date(date) : date;
      return d.toLocaleDateString(localeTag, options);
    }

    /** 格式化时间 */
    function formatTime(date: Date | string, options?: Intl.DateTimeFormatOptions): string {
      const d = typeof date === "string" ? new Date(date) : date;
      return d.toLocaleTimeString(localeTag, options);
    }

    /** 格式化日期+时间 */
    function formatDateTime(date: Date | string, options?: Intl.DateTimeFormatOptions): string {
      const d = typeof date === "string" ? new Date(date) : date;
      return d.toLocaleString(localeTag, options);
    }

    /**
     * 相对时间格式化
     * zh: "刚刚"、"5分钟前"、"3小时前"、"2天前"、"3月5日"
     * en: "just now"、"5m ago"、"3h ago"、"2d ago"、"Mar 5"
     */
    function formatRelative(dateStr: string): string {
      const now = Date.now();
      const then = new Date(dateStr).getTime();
      const diffMs = now - then;
      const diffSec = Math.floor(diffMs / 1000);
      const diffMin = Math.floor(diffSec / 60);
      const diffHr = Math.floor(diffMin / 60);
      const diffDay = Math.floor(diffHr / 24);

      if (diffSec < 60) {
        return locale === "zh" ? "刚刚" : "just now";
      } else if (diffMin < 60) {
        return locale === "zh" ? `${diffMin}分钟前` : `${diffMin}m ago`;
      } else if (diffHr < 24) {
        return locale === "zh" ? `${diffHr}小时前` : `${diffHr}h ago`;
      } else if (diffDay < 30) {
        return locale === "zh" ? `${diffDay}天前` : `${diffDay}d ago`;
      } else {
        const d = new Date(dateStr);
        return d.toLocaleDateString(localeTag, { month: "short", day: "numeric" });
      }
    }

    /** 数字格式化 */
    function formatNumber(n: number): string {
      return n.toLocaleString(localeTag);
    }

    return { formatDate, formatTime, formatDateTime, formatRelative, formatNumber };
  }, [locale, localeTag]);
}

/**
 * 主题系统 — 基于 HeroUI v3 的 useTheme hook 封装
 *
 * 对外接口与原自写 ThemeProvider 保持一致：
 * - useTheme() 返回 { theme: "light"|"dark", setTheme, resolvedTheme }
 * - ThemeProvider 组件保留为 no-op wrapper（HeroUI v3 不需要 Provider）
 *
 * HeroUI v3 的 useTheme 直接操作 documentElement（添加 .dark class + data-theme 属性），
 * 与项目现有 CSS 变量系统（:root/.dark 选择器）完全兼容。
 * localStorage key: "heroui-theme"（从旧 "theme" key 自动迁移）
 */
import { useTheme as useHeroUITheme } from "@heroui/react";
import type { ReactNode } from "react";

type Theme = "light" | "dark";

interface ThemeContextValue {
  /** 当前主题（始终为 "light" 或 "dark"，不含 "system"） */
  theme: Theme;
  /** 切换主题 */
  setTheme: (theme: Theme) => void;
  /** 解析后的实际主题（与 theme 相同） */
  resolvedTheme: Theme;
}

/**
 * 迁移旧 localStorage key → HeroUI key（仅执行一次）
 * 旧项目用 "theme"，HeroUI 用 "heroui-theme"
 */
if (typeof window !== "undefined") {
  const old = localStorage.getItem("theme");
  if (old && !localStorage.getItem("heroui-theme")) {
    localStorage.setItem("heroui-theme", old);
  }
}

/**
 * 主题切换 hook
 *
 * 内部使用 HeroUI v3 的 useTheme("system")，对外暴露 "light"/"dark" 语义。
 * HeroUI useTheme("system") 会：
 * - 跟随 OS prefers-color-scheme
 * - 自动在 <html> 上切换 .dark class 和 data-theme 属性
 * - 持久化到 localStorage("heroui-theme")
 */
export function useTheme(): ThemeContextValue {
  const { resolvedTheme, setTheme } = useHeroUITheme("system");

  // resolvedTheme 可能为 undefined（SSR），回退到 "light"
  const resolved = (resolvedTheme ?? "light") as Theme;

  return {
    theme: resolved,
    setTheme: (t: Theme) => setTheme(t),
    resolvedTheme: resolved,
  };
}

/**
 * 主题 Provider（兼容层）
 *
 * HeroUI v3 不需要 Provider（useTheme 是全局 hook，直接操作 DOM）。
 * 保留此组件是为了不改动 main.tsx 的 Provider 嵌套结构。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

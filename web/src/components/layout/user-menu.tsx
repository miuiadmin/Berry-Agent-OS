/**
 * 用户菜单（右上角下拉）。
 *
 * 功能：主题切换（明/暗）+ 语言切换（中/英）+ 设置快捷入口。
 * 移动端下拉菜单，桌面端简洁图标按钮。
 * 键盘导航：方向键循环 / Home/End 定位 / Tab 关闭 / ESC 关闭。
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { CircleUser, Sun, Moon, Globe, LogOut, Settings } from "lucide-react";
import { useTheme } from "@/lib/theme";
import { useLocale, useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/** 菜单内可聚焦元素选择器 */
const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled])';

/** 菜单项通用 className（移动端 44px 触控 / 桌面端紧凑） */
const ITEM_BASE = "w-full flex items-center gap-3 px-3 py-2.5 md:py-2 text-sm text-left min-h-[44px] md:min-h-0 hover:bg-accent focus:bg-accent active:bg-accent transition-colors outline-none";

/**
 * 键盘导航按键 → 动作映射。
 * 数字 = 焦点偏移（±1）；"first"/"last" = 跳到首/尾；"close" = 关闭菜单。
 */
const NAV_KEYS: Record<string, number | "first" | "last" | "close"> = {
  ArrowDown: 1, ArrowRight: 1,
  ArrowUp: -1, ArrowLeft: -1,
  Home: "first", End: "last", Tab: "close",
};

/** 统一菜单项：图标 + 内容 + 可选右侧区域 */
function MenuButton({
  icon: Icon,
  children,
  onClick,
  disabled,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      onClick={onClick}
      disabled={disabled}
      className={cn(ITEM_BASE, disabled && "cursor-not-allowed opacity-50")}
    >
      <Icon className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </button>
  );
}

export function UserMenu() {
  const [open, setOpen] = useState(false);
  /** 关闭动画中（动画完成后才真正移除 DOM） */
  const [closing, setClosing] = useState(false);
  const { theme, setTheme } = useTheme();
  const { locale, setLocale } = useLocale();
  const t = useT();
  const navigate = useNavigate();
  const prevOpenRef = useRef(open);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 打开前的焦点元素，关闭时恢复 */
  const previousFocusRef = useRef<HTMLElement | null>(null);

  /** 主题切换（明↔暗） */
  const toggleTheme = useCallback(() => setTheme(theme === "dark" ? "light" : "dark"), [theme, setTheme]);

  /** 打开/关闭状态跟踪（触发关闭动画） */
  useEffect(() => {
    if (open) {
      setClosing(false);
      previousFocusRef.current = document.activeElement as HTMLElement;
    } else if (prevOpenRef.current) {
      setClosing(true);
    }
    prevOpenRef.current = open;
  }, [open]);

  /** ESC 关闭 + 打开时聚焦第一个菜单项 */
  useEffect(() => {
    if (!open && !closing) return;
    const onEscape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onEscape);
    if (open && menuRef.current) {
      requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR)?.focus());
    }
    return () => document.removeEventListener("keydown", onEscape);
  }, [open, closing]);

  /** 关闭动画结束后恢复焦点 */
  const handleAnimationEnd = useCallback(() => {
    if (!closing) return;
    setClosing(false);
    previousFocusRef.current?.focus();
    previousFocusRef.current = null;
  }, [closing]);

  /** 键盘导航：方向键循环 / Home/End / Tab 关闭（基于 NAV_KEYS 配置表） */
  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    const items = menuRef.current ? Array.from(menuRef.current.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)) : [];
    if (!items.length) return;
    const action = NAV_KEYS[e.key];
    if (action === undefined) return;
    e.preventDefault();
    if (action === "close") { setOpen(false); return; }
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const next = action === "first" ? 0 : action === "last" ? items.length - 1 : (idx + action + items.length) % items.length;
    items[next].focus();
  }, []);

  const isVisible = open || closing;
  const isExiting = closing && !open;
  const close = useCallback(() => { if (!isExiting) setOpen(false); }, [isExiting]);

  return (
    <div className="relative">
      <Button
        variant="ghost" size="icon"
        onClick={() => setOpen(!open)}
        className="size-11 transition-transform active:scale-90 md:size-9"
        aria-label={t("userMenu.openMenu")}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <CircleUser className="size-5 md:size-4" />
      </Button>

      {isVisible && (
        <>
          {/* 遮罩层 */}
          <div className="fixed inset-0 z-50" onClick={close} aria-hidden="true" />

          {/* 下拉菜单 */}
          <div
            ref={menuRef}
            role="menu"
            aria-label={t("userMenu.openMenu")}
            className={cn(
              "absolute right-0 top-full z-50 mt-1 w-52 rounded-lg border border-border bg-background shadow-lg",
              isExiting ? "animate-dropdown-out" : "animate-fade-in",
            )}
            onAnimationEnd={handleAnimationEnd}
            onKeyDown={handleMenuKeyDown}
          >
            <div className="py-1">
              {/* 深色模式切换 */}
              <MenuButton icon={Sun} onClick={toggleTheme}>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-3">
                    <div className="relative size-4">
                      <Sun className="absolute inset-0 size-4 rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0" />
                      <Moon className="absolute inset-0 size-4 rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
                    </div>
                    {t("userMenu.darkMode")}
                  </span>
                  <Switch checked={theme === "dark"} onCheckedChange={(c) => setTheme(c ? "dark" : "light")} />
                </div>
              </MenuButton>

              <Separator />

              {/* 语言切换 */}
              <MenuButton icon={Globe} onClick={() => setLocale(locale === "zh" ? "en" : "zh")}>
                <div>{t("userMenu.language")}</div>
                <div className="text-[11px] text-muted-foreground">{locale === "zh" ? "中文" : "English"}</div>
              </MenuButton>

              <Separator />

              {/* 设置 */}
              <MenuButton icon={Settings} onClick={() => { setOpen(false); navigate("/settings"); }}>
                {t("userMenu.settings")}
              </MenuButton>

              <Separator />

              {/* 登出（占位，待实现） */}
              <MenuButton icon={LogOut} disabled>
                <div>{t("userMenu.logout")}</div>
                <div className="text-[11px] text-muted-foreground">{t("userMenu.logoutHint")}</div>
              </MenuButton>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

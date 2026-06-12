import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { CircleUser, Sun, Moon, Globe, LogOut, Settings } from "lucide-react";
import { useTheme } from "@/lib/theme";
import { useLocale, useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/** 菜单内可聚焦的元素选择器（排除 disabled 项） */
const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled])';

export function UserMenu() {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const { theme, setTheme } = useTheme();
  const { locale, setLocale } = useLocale();
  const t = useT();
  const navigate = useNavigate();
  const prevOpenRef = useRef(open);
  /** 菜单容器引用，用于焦点管理和键盘导航 */
  const menuRef = useRef<HTMLDivElement>(null);
  /** 打开前焦点元素，关闭时恢复 */
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      setClosing(false);
      // 保存当前焦点
      previousFocusRef.current = document.activeElement as HTMLElement;
    } else if (prevOpenRef.current && !open) {
      setClosing(true);
    }
    prevOpenRef.current = open;
  }, [open]);

  // ESC 关闭 + 打开时自动聚焦第一个菜单项
  useEffect(() => {
    if (!open && !closing) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handleEscape);

    // 打开时聚焦第一个可用菜单项
    if (open && menuRef.current) {
      requestAnimationFrame(() => {
        if (!menuRef.current) return;
        const first = menuRef.current.querySelector<HTMLElement>(MENU_ITEM_SELECTOR);
        first?.focus();
      });
    }

    return () => document.removeEventListener("keydown", handleEscape);
  }, [open, closing]);

  /** 关闭动画结束后恢复焦点到触发按钮 */
  const handleAnimationEnd = useCallback(() => {
    if (closing) {
      setClosing(false);
      if (previousFocusRef.current) {
        previousFocusRef.current.focus();
        previousFocusRef.current = null;
      }
    }
  }, [closing]);

  /**
   * 键盘导航处理：
   * - 方向键在菜单项间循环移动焦点
   * - Home/End 定位首尾
   * - Tab 关闭菜单（恢复自然 Tab 流）
   */
  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!menuRef.current) return;
    const items = Array.from(menuRef.current.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR));
    if (items.length === 0) return;

    const currentIdx = items.indexOf(document.activeElement as HTMLElement);

    switch (e.key) {
      case "ArrowDown":
      case "ArrowRight":
        e.preventDefault();
        items[(currentIdx + 1) % items.length].focus();
        break;
      case "ArrowUp":
      case "ArrowLeft":
        e.preventDefault();
        items[(currentIdx - 1 + items.length) % items.length].focus();
        break;
      case "Home":
        e.preventDefault();
        items[0].focus();
        break;
      case "End":
        e.preventDefault();
        items[items.length - 1].focus();
        break;
      case "Tab":
        // Tab 关闭菜单，让浏览器恢复自然 Tab 流
        e.preventDefault();
        setOpen(false);
        break;
    }
  }, []);

  const isVisible = open || closing;
  const isExiting = closing && !open;

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(!open)}
        className="size-11 md:size-9 active:scale-90 transition-transform"
        aria-label={t("userMenu.openMenu")}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <CircleUser className="size-5 md:size-4" />
      </Button>

      {isVisible && (
        <>
          {/* 遮罩层 */}
          <div className="fixed inset-0 z-50" onClick={() => { if (!isExiting) setOpen(false); }} aria-hidden="true" />

          {/* 下拉菜单 */}
          <div
            ref={menuRef}
            role="menu"
            aria-label={t("userMenu.openMenu")}
            className={cn(
              "absolute right-0 top-full mt-1 w-52 z-50 rounded-lg border border-border bg-background shadow-lg",
              isExiting ? "animate-dropdown-out" : "animate-fade-in"
            )}
            onAnimationEnd={handleAnimationEnd}
            onKeyDown={handleMenuKeyDown}
          >
            <div className="py-1">
              {/* 深色模式切换 */}
              <button type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                className="w-full flex items-center gap-3 px-3 py-2.5 md:py-2 text-sm text-left min-h-[44px] md:min-h-0 hover:bg-accent focus:bg-accent active:bg-accent transition-colors outline-none"
              >
                <div className="relative size-4 shrink-0">
                  <Sun className="size-4 absolute inset-0 rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0" />
                  <Moon className="size-4 absolute inset-0 rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
                </div>
                <span className="flex-1">{t("userMenu.darkMode")}</span>
                <Switch checked={theme === "dark"} onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")} />
              </button>

              <Separator />

              {/* 语言切换 */}
              <button type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
                className="w-full flex items-center gap-3 px-3 py-2.5 md:py-2 text-sm text-left min-h-[44px] md:min-h-0 hover:bg-accent focus:bg-accent active:bg-accent transition-colors outline-none"
              >
                <Globe className="size-4 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div>{t("userMenu.language")}</div>
                  <div className="text-[11px] text-muted-foreground">{locale === "zh" ? "中文" : "English"}</div>
                </div>
              </button>

              <Separator />

              {/* 设置 */}
              <button type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => { setOpen(false); navigate("/settings"); }}
                className="w-full flex items-center gap-3 px-3 py-2.5 md:py-2 text-sm text-left min-h-[44px] md:min-h-0 hover:bg-accent focus:bg-accent active:bg-accent transition-colors outline-none"
              >
                <Settings className="size-4 shrink-0" />
                <span className="flex-1">{t("userMenu.settings")}</span>
              </button>

              <Separator />

              {/* 登出（占位） */}
              <button type="button"
                role="menuitem"
                tabIndex={-1}
                disabled
                className="w-full flex items-center gap-3 px-3 py-2.5 md:py-2 text-sm text-left min-h-[44px] md:min-h-0 opacity-50 cursor-not-allowed"
              >
                <LogOut className="size-4 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div>{t("userMenu.logout")}</div>
                  <div className="text-[11px] text-muted-foreground">{t("userMenu.logoutHint")}</div>
                </div>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

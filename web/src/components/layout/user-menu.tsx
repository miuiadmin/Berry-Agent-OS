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

/** 菜单内可聚焦元素选择器（用于键盘导航收集 + 打开时自动聚焦首项） */
const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled])';

/** 菜单项通用 className（移动端 44px 触控 / 桌面端紧凑） */
const ITEM_BASE = "w-full flex items-center gap-3 px-3 py-2.5 md:py-2 text-sm text-left min-h-[44px] md:min-h-0 hover:bg-accent focus:bg-accent active:bg-accent transition-colors outline-none";

/**
 * 键盘导航按键 → 动作映射。
 *   - 数字 1/-1：焦点前进/后退一格（循环）
 *   - "first"/"last"：跳到首/尾菜单项
 *   - "close"：关闭菜单（Tab 键，浏览器默认行为被 preventDefault 后手动关）
 */
const NAV_KEYS: Record<string, number | "first" | "last" | "close"> = {
  ArrowDown: 1, ArrowRight: 1,
  ArrowUp: -1, ArrowLeft: -1,
  Home: "first", End: "last", Tab: "close",
};

/** Lucide 图标组件的最小契约（只需要 className prop） */
type IconType = React.ComponentType<{ className?: string }>;

/** 统一菜单项：图标 + 内容 + 可选右侧区域 */
function MenuButton({
  icon: Icon,
  children,
  onClick,
  disabled,
}: {
  icon: IconType;
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
  /** 菜单是否打开（控制下拉显示） */
  const [open, setOpen] = useState(false);
  /** 关闭动画进行中（动画完成后才真正卸载 DOM，避免跳变） */
  const [closing, setClosing] = useState(false);
  const { theme, setTheme } = useTheme();
  const { locale, setLocale } = useLocale();
  const t = useT();
  const navigate = useNavigate();
  /** 上一帧的 open 状态，用于检测 open→close 的下降沿以触发关闭动画 */
  const prevOpenRef = useRef(open);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 打开前的焦点元素，关闭时恢复焦点（无障碍） */
  const previousFocusRef = useRef<HTMLElement | null>(null);

  /**
   * 关闭动画结束：恢复打开前的焦点。
   *
   * 仅当 saved focus 仍挂在 document 上时才 .focus()——若打开菜单期间触发按钮已卸载
   * 或焦点移出文档（如跳到 iframe/DevTools），ref 指向的是已脱离文档的节点，
   * 此时不强行 .focus()（会静默 no-op），改为让浏览器自然保留当前焦点。
   */
  const handleAnimationEnd = useCallback(() => {
    if (!closing) return;
    setClosing(false);
    const saved = previousFocusRef.current;
    if (saved && document.contains(saved)) saved.focus();
    previousFocusRef.current = null;
  }, [closing]);

  /**
   * 打开/关闭状态跟踪：
   *   - open 上升沿：清 closing 标记、保存当前焦点
   *   - open 下降沿：置 closing=true，进入关闭动画期
   */
  useEffect(() => {
    if (open) {
      setClosing(false);
      previousFocusRef.current = document.activeElement as HTMLElement;
    } else if (prevOpenRef.current) {
      setClosing(true);
    }
    prevOpenRef.current = open;
  }, [open]);

  /** ESC 关闭 + 打开时聚焦第一个菜单项（动画期也保留 ESC 监听） */
  useEffect(() => {
    if (!open && !closing) return;
    const onEscape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onEscape);
    if (open && menuRef.current) {
      // RAF 后 DOM 已渲染，再聚焦避免焦点丢失
      requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR)?.focus());
    }
    return () => document.removeEventListener("keydown", onEscape);
  }, [open, closing]);

  /**
   * 键盘导航：方向键循环 / Home/End / Tab 关闭（基于 NAV_KEYS 配置表）。
   *
   * Tab 被映射为 "close"：菜单内放弃原生 Tab-穿菜单项导航，改为方向键 roving-tabindex，
   * Tab 直接关闭菜单并把焦点交还文档流。这是有意为之的无障碍取舍——本菜单是临时浮层，
   * Tab 退出比 Tab 在 menuitem 间循环更符合"浮层应能被快速 ESC/Tab 退出"的用户预期。
   */
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

  /** 菜单可见 = 打开中 or 关闭动画期 */
  const isVisible = open || closing;
  /** 正在退出 = 关闭动画期（退出期间遮罩点击不重复触发关闭，避免抖动） */
  const isExiting = closing && !open;
  const close = useCallback(() => { if (!isExiting) setOpen(false); }, [isExiting]);

  return (
    <div className="relative">
      <Button
        variant="ghost" size="icon"
        onClick={() => setOpen((v) => !v)}
        className="size-11 transition-transform active:scale-90 md:size-9"
        aria-label={t("userMenu.openMenu")}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <CircleUser className="size-5 md:size-4" />
      </Button>

      {isVisible && (
        <>
          {/* 全屏遮罩：点击关闭（z-50 与菜单同层，菜单在 DOM 上后出现故遮盖上层点击） */}
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
              {/* 深色模式切换：Switch 为唯一触发器（整行可点触发 Switch，但不再叠加 onClick） */}
              <MenuButton icon={Sun} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-3">
                    {/* 日月图标交叉淡入：light 显日，dark 显月 */}
                    <div className="relative size-4">
                      <Sun className="absolute inset-0 size-4 rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0" />
                      <Moon className="absolute inset-0 size-4 rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
                    </div>
                    {t("userMenu.darkMode")}
                  </span>
                  {/*
                   * Switch 仅作只读指示器（checked 反映当前主题），不再挂 onCheckedChange。
                   * 之前 MenuButton.onClick 与 Switch.onCheckedChange 双触发，点击重叠命中区会
                   * 因闭包旧值与新值竞争而 net 到 no-op 或意外翻转。现在整行统一走 onClick 切换。
                   */}
                  <Switch checked={theme === "dark"} aria-hidden="true" tabIndex={-1} />
                </div>
              </MenuButton>

              <Separator />

              {/* 语言切换：副标题显示当前语言的可读名 */}
              <MenuButton icon={Globe} onClick={() => setLocale(locale === "zh" ? "en" : "zh")}>
                <div>{t("userMenu.language")}</div>
                <div className="text-[11px] text-muted-foreground">{locale === "zh" ? "中文" : "English"}</div>
              </MenuButton>

              <Separator />

              {/* 设置：关闭菜单后路由跳转 */}
              <MenuButton icon={Settings} onClick={() => { setOpen(false); navigate("/settings"); }}>
                {t("userMenu.settings")}
              </MenuButton>

              <Separator />

              {/* 登出（占位，待后端实现） */}
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

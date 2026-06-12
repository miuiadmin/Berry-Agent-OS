/**
 * 用户菜单 — 基于 HeroUI Dropdown 实现的下拉菜单。
 *
 * 替代原 209 行手写下拉（焦点管理 / 键盘导航 / 外部点击关闭），
 * 全部交由 HeroUI Dropdown compound 原生处理。
 *
 * 菜单项：
 * - 暗色模式切换（整行可点 + Switch 反映状态）
 * - 语言切换（zh / en）
 * - 设置（跳转 /settings）
 * - 登出（占位，禁用）
 */
import { useNavigate } from "react-router-dom";
import { CircleUser, Sun, Moon, Globe, LogOut, Settings } from "lucide-react";
import { useTheme } from "@/lib/theme";
import { useLocale, useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Dropdown,
  DropdownMenu,
  DropdownItem,
} from "@/components/ui/dropdown";

export function UserMenu() {
  const { theme, setTheme } = useTheme();
  const { locale, setLocale } = useLocale();
  const t = useT();
  const navigate = useNavigate();

  /** 行样式：移动端 44px 触控目标，hover/focus 高亮 */
  const rowClass =
    "flex items-center gap-3 px-3 py-2.5 md:py-2 text-sm w-full min-h-[44px] md:min-h-0 hover:bg-accent focus:bg-accent active:bg-accent transition-colors outline-none cursor-pointer";

  return (
    <Dropdown
      trigger={
        <Button
          variant="ghost"
          size="icon"
          className="size-11 md:size-9 active:scale-90 transition-transform"
          aria-label={t("userMenu.openMenu")}
        >
          <CircleUser className="size-5 md:size-4" />
        </Button>
      }
    >
      <DropdownMenu className="py-1 min-w-[200px]" aria-label={t("userMenu.openMenu")}>
        {/* 暗色模式切换：整行可点击，Switch 仅反映当前状态 */}
        <DropdownItem textValue={t("userMenu.darkMode")} onPress={() => setTheme(theme === "dark" ? "light" : "dark")}>
          <div className={rowClass}>
            <div className="relative size-4 shrink-0">
              <Sun className="size-4 absolute inset-0 rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0" />
              <Moon className="size-4 absolute inset-0 rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
            </div>
            <span className="flex-1">{t("userMenu.darkMode")}</span>
            {/* Switch 仅作状态显示（pointer-events-none），实际切换由整行 onPress 处理，
                避免点击 Switch 时与行 onPress 双重触发 */}
            <Switch
              checked={theme === "dark"}
              onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
              className="pointer-events-none"
            />
          </div>
        </DropdownItem>

        <Separator />

        {/* 语言切换 */}
        <DropdownItem textValue={t("userMenu.language")} onPress={() => setLocale(locale === "zh" ? "en" : "zh")}>
          <div className={rowClass}>
            <Globe className="size-4 shrink-0" />
            <div className="flex-1 min-w-0">
              <div>{t("userMenu.language")}</div>
              <div className="text-[11px] text-muted-foreground">{locale === "zh" ? "中文" : "English"}</div>
            </div>
          </div>
        </DropdownItem>

        <Separator />

        {/* 设置 */}
        <DropdownItem textValue={t("userMenu.settings")} onPress={() => navigate("/settings")}>
          <div className={rowClass}>
            <Settings className="size-4 shrink-0" />
            <span className="flex-1">{t("userMenu.settings")}</span>
          </div>
        </DropdownItem>

        <Separator />

        {/* 登出（占位，禁用） */}
        <DropdownItem isDisabled>
          <div className="flex items-center gap-3 px-3 py-2.5 md:py-2 text-sm w-full min-h-[44px] md:min-h-0 opacity-50 cursor-not-allowed">
            <LogOut className="size-4 shrink-0" />
            <div className="flex-1 min-w-0">
              <div>{t("userMenu.logout")}</div>
              <div className="text-[11px] text-muted-foreground">{t("userMenu.logoutHint")}</div>
            </div>
          </div>
        </DropdownItem>
      </DropdownMenu>
    </Dropdown>
  );
}

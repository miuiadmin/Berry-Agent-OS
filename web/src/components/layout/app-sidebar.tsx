/**
 * 应用侧边栏导航。
 *
 * 展示所有页面导航链接（图标 + 文字），当前路由高亮。
 * 移动端：overlay 抽屉（w-72），桌面端：常驻（w-56）。
 * 使用 sidebar-* 主题 token，与主内容区视觉分离。
 */

import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  MessageCircle,
  Bot,
  ListTodo,
  MessagesSquare,
  BarChart3,
  ScrollText,
  Brain,
  Bell,
  Shield,
  Target,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { Separator } from "@/components/ui/separator";
import { StrawberryLogo } from "@/components/ui/strawberry-logo";

/** 导航项类型：href 用于路由匹配，labelKey 用于 i18n，icon 为 Lucide 图标 */
type NavItem = { href: string; labelKey: string; icon: typeof LayoutDashboard };

/** 导航项定义（顺序即侧边栏顺序，label 用 i18n key） */
const navItems: NavItem[] = [
  { href: "/", labelKey: "sidebar.home", icon: LayoutDashboard },
  { href: "/chat", labelKey: "sidebar.chat", icon: MessageCircle },
  { href: "/agents", labelKey: "sidebar.agents", icon: Bot },
  { href: "/tasks", labelKey: "sidebar.tasks", icon: ListTodo },
  { href: "/memory", labelKey: "sidebar.memory", icon: Brain },
  { href: "/notifications", labelKey: "sidebar.notifications", icon: Bell },
  { href: "/conversations", labelKey: "sidebar.conversations", icon: MessagesSquare },
  { href: "/usage", labelKey: "sidebar.usage", icon: BarChart3 },
  { href: "/drift", labelKey: "sidebar.drift", icon: Shield },
  { href: "/missions", labelKey: "sidebar.missions", icon: Target },
  { href: "/logs", labelKey: "sidebar.logs", icon: ScrollText },
];

interface AppSidebarProps {
  /** 点击任一导航项后回调（移动端用于关闭抽屉） */
  onNavigate?: () => void;
}

/**
 * 判定当前导航项是否激活：
 *   - 根路径精确匹配（避免所有页面都高亮 Home）
 *   - 其余路径前缀匹配（子路由同样高亮父项）
 */
function isActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function AppSidebar({ onNavigate }: AppSidebarProps) {
  const pathname = useLocation().pathname;
  const t = useT();

  return (
    <aside className="flex h-full w-72 md:w-56 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex h-12 items-center gap-2 px-4 pt-[env(safe-area-inset-top,0px)] md:pt-0">
        <StrawberryLogo />
        <span className="text-sm font-semibold text-sidebar-foreground">{t("brand.name")}</span>
      </div>
      <Separator />
      <nav className="flex-1 space-y-1 p-2">
        {navItems.map((item) => {
          const active = isActive(item.href, pathname);
          return (
            <Link
              key={item.href}
              to={item.href}
              onClick={onNavigate}
              className={cn(
                // 移动端 44px 触控目标；激活态用主题 accent，非激活态仅 hover/focus 染色
                "group flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition-all min-h-[44px] md:min-h-0 md:py-2",
                active
                  ? "nav-link-active bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent",
              )}
            >
              <item.icon className={cn("size-4 transition-transform duration-200", active ? "scale-110" : "group-hover:scale-110")} />
              {t(item.labelKey)}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

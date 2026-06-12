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
  Clock,
  Shield,
  Target,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { Separator } from "@/components/ui/separator";
import { StrawberryLogo } from "@/components/brand/strawberry-logo";

/** 导航项定义（label 用 i18n key） */
const navItems = [
  { href: "/", labelKey: "sidebar.home", icon: LayoutDashboard },
  { href: "/chat", labelKey: "sidebar.chat", icon: MessageCircle },
  { href: "/agents", labelKey: "sidebar.agents", icon: Bot },
  { href: "/tasks", labelKey: "sidebar.tasks", icon: ListTodo },
  { href: "/memory", labelKey: "sidebar.memory", icon: Brain },
  { href: "/notifications", labelKey: "sidebar.notifications", icon: Bell },
  { href: "/scheduler", labelKey: "sidebar.scheduler", icon: Clock },
  { href: "/conversations", labelKey: "sidebar.conversations", icon: MessagesSquare },
  { href: "/usage", labelKey: "sidebar.usage", icon: BarChart3 },
  { href: "/drift", labelKey: "sidebar.drift", icon: Shield },
  { href: "/missions", labelKey: "sidebar.missions", icon: Target },
  { href: "/logs", labelKey: "sidebar.logs", icon: ScrollText },
];

interface AppSidebarProps {
  onNavigate?: () => void;
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
          const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              to={item.href}
              onClick={onNavigate}
              className={cn(
                "group flex items-center gap-2 rounded-lg px-3 py-2.5 md:py-2 text-sm transition-all min-h-[44px] md:min-h-0",
                isActive
                  ? "nav-link-active bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent"
              )}
            >
              <item.icon className={cn("size-4 transition-transform duration-200", isActive ? "scale-110" : "group-hover:scale-110")} />
              {t(item.labelKey)}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

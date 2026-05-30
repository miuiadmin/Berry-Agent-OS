import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  MessageCircle,
  Bot,
  ListTodo,
  MessagesSquare,
  BarChart3,
  Settings,
  Moon,
  Sun,
} from "lucide-react";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { StrawberryLogo } from "@/components/ui/strawberry-logo";

const navItems = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/chat", label: "Chat", icon: MessageCircle },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
  { href: "/conversations", label: "Conversations", icon: MessagesSquare },
  { href: "/usage", label: "Usage", icon: BarChart3 },
];

interface AppSidebarProps {
  onNavigate?: () => void;
}

export function AppSidebar({ onNavigate }: AppSidebarProps) {
  const pathname = useLocation().pathname;
  const { theme, setTheme } = useTheme();

  return (
    <aside className="flex h-full w-56 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex h-12 items-center gap-2 px-4">
        <StrawberryLogo />
        <span className="text-sm font-semibold text-sidebar-foreground">Berry</span>
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
                "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <Separator />
      <div className="p-2 space-y-1">
        <Link
          to="/settings"
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
            pathname.startsWith("/settings")
              ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
              : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          )}
        >
          <Settings className="size-4" />
          Settings
        </Link>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-sidebar-foreground/70"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          <Sun className="size-4 rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute size-4 rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
          <span className="ml-5">Toggle theme</span>
        </Button>
      </div>
    </aside>
  );
}

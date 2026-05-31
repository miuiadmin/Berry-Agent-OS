import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  MessageCircle,
  Bot,
  ListTodo,
  MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/chat", label: "Chat", icon: MessageCircle },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
  { href: "/agents", label: "Agents", icon: Bot },
];

interface MobileBottomNavProps {
  onMore?: () => void;
}

export function MobileBottomNav({ onMore }: MobileBottomNavProps) {
  const pathname = useLocation().pathname;

  return (
    <nav className="fixed bottom-0 inset-x-0 z-30 flex items-center justify-around border-t bg-background/95 backdrop-blur-sm pb-[env(safe-area-inset-bottom,0px)] md:hidden">
      {navItems.map((item) => {
        const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            to={item.href}
            className={cn(
              "flex flex-col items-center gap-0.5 px-3 py-2 min-w-[44px] min-h-[44px] justify-center transition-colors",
              isActive ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <item.icon className="size-5" />
            <span className="text-[10px] leading-tight">{item.label}</span>
          </Link>
        );
      })}
      <button
        onClick={onMore}
        className="flex flex-col items-center gap-0.5 px-3 py-2 min-w-[44px] min-h-[44px] justify-center text-muted-foreground transition-colors"
      >
        <MoreHorizontal className="size-5" />
        <span className="text-[10px] leading-tight">More</span>
      </button>
    </nav>
  );
}

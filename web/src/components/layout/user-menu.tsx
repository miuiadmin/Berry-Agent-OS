import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { CircleUser, Sun, Moon, Globe, LogOut, Settings } from "lucide-react";
import { useTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";

export function UserMenu() {
  const [open, setOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open]);

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(!open)}
        className="size-11 md:size-9 active:scale-90 transition-transform"
        aria-label="User menu"
      >
        <CircleUser className="size-5 md:size-4" />
      </Button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} />

          {/* Dropdown anchored to avatar */}
          <div
            role="menu"
            aria-label="User menu"
            className="absolute right-0 top-full mt-1 w-52 z-50 rounded-lg border border-border bg-background shadow-lg animate-fade-in"
          >
            <div className="py-1">
              {/* Dark mode toggle */}
              <button
                role="menuitem"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                className="w-full flex items-center gap-3 px-3 py-2.5 md:py-2 text-sm text-left min-h-[44px] md:min-h-0 hover:bg-accent active:bg-accent transition-colors"
              >
                <div className="relative size-4 shrink-0">
                  <Sun className="size-4 absolute inset-0 rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0" />
                  <Moon className="size-4 absolute inset-0 rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
                </div>
                <span className="flex-1">深色模式</span>
                <Switch checked={theme === "dark"} onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")} />
              </button>

              <Separator />

              {/* Language (placeholder) */}
              <button
                role="menuitem"
                disabled
                className="w-full flex items-center gap-3 px-3 py-2.5 md:py-2 text-sm text-left min-h-[44px] md:min-h-0 opacity-50 cursor-not-allowed"
              >
                <Globe className="size-4 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div>Language</div>
                  <div className="text-[11px] text-muted-foreground">Coming soon</div>
                </div>
              </button>

              <Separator />

              {/* Settings */}
              <button
                role="menuitem"
                onClick={() => { setOpen(false); navigate("/settings"); }}
                className="w-full flex items-center gap-3 px-3 py-2.5 md:py-2 text-sm text-left min-h-[44px] md:min-h-0 hover:bg-accent active:bg-accent transition-colors"
              >
                <Settings className="size-4 shrink-0" />
                <span className="flex-1">系统设置</span>
              </button>

              <Separator />

              {/* Logout (placeholder) */}
              <button
                role="menuitem"
                disabled
                className="w-full flex items-center gap-3 px-3 py-2.5 md:py-2 text-sm text-left min-h-[44px] md:min-h-0 opacity-50 cursor-not-allowed"
              >
                <LogOut className="size-4 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div>退出登录</div>
                  <div className="text-[11px] text-muted-foreground">暂未配置</div>
                </div>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

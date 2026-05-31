import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { AppSidebar } from "./app-sidebar";
import { Button } from "@/components/ui/button";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";

export function DashboardLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  // Close sidebar on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [mobileOpen]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 animate-overlay-in md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar - hidden on mobile, shown as overlay when toggled */}
      <div className={`
        fixed inset-y-0 left-0 z-50 w-72 transform transition-transform duration-200 ease-in-out md:relative md:w-56 md:translate-x-0 md:shrink-0
        ${mobileOpen ? "translate-x-0" : "-translate-x-full"}
      `}>
        <AppSidebar onNavigate={() => setMobileOpen(false)} />
      </div>

      {/* Main content */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Mobile header */}
        <div className="flex h-12 items-center gap-2 border-b px-4 pt-[env(safe-area-inset-top,0px)] md:hidden">
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen(!mobileOpen)} className="active:scale-90 transition-transform">
            <div className="relative size-5">
              <Menu className={cn("size-5 absolute inset-0 transition-all duration-200", mobileOpen ? "rotate-90 opacity-0 scale-75" : "rotate-0 opacity-100 scale-100")} />
              <X className={cn("size-5 absolute inset-0 transition-all duration-200", mobileOpen ? "rotate-0 opacity-100 scale-100" : "-rotate-90 opacity-0 scale-75")} />
            </div>
          </Button>
          <span className="text-sm font-semibold">Berry</span>
        </div>
        <main className="relative flex-1">
          {/* key by pathname to re-trigger animation on route change */}
          <div key={location.pathname} className="animate-page-in absolute inset-0 overflow-y-auto">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

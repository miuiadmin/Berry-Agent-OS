import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { AppSidebar } from "./app-sidebar";
import { Button } from "@/components/ui/button";
import { Menu, X } from "lucide-react";

export function DashboardLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);

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
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar - hidden on mobile, shown as overlay when toggled */}
      <div className={`
        fixed inset-y-0 left-0 z-50 transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0
        ${mobileOpen ? "translate-x-0" : "-translate-x-full"}
      `}>
        <AppSidebar onNavigate={() => setMobileOpen(false)} />
      </div>

      {/* Main content */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Mobile header */}
        <div className="flex h-12 items-center gap-2 border-b px-4 md:hidden">
          <Button variant="ghost" size="icon-sm" onClick={() => setMobileOpen(!mobileOpen)}>
            {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
          </Button>
          <div className="size-5 rounded-md bg-brand" />
          <span className="text-sm font-semibold">Berry</span>
        </div>
        <main className="flex-1 overflow-auto"><Outlet /></main>
      </div>
    </div>
  );
}

/**
 * 应用根布局 — 侧边栏 + 主内容区。
 *
 * 职责：
 *   - 全局 WebSocket 连接管理（进入时连接，离开时断开）
 *   - 移动端侧边栏 overlay（路由切换 / ESC 自动关闭）
 *   - 桌面端右上角浮动工具栏（连接状态 + debug + 用户菜单）
 *   - 页面切换动画（key by pathname 触发 animate-page-in）
 */

import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { AppSidebar } from "./app-sidebar";
import { Button } from "@/components/ui/button";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DebugCaptureButton } from "@/components/debug/debug-capture-button";
import { DebugCaptureDialog } from "@/components/debug/debug-capture-dialog";
import { UserMenu } from "./user-menu";
import { ConnectionStatus } from "@/components/ui/connection-status";
import { useWsStore } from "@/lib/stores/ws-store";
import { useT } from "@/lib/i18n";

/** 右上角工具栏（ConnectionStatus + Debug + UserMenu，移动/桌面复用） */
function Toolbar() {
  return (
    <>
      <ConnectionStatus />
      <DebugCaptureButton />
      <UserMenu />
    </>
  );
}

export function DashboardLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const connect = useWsStore((s) => s.connect);
  const disconnect = useWsStore((s) => s.disconnect);
  const t = useT();

  /** 全局 WebSocket：进入连接，离开断开 */
  useEffect(() => {
    connect();
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 路由切换时关闭移动端侧边栏 */
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  /** ESC 关闭移动端侧边栏 */
  useEffect(() => {
    if (!mobileOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileOpen(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [mobileOpen]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* 移动端遮罩层 */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 animate-overlay-in md:hidden"
          onClick={() => setMobileOpen(false)} aria-hidden="true" />
      )}

      {/* 侧边栏：移动端 overlay 抽屉，桌面端常驻 */}
      <div className={cn(
        "fixed inset-y-0 left-0 z-50 w-72 transform transition-transform duration-200 ease-in-out md:relative md:w-56 md:translate-x-0 md:shrink-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
      )}>
        <AppSidebar onNavigate={() => setMobileOpen(false)} />
      </div>

      {/* 主内容区 */}
      <div className="flex min-w-0 flex-1 flex-col" aria-hidden={mobileOpen || undefined}>
        {/* 移动端顶栏 */}
        <div className="flex h-12 items-center gap-2 border-b px-4 pt-[env(safe-area-inset-top,0px)] md:hidden">
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen(!mobileOpen)}
            className="size-11 transition-transform active:scale-90 md:size-auto"
            aria-label={mobileOpen ? t("userMenu.closeMenu") : t("userMenu.openMenu")}>
            <div className="relative size-5">
              <Menu className={cn("absolute inset-0 size-5 transition-all duration-200", mobileOpen ? "rotate-90 scale-75 opacity-0" : "rotate-0 scale-100 opacity-100")} />
              <X className={cn("absolute inset-0 size-5 transition-all duration-200", mobileOpen ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-75 opacity-0")} />
            </div>
          </Button>
          <span className="text-sm font-semibold">{t("brand.name")}</span>
          <div className="ml-auto flex items-center gap-2"><Toolbar /></div>
        </div>

        {/* 桌面端右上角浮层 */}
        <div className="fixed top-[calc(1rem+env(safe-area-inset-top,0px))] right-[calc(1rem+env(safe-area-inset-right,0px))] z-40 hidden items-center gap-2 md:flex">
          <Toolbar />
        </div>

        <main id="main-content" className="relative flex-1">
          <div key={location.pathname} className="animate-page-in absolute inset-0 overflow-y-auto">
            <Outlet />
          </div>
        </main>
      </div>

      <DebugCaptureDialog />
    </div>
  );
}

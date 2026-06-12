import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { AppSidebar } from "./app-sidebar";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DebugCaptureButton } from "@/components/debug/debug-capture-button";
import { DebugCaptureDialog } from "@/components/debug/debug-capture-dialog";
import { UserMenu } from "./user-menu";
import { ConnectionStatus } from "@/components/ui/connection-status";
import { useWsStore } from "@/lib/stores/ws-store";
import { useT } from "@/lib/i18n";

export function DashboardLayout() {
  /** 移动端抽屉开关（桌面端侧边栏常驻，不受此状态影响） */
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const connect = useWsStore((s) => s.connect);
  const disconnect = useWsStore((s) => s.disconnect);
  const t = useT();

  // 全局 WebSocket 连接：进入 DashboardLayout 就连接，离开就断开。
  // WS 使用持久化的 clientId 标识客户端，与对话 sessionId 完全解耦。
  useEffect(() => {
    connect();
    return () => { disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 路由切换时关闭移动端抽屉（HeroUI Drawer 的 ESC / 遮罩点击关闭由其原生处理）
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* 桌面端常驻侧边栏（移动端隐藏，由下方 Drawer 接管） */}
      <aside className="hidden md:block md:w-56 md:shrink-0">
        <AppSidebar />
      </aside>

      {/* 移动端抽屉侧边栏（HeroUI Drawer 原生处理遮罩/ESC/滑入动画/聚焦陷阱） */}
      <Drawer open={mobileOpen} onOpenChange={setMobileOpen} placement="left">
        <AppSidebar onNavigate={() => setMobileOpen(false)} />
      </Drawer>

      {/* 主内容区 */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* 移动端顶栏：hamburger + 标题 + 连接状态 + 用户菜单 */}
        <div className="flex h-12 items-center gap-2 border-b px-4 pt-[env(safe-area-inset-top,0px)] md:hidden">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileOpen(!mobileOpen)}
            className="size-11 md:size-auto active:scale-90 transition-transform"
            aria-label={mobileOpen ? t("userMenu.closeMenu") : t("userMenu.openMenu")}
          >
            <div className="relative size-5">
              <Menu className={cn("size-5 absolute inset-0 transition-all duration-200", mobileOpen ? "rotate-90 opacity-0 scale-75" : "rotate-0 opacity-100 scale-100")} />
              <X className={cn("size-5 absolute inset-0 transition-all duration-200", mobileOpen ? "rotate-0 opacity-100 scale-100" : "-rotate-90 opacity-0 scale-75")} />
            </div>
          </Button>
          <span className="text-sm font-semibold">{t("brand.name")}</span>
          <div className="ml-auto flex items-center gap-2">
            <ConnectionStatus />
            <DebugCaptureButton />
            <UserMenu />
          </div>
        </div>
        {/* 桌面端右上角：连接状态 + debug + 用户菜单 */}
        <div className="fixed top-[calc(1rem+env(safe-area-inset-top,0px))] right-[calc(1rem+env(safe-area-inset-right,0px))] z-40 hidden md:flex items-center gap-2">
          <ConnectionStatus />
          <DebugCaptureButton />
          <UserMenu />
        </div>
        <main id="main-content" className="relative flex-1">
          {/* key by pathname 切换路由时触发动画 */}
          <div key={location.pathname} className="animate-page-in absolute inset-0 overflow-y-auto">
            <Outlet />
          </div>
        </main>
      </div>

      <DebugCaptureDialog />
    </div>
  );
}

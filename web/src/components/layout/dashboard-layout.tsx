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
  /** 移动端侧边栏是否打开（桌面端常驻，与此无关） */
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const connect = useWsStore((s) => s.connect);
  const disconnect = useWsStore((s) => s.disconnect);
  const t = useT();

  /** 全局 WebSocket：进入连接，离开断开（仅 mount 一次） */
  useEffect(() => {
    connect();
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 路由切换 → 关闭移动端抽屉。
   *
   * 独立 effect（仅依赖 location.pathname）：每次路由变化都重置 mobileOpen=false，
   * 避免"切到新页面但抽屉还开着"的过期态。不依赖 mobileOpen 当前值，无需读到最新快照。
   */
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  /**
   * ESC 键 → 关闭移动端抽屉。
   *
   * 独立 effect（仅依赖 mobileOpen）：只有抽屉打开时才挂 keydown 监听，关闭即卸载。
   * 与上面的路由 effect 分离，避免二者闭包读到不同 state 快照导致监听器生命周期混乱。
   */
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* 移动端遮罩层（点击关闭抽屉） */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 animate-overlay-in bg-black/50 md:hidden"
          onClick={() => setMobileOpen(false)} aria-hidden="true" />
      )}

      {/* 侧边栏：移动端 overlay 抽屉，桌面端常驻 */}
      <div className={cn(
        "fixed inset-y-0 left-0 z-50 w-72 transform transition-transform duration-200 ease-in-out md:relative md:w-56 md:shrink-0 md:translate-x-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
      )}>
        <AppSidebar onNavigate={() => setMobileOpen(false)} />
      </div>

      {/* 主内容区：抽屉打开时整棵子树 aria-hidden（含移动端工具栏——它在抽屉打开时本就冗余） */}
      <div className="flex min-w-0 flex-1 flex-col" aria-hidden={mobileOpen || undefined}>
        {/* 移动端顶栏 */}
        <div className="flex h-12 items-center gap-2 border-b px-4 pt-[env(safe-area-inset-top,0px)] md:hidden">
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen((v) => !v)}
            className="size-11 transition-transform active:scale-90 md:size-auto"
            aria-label={mobileOpen ? t("userMenu.closeMenu") : t("userMenu.openMenu")}>
            {/* 汉堡 / 关闭双图标交叉淡入淡出，避免图标突变 */}
            <div className="relative size-5">
              <Menu className={cn("absolute inset-0 size-5 transition-all duration-200", mobileOpen ? "rotate-90 scale-75 opacity-0" : "rotate-0 scale-100 opacity-100")} />
              <X className={cn("absolute inset-0 size-5 transition-all duration-200", mobileOpen ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-75 opacity-0")} />
            </div>
          </Button>
          <span className="text-sm font-semibold">{t("brand.name")}</span>
          <div className="ml-auto flex items-center gap-2"><Toolbar /></div>
        </div>

        {/* 桌面端右上角浮层（连接状态 + debug + 用户菜单） */}
        <div className="fixed top-[calc(1rem+env(safe-area-inset-top,0px))] right-[calc(1rem+env(safe-area-inset-right,0px))] z-40 hidden items-center gap-2 md:flex">
          <Toolbar />
        </div>

        <main id="main-content" className="relative flex-1">
          {/*
           * key={location.pathname}：每次路由切换重挂滚动容器以重放 animate-page-in 入场动画。
           * 已知 UX 代价：重挂会销毁滚动位置与容器内状态（展开的折叠项、聚焦中的输入框等），
           * 浏览器后退/前进时无法恢复到原滚动高度。Dashboard 场景下此代价可接受——
           * 若未来出现需要保留滚动位置的页面，改为基于动画类名增删的非重挂触发方案。
           */}
          <div key={location.pathname} className="animate-page-in absolute inset-0 overflow-y-auto">
            <Outlet />
          </div>
        </main>
      </div>

      <DebugCaptureDialog />
    </div>
  );
}

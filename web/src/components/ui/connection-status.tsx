"use client";

import { useWsStore } from "@/lib/stores/ws-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * WebSocket 连接状态指示器。
 * - 移动端（< 768px）：只显示一个小圆点，不占空间
 * - 桌面端：圆点 + 文字标签（已连接 / 连接中… / 已断开）
 */
export function ConnectionStatus() {
  const status = useWsStore((s) => s.status);
  const t = useT();

  /** 根据 WebSocket 状态映射翻译 key */
  const statusLabel = status === "connected"
    ? t("connection.connected")
    : status === "connecting"
    ? t("connection.connecting")
    : t("connection.disconnected");

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {/* 状态圆点：移动端和桌面端都显示 */}
      <span
        className={cn(
          "size-2.5 rounded-full shrink-0 transition-colors md:size-2",
          status === "connected" && "bg-success animate-pulse-dot",
          status === "connecting" && "bg-warning animate-pulse",
          status === "disconnected" && "bg-destructive"
        )}
      />
      {/* 文字标签：仅桌面端显示，移动端隐藏以节省空间 */}
      <span key={status} className="animate-fade-in hidden md:inline text-[11px]">
        {statusLabel}
      </span>
    </div>
  );
}

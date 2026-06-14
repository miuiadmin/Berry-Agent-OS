/**
 * ConnectionStatus WebSocket 连接状态指示器。
 *
 * 从 ws-store 订阅实时连接状态，渲染圆点 + 文字标签。
 * - 移动端（< 768px）：只显示一个小圆点，不占空间
 * - 桌面端：圆点 + 文字标签（已连接 / 连接中… / 已断开）
 *
 * 三态色：connected=success 绿（脉冲点）/ connecting=warning 黄（脉冲）/ disconnected=destructive 红。
 */

"use client";

import { useWsStore } from "@/lib/stores/ws-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

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
    <div role="status" aria-live="polite" className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {/* 状态圆点：移动端和桌面端都显示（移动端 2.5 / 桌面端 2，色随状态） */}
      <span
        aria-label={statusLabel}
        className={cn(
          "size-2.5 rounded-full shrink-0 transition-colors md:size-2",
          status === "connected" && "bg-success animate-pulse-dot",
          status === "connecting" && "bg-warning animate-pulse",
          status === "disconnected" && "bg-destructive"
        )}
      />
      {/* 文字标签：仅桌面端显示，移动端隐藏以节省空间；key 触发切换时淡入 */}
      <span key={status} className="animate-fade-in hidden md:inline text-[11px]">
        {statusLabel}
      </span>
    </div>
  );
}

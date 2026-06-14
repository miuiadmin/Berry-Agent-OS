/**
 * ConnectionStatus WebSocket 连接状态指示器。
 *
 * 从 ws-store 订阅实时连接状态，渲染圆点 + 文字标签。
 * - 移动端（< 768px）：只显示一个小圆点，不占空间
 * - 桌面端：圆点 + 文字标签（已连接 / 连接中… / 已断开）
 *
 * 三态色：connected=success 绿（脉冲点）/ connecting=warning 黄（脉冲）/ disconnected=destructive 红。
 *
 * 结构性重构：把"状态 → 圆点 className / 翻译 key"两张映射从嵌套三元改成 Record，
 * 新增状态时只加一行，不再改三处条件分支。
 *
 * 类型对齐：WsStatus 直接从 ws-store 的 status 字段推导（StoreApi['getState']['status']），
 * 不再手写本地联合，避免 store 增加新状态时此处静默漂移导致 Record 运行时返回 undefined。
 */

"use client"

import { useWsStore } from "@/lib/stores/ws-store"
import { useT } from "@/lib/i18n"
import { cn } from "@/lib/utils"

/**
 * 从 ws-store 真实状态推导类型，而非手写本地联合。
 * 好处：store 未来若新增第 4 种状态，此处编译期就能感知；
 * 配合下面的 Record<WsStatus, ...> 完整性检查，新增状态会强制同步两份映射。
 */
type WsStoreState = ReturnType<typeof useWsStore.getState>
type WsStatus = WsStoreState["status"]

/**
 * 状态 → 圆点视觉映射。
 * - connected: 绿色 + 慢脉冲点（animate-pulse-dot 自定义关键帧，呼吸感）
 * - connecting: 黄色 + 标准脉冲
 * - disconnected: 红色，无动画（终态，不需要吸睛）
 */
const DOT_STYLE: Record<WsStatus, string> = {
  connected: "bg-success animate-pulse-dot",
  connecting: "bg-warning animate-pulse",
  disconnected: "bg-destructive",
}

/** 状态 → i18n key 映射（与 DOT_STYLE 一一对应，新增状态同步两处） */
const STATUS_I18N_KEY: Record<WsStatus, string> = {
  connected: "connection.connected",
  connecting: "connection.connecting",
  disconnected: "connection.disconnected",
}

export function ConnectionStatus() {
  // 不再用 `as WsStatus` 断言——status 类型由 store 直接推导，类型严格对齐。
  const status = useWsStore((s) => s.status)
  const t = useT()
  // 翻译 key 查表；Record 保证 status 取值穷尽，TS 缺一种会报错
  const statusLabel = t(STATUS_I18N_KEY[status])

  return (
    <div role="status" aria-live="polite" className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {/* 状态圆点：移动端和桌面端都显示（移动端 2.5 / 桌面端 2，色随状态） */}
      <span
        aria-label={statusLabel}
        className={cn(
          "size-2.5 rounded-full shrink-0 transition-colors md:size-2",
          DOT_STYLE[status]
        )}
      />
      {/* 文字标签：仅桌面端显示，移动端隐藏以节省空间；key 触发切换时淡入 */}
      <span key={status} className="animate-fade-in hidden md:inline text-[11px]">
        {statusLabel}
      </span>
    </div>
  )
}

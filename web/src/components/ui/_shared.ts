/**
 * UI 原语共享样式常量。
 *
 * 多个原语反复出现的同一段 Tailwind 类（聚焦环、aria-invalid 错误态、
 * 模态遮罩动画、弹层进场动画等）集中在此，避免 25 个文件各写一遍又漂移。
 *
 * 设计原则：
 * - 只放"被多个原语复用"的常量；单文件专用样式不进这里。
 * - 保持字符串拼接可读：用数组 + join，而不是一行几百字符的字符串。
 * - 不改变任何对外行为，仅是 className 字符串的单一事实源。
 */

/** 强制聚焦环：键盘导航时显示的 3px 描边 + 半透明环 */
export const FOCUS_RING =
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"

/** aria-invalid 错误态聚焦环：destructive 红色描边 + 红色半透明环（含 dark 变体） */
export const ARIA_INVALID_RING =
  "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"

/** 模态遮罩层：固定全屏、半透明黑底、可选背景模糊、进场/出场淡入淡出 */
export const MODAL_OVERLAY =
  "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"

/** 弹层进场/出场动画：淡入 + 缩放（对话框 / 警告框共用） */
export const POPUP_ANIMATION =
  "duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"

/** 弹层定位：固定居中、ring 描边、popover 背景色 */
export const POPUP_BASE =
  "fixed top-1/2 left-1/2 z-50 grid w-full -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-popover-foreground ring-1 ring-foreground/10 outline-none"

/**
 * 移动端触控目标最小尺寸（44×44px，Apple HIG 标准）。
 * 调用方加 `min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0` 即可：
 * 移动端撑到 44px，桌面端 (`md:`) 收回紧凑尺寸。
 */
export const TOUCH_TARGET =
  "min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0"

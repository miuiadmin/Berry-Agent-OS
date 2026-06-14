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

/**
 * stagger 入场动画序号上限（与 index.css 的 .stagger-1 ~ .stagger-8 一一对应）。
 * 超过 8 行后循环从 1 重新开始（CSS 只定义了 stagger-1~8）。
 */
export const STAGGER_MAX = 8

/**
 * 生成 stagger 入场动画的 className。
 *
 * 列表 / 卡片网格常用：每个元素按序号获得递增的入场延迟，形成从上到下
 * 依次淡入的视觉效果（index.css 的 .stagger-1~.stagger-8 定义了
 * 0.05s ~ 0.40s 的延迟阶梯）。
 *
 * 抽成函数：`stagger-${Math.min(i + 1, 8)}` 这段拼接在 TasksPage / AgentsPage /
 * ConversationsPage / UsagePage 等近 10 处重复，单一事实源避免拼写漂移。
 *
 * @param index 元素序号（0-based）
 * @returns 形如 "stagger-3" 的 className
 */
export function staggerClass(index: number): string {
  return `stagger-${Math.min(index + 1, STAGGER_MAX)}`
}

/**
 * 行内 code 样式（markdown 行内 `code` 和 code-block 的内联回退共用）。
 *
 * code-block.tsx 的行内 `<code>` 与 markdown-components.tsx 的 markdown `code`
 * 渲染用完全相同的 className，抽常量避免两处漂移（例如只改一处字号）。
 */
export const INLINE_CODE =
  "rounded bg-muted/80 px-1.5 py-0.5 text-[13px] font-mono text-foreground"

/**
 * 消息正文 markdown 容器样式（chat-message-list 主气泡 + block-renderers 文本 block 共用）。
 *
 * 重置 prose 默认对 pre/code 的样式（pre 由 CodeBlock 自带容器，code 走 INLINE_CODE），
 * 让 markdown 渲染与自定义代码组件视觉协调。两处 verbatim 重复，抽常量单一事实源。
 */
export const MARKDOWN_PROSE =
  "prose prose-sm dark:prose-invert max-w-none [&_pre]:my-0 [&_pre]:p-0 [&_pre]:bg-transparent [&_code]:text-xs"

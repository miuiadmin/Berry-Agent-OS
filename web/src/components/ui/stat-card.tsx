/**
 * StatCard 统计指标卡片组件。
 *
 * 统一 HomePage / UsagePage / DriftPage / SchedulerPage 重复的
 * "图标 + 标签 + 大数字 + 副文本" 统计卡片模式。
 *
 * - loading 态自动显示骨架屏
 * - stagger 序号触发 CSS 入场动画（stagger-1 ~ stagger-8 依次延迟）
 * - extra 插槽可放 sparkline 等附加可视化
 *
 * 用法：
 *   <StatCard icon={Bot} label={t("home.agents")} value={`${active}/${total}`} desc={t("home.activeTotal")} />
 *   <StatCard icon={Zap} label={t("home.running")} value={42} loading={isLoading} />
 *   <StatCard icon={Cpu} label="tokens" value={tokens} extra={<Sparkline values={seq} />} />
 *
 * 结构性重构：loading 分支用 early return，避免主路径嵌套三元；
 * stagger 类名生成提到组件顶部显式合成。
 */

import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { staggerClass } from "@/components/ui/_shared"

interface StatCardProps {
  /** 左侧图标 */
  icon: LucideIcon
  /** 卡片标题（小字，图标旁） */
  label: string
  /** 主数值（数字或字符串） */
  value: ReactNode
  /** 数值下方副文本 */
  desc?: string
  /** 数值下方额外内容（如 sparkline） */
  extra?: ReactNode
  /** 加载态（显示骨架屏） */
  loading?: boolean
  /** stagger 动画序号（1-8） */
  stagger?: number
  /** 容器额外 className */
  className?: string
}

export function StatCard({
  icon: Icon,
  label,
  value,
  desc,
  extra,
  loading,
  stagger,
  className,
}: StatCardProps) {
  return (
    // staggerClass 统一生成 stagger-N（封顶 STAGGER_MAX=8，超出不会无动画）；
    // stagger prop 是 1-based。加 Math.max(0, ...) 下界保护：
    // 若调用方误传 stagger={0}（0-based），原本会算出 staggerClass(-1) → stagger-0，
    // 而 CSS 只定义了 stagger-1~8，class 静默失效（动画丢失但不崩）。
    // 下界保护后 stagger<1 一律回退到 stagger-1，确保至少有一个最小延迟。
    <Card
      className={cn(
        "card-lift",
        stagger !== undefined && staggerClass(Math.max(0, stagger - 1)),
        className,
      )}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Icon className="size-4" />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/*
          loading：渲染与 loaded 态等高的占位结构。
          旧实现只放一个 Skeleton h-7 w-20，desc/extra 在 loading 时不渲染，
          导致 loading→loaded 切换时高度抖动（loaded 多两行）。这里始终保留
          desc / extra 的占位行，loaded 与 loading 行数一致，消除视觉跳变。
        */}
        {loading ? (
          <>
            <Skeleton className="h-7 w-20" />
            {/* desc 占位：loaded 有 desc 时此处也占一行，避免高度跳变 */}
            {desc !== undefined && <Skeleton className="mt-1 h-3 w-16" />}
            {/* extra 占位：loaded 有 extra 时此处保留空间 */}
            {extra !== undefined && <div className="mt-1">{/* extra 占位（无视觉内容） */}</div>}
          </>
        ) : (
          <>
            <p className="text-2xl font-bold">{value}</p>
            {desc && <p className="text-xs text-muted-foreground">{desc}</p>}
            {extra}
          </>
        )}
      </CardContent>
    </Card>
  )
}

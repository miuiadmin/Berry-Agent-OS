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
    <Card className={cn("card-lift", stagger && `stagger-${stagger}`, className)}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Icon className="size-4" />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* loading：骨架屏；否则数值 + 可选副文本 + 可选 extra */}
        {loading ? (
          <Skeleton className="h-7 w-20" />
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

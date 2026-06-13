/**
 * 首页图表数据构建（纯函数 + 小组件）。
 *
 * 从 HomePage.tsx 提取，让页面组件只负责数据查询和布局编排。
 * 所有函数无 React hook 依赖（除小组件外）。
 */

import { Link } from "react-router-dom";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

// ─── 纯函数 ────────────────────────────────────────────────────────

/**
 * 构建 7 天图表数据（完成 / 失败 + sparkline 数组）。
 *
 * 优先用 stats API 数据，否则从任务列表客户端聚合。
 *
 * @param statsData 服务端按天统计（可选）
 * @param completedTasks 已完成任务（聚合回退用）
 * @param failedTasks 失败任务（聚合回退用）
 * @param formatDate 日期格式化（i18n）
 */
export function buildChartData(
  statsData: { date: string; completed: number; failed: number }[] | undefined,
  completedTasks: { finishedAt?: string | number; createdAt: string | number }[],
  failedTasks: { finishedAt?: string | number; createdAt: string | number }[],
  formatDate: (d: Date, opts?: Intl.DateTimeFormatOptions) => string,
) {
  // 优先用服务端按天统计
  if (statsData && statsData.length > 0) {
    const completedByDay = statsData.map((d) => d.completed);
    const failedByDay = statsData.map((d) => d.failed);
    const labels = statsData.map((d) =>
      formatDate(new Date(d.date), { weekday: "short" }),
    );
    return {
      completed: labels.map((label, i) => ({ label, value: completedByDay[i] })),
      failed: labels.map((label, i) => ({ label, value: failedByDay[i] })),
      sparkCompleted: completedByDay,
      sparkFailed: failedByDay,
    };
  }

  // 回退：客户端按天聚合任务列表（最近 7 天）
  const days = 7;
  const now = new Date();
  const labels: string[] = [];
  const completedByDay: number[] = [];
  const failedByDay: number[] = [];

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    labels.push(formatDate(date, { weekday: "short" }));

    const dateStart = new Date(date.setHours(0, 0, 0, 0)).getTime();
    const dateEnd = dateStart + 86400000;

    /** 统计任务在某天的时间窗口内数量（按 finishedAt 优先，否则 createdAt） */
    const countInDay = (tasks: typeof completedTasks) =>
      tasks.filter((t) => {
        const ts = new Date(t.finishedAt ?? t.createdAt).getTime();
        return ts >= dateStart && ts < dateEnd;
      }).length;

    completedByDay.push(countInDay(completedTasks));
    failedByDay.push(countInDay(failedTasks));
  }

  return {
    completed: labels.map((label, i) => ({ label, value: completedByDay[i] })),
    failed: labels.map((label, i) => ({ label, value: failedByDay[i] })),
    sparkCompleted: completedByDay,
    sparkFailed: failedByDay,
  };
}

// ─── 小组件 ────────────────────────────────────────────────────────

/** 趋势指示器——上升/下降/持平 */
export function TrendIndicator({ current, previous }: { current: number; previous: number }) {
  if (previous === 0 && current === 0) return <Minus className="size-3 text-muted-foreground" />;
  if (current > previous) return <TrendingUp className="size-3 text-success" />;
  if (current < previous) return <TrendingDown className="size-3 text-destructive" />;
  return <Minus className="size-3 text-muted-foreground" />;
}

/** 快捷导航链接卡片 */
export function QuickLink({ href, icon: Icon, label }: { href: string; icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <Link
      to={href}
      className="group flex items-center gap-2 rounded-lg border px-3 py-3 md:py-2.5 text-sm card-lift hover:border-ring/30 active:scale-[0.97] transition-all duration-200"
    >
      <Icon className="size-4 text-muted-foreground transition-transform duration-200 group-hover:scale-110" />
      {label}
    </Link>
  );
}

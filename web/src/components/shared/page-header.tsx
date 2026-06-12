/**
 * 页面头部 — 统一各页面标题/副标题/操作按钮布局。
 *
 * 从 10+ 个页面中提取的共享组件，消除重复的 header 结构：
 *   <PageHeader title="..." subtitle="..." icon={...} action={...} />
 *
 * 移动端/桌面端自适应，图标和 action 按钮可选。
 */
import type { LucideIcon } from "lucide-react";

interface PageHeaderProps {
  /** 页面标题（支持字符串和 ReactNode，后者可嵌入 Badge 等行内元素） */
  title: React.ReactNode;
  /** 副标题/描述文字 */
  subtitle?: string;
  /** 标题前图标 */
  icon?: LucideIcon;
  /** 右侧操作区域（按钮等） */
  action?: React.ReactNode;
}

/** 页面头部组件 — 标题 + 副标题 + 可选图标 + 可选操作按钮 */
export function PageHeader({ title, subtitle, icon: Icon, action }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          {Icon && <Icon className="size-5 text-accent" />}
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  );
}

/**
 * PageHeader 页面标题头组件。
 *
 * 统一 10+ 页面重复的 "h1 + 副标题 + 操作按钮" 布局模式。
 * 支持左侧 icon 标记（可选）和右侧 action 插槽。
 *
 * 用法：
 *   <PageHeader title={t("home.title")} subtitle={t("home.subtitle")} />
 *   <PageHeader title={t("memory.title")} subtitle={t("memory.subtitle")} icon={Brain} iconClass="text-brand">
 *     <Button>添加</Button>
 *   </PageHeader>
 */

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  /** 页面标题（h1） */
  title: string;
  /** 副标题（灰色小字，可选） */
  subtitle?: string;
  /** 标题旁图标（可选） */
  icon?: LucideIcon;
  /** 图标额外样式（如 `text-brand`） */
  iconClass?: string;
  /** 标题右侧额外内容（如 Badge 计数） */
  titleExtra?: React.ReactNode;
  /** 右侧操作区（按钮等） */
  children?: React.ReactNode;
  /** 容器额外 className */
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  icon: Icon,
  iconClass,
  titleExtra,
  children,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-3 md:flex-row md:items-center md:justify-between", className)}>
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          {Icon && <Icon className={cn("size-5", iconClass)} />}
          {title}
          {titleExtra}
        </h1>
        {subtitle && (
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {children}
    </div>
  );
}

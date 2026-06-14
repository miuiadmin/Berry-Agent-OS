/**
 * SelectField 统一原生 select 组件。
 *
 * 封装移动端友好的 `<select>`：
 * - iOS 防缩放（text-[16px]）→ 桌面端 md:text-sm
 * - 44px 触控目标 → 桌面端紧凑
 * - 自定义右侧箭头（appearance-none + ChevronDown 覆盖）
 *
 * 透传原生 select 属性，受控用法与原生一致。
 *
 * 用法：
 *   <SelectField value={v} onChange={e => setV(e.target.value)}>
 *     <option value="a">A</option>
 *   </SelectField>
 */

import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SelectFieldProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** 自定义容器 className */
  className?: string;
}

export function SelectField({ className, children, ...props }: SelectFieldProps) {
  return (
    <div className="relative">
      <select
        className={cn(
          "w-full rounded-lg border border-input bg-background",
          "px-3 py-2 md:py-1.5",
          "text-[16px] md:text-sm",
          "min-h-[44px] md:min-h-0",
          "appearance-none pr-8",
          "disabled:opacity-50",
          "transition-all",
          "focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      {/* 右侧箭头：pointer-events-none 不挡点击 */}
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
    </div>
  );
}

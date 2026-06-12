/**
 * 下拉选择器 — 封装 HeroUI v3 Select compound（基于 react-aria-components Select）。
 *
 * 提供简化 API（替代原生 <select>）：
 *   <Select value="running" onValueChange={setFilter} options={...} />
 *
 * HeroUI Select compound 结构：
 *   Select.Root > Select.Trigger[Select.Value + Select.Indicator] + Select.Popover > ListBoxItem
 *
 * value/onValueChange（项目约定）映射到 react-aria 的 selectedKey/onSelectionChange。
 * items 用 ListBoxItem 渲染，自动获得键盘导航、聚焦管理、无障碍。
 */
import * as React from "react";
import {
  Select as HeroUISelect,
  ListBoxItem,
  type SelectVariants,
} from "@heroui/react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/** 简化选项定义 */
export interface SelectOption {
  /** 选项唯一 key（选中后的值） */
  key: string;
  /** 显示文本 */
  label: string;
  /** 是否禁用 */
  disabled?: boolean;
}

export interface SelectProps {
  /** 当前选中值 */
  value: string;
  /** 选中变化回调 */
  onValueChange: (value: string) => void;
  /** 选项列表 */
  options: SelectOption[];
  /** 占位提示（无选中时显示） */
  placeholder?: string;
  /** 是否禁用整个选择器 */
  disabled?: boolean;
  /** HeroUI variant，默认 primary */
  variant?: NonNullable<SelectVariants["variant"]>;
  /** 透传 className */
  className?: string;
  /** 无障碍标签 */
  ariaLabel?: string;
}

/**
 * 下拉选择器。
 *
 * 示例：
 *   <Select value={status} onValueChange={setStatus}
 *     options={[{key:"all",label:"全部"},{key:"running",label:"运行中"}]}
 *   />
 */
export const Select = React.forwardRef<HTMLButtonElement, SelectProps>(
  (
    { value, onValueChange, options, placeholder, disabled, variant = "primary", className, ariaLabel },
    _ref
  ) => {
    return (
      <HeroUISelect
        selectedKey={value}
        onSelectionChange={(key) => {
          /* react-aria Key 可能是 string | number，统一转 string */
          if (key != null) onValueChange(String(key));
        }}
        isDisabled={disabled}
        variant={variant}
        aria-label={ariaLabel}
        className={cn("min-h-[44px] md:min-h-0", className)}
      >
        <HeroUISelect.Trigger
          className={cn(
            /* 触发按钮样式：边框、圆角、高度；移动端 44px */
            "flex items-center justify-between gap-2 w-full rounded-md border border-input bg-background px-3 h-11 md:h-8 text-sm transition-colors data-[hover=true]:border-input data-[focus-visible=true]:border-ring outline-none"
          )}
        >
          <HeroUISelect.Value className="text-sm data-[placeholder]:text-muted-foreground" />
          <HeroUISelect.Indicator>
            <ChevronDown className="size-4 text-muted-foreground shrink-0" />
          </HeroUISelect.Indicator>
        </HeroUISelect.Trigger>
        <HeroUISelect.Popover
          className={cn(
            "rounded-lg border border-border bg-background shadow-lg min-w-[--trigger-width]",
            /* 入场/退场动画 */
            "data-[entering]:animate-fade-in data-[exiting]:animate-dropdown-out"
          )}
        >
          {placeholder && (
            <ListBoxItem
              id=""
              className="flex items-center px-3 py-2 text-sm min-h-[44px] md:min-h-9 rounded-md hover:bg-accent focus:bg-accent transition-colors outline-none cursor-pointer"
            >
              {placeholder}
            </ListBoxItem>
          )}
          {options.map((opt) => (
            <ListBoxItem
              key={opt.key}
              id={opt.key}
              isDisabled={opt.disabled}
              className="flex items-center px-3 py-2 text-sm min-h-[44px] md:min-h-9 rounded-md hover:bg-accent focus:bg-accent selection:bg-accent selection:text-foreground transition-colors outline-none cursor-pointer"
            >
              {opt.label}
            </ListBoxItem>
          ))}
        </HeroUISelect.Popover>
      </HeroUISelect>
    );
  }
);
Select.displayName = "Select";

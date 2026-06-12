/**
 * 下拉菜单 — 封装 HeroUI v3 Dropdown compound 组件。
 *
 * 提供简化 API：
 *   <Dropdown trigger={...} items={[...]} />
 *
 * HeroUI Dropdown compound 结构：
 *   Dropdown.Root > Dropdown.Trigger + Dropdown.Popover > Dropdown.Menu > Dropdown.Item
 *
 * 本 adapter 封装了 Root/Trigger/Popover/Menu 层，调用者只需传 trigger 和 items。
 * 也支持 children 模式，完全自定义菜单内容。
 */
import * as React from "react";
import {
  Dropdown as HeroUIDropdown,
  DropdownMenu,
  DropdownItem,
  type DropdownItemProps,
  type DropdownRootProps,
} from "@heroui/react";
import { cn } from "@/lib/utils";

/** 菜单项定义 */
export interface DropdownItemDef {
  /** 唯一 key */
  key: string;
  /** 显示文本 */
  label: string;
  /** 左侧图标（可选） */
  icon?: React.ReactNode;
  /** 点击回调 */
  onPress?: () => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 危险操作样式（如删除） */
  danger?: boolean;
  /** 额外描述文字（可选，显示在 label 下方） */
  description?: string;
}

export interface DropdownProps {
  /** 触发按钮元素（自动包裹 Dropdown.Trigger） */
  trigger: React.ReactNode;
  /** 菜单项列表（简化模式），与 children 二选一 */
  items?: DropdownItemDef[];
  /** 自定义菜单内容（完全控制模式），与 items 二选一 */
  children?: React.ReactNode;
  /** 弹出位置，默认 bottom-end */
  placement?: React.ComponentProps<typeof HeroUIDropdown.Popover>["placement"];
  /** 菜单 className */
  menuClassName?: string;
  /** 整体 className */
  className?: string;
}

/**
 * 下拉菜单。
 *
 * 使用 items 简化模式：
 *   <Dropdown trigger={<Button>菜单</Button>} items={[{key:"a", label:"选项A", onPress:fn}]} />
 *
 * 使用 children 完全控制模式：
 *   <Dropdown trigger={<Button>菜单</Button>}>
 *     <DropdownMenu>...</DropdownMenu>
 *   </Dropdown>
 */
export function Dropdown({
  trigger,
  items,
  children,
  placement = "bottom end",
  menuClassName,
  className,
}: DropdownProps) {
  return (
    <HeroUIDropdown className={className}>
      <HeroUIDropdown.Trigger>{trigger}</HeroUIDropdown.Trigger>
      <HeroUIDropdown.Popover
        placement={placement}
        className={cn(
          "rounded-lg border border-border bg-background shadow-lg",
          /* 入场/退场动画 */
          "data-[entering]:animate-fade-in data-[exiting]:animate-dropdown-out"
        )}
      >
        {items ? (
          <DropdownMenu className={cn("py-1 min-w-[180px]", menuClassName)}>
            {items.map((item) => (
              <DropdownItem
                key={item.key}
                onPress={item.onPress}
                isDisabled={item.disabled}
                className={cn(
                  /* 统一菜单项样式 */
                  "flex items-center gap-3 px-3 py-2.5 md:py-2 text-sm rounded-md min-h-[44px] md:min-h-0",
                  "hover:bg-accent focus:bg-accent active:bg-accent transition-colors outline-none cursor-pointer",
                  /* 危险操作样式 */
                  item.danger && "text-danger hover:bg-danger/10 focus:bg-danger/10",
                  /* 禁用项 */
                  item.disabled && "opacity-50 cursor-not-allowed"
                )}
              >
                {item.icon && <span className="shrink-0">{item.icon}</span>}
                <div className="flex-1 min-w-0">
                  <span>{item.label}</span>
                  {item.description && (
                    <div className="text-[11px] text-muted-foreground">{item.description}</div>
                  )}
                </div>
              </DropdownItem>
            ))}
          </DropdownMenu>
        ) : (
          children
        )}
      </HeroUIDropdown.Popover>
    </HeroUIDropdown>
  );
}

export { HeroUIDropdown as HeroUIDropdownRoot, DropdownMenu, DropdownItem };
export type { DropdownItemProps };

/**
 * 开关 — 封装 HeroUI Switch。
 *
 * 保持原有 export 接口：
 * - checked       → isSelected（react-aria Switch 受控选中态）
 * - onCheckedChange → onChange（react-aria 的 onChange 回调，参数为 boolean）
 * - disabled      → isDisabled（react-aria 的禁用态）
 *
 * HeroUI v3 的 Switch 是 react-aria-components 的 Switch：
 * - 受控用 isSelected + onChange（onChange 参数直接是 boolean）
 * - data-selected / data-disabled 等 data 属性由 react-aria 自动注入
 * 移动端触控目标 44px 通过 className 覆盖保证（CLAUDE.md 硬规则）。
 */
import { Switch as HeroUISwitch } from "@heroui/react";
import { cn } from "@/lib/utils";

interface SwitchProps {
  /** 受控选中态 */
  checked: boolean;
  /** 选中态变化回调，参数为新的选中值 */
  onCheckedChange: (checked: boolean) => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 透传 className */
  className?: string;
  /** 透传 id（用于表单关联） */
  id?: string;
}

export function Switch({ checked, onCheckedChange, disabled, className, id }: SwitchProps) {
  return (
    <HeroUISwitch
      id={id}
      /* 受控选中态 */
      isSelected={checked}
      /* react-aria Switch 的 onChange 直接返回 boolean */
      onChange={onCheckedChange}
      /* 禁用态 */
      isDisabled={disabled}
      /* 移动端触控目标 44px（CLAUDE.md 硬规则），桌面端恢复默认 */
      className={cn("min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0", className)}
    />
  );
}

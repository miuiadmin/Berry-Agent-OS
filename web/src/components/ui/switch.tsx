/**
 * 开关 — 封装 HeroUI Switch。
 *
 * 保持原有 export 接口：
 * - checked → isSelected
 * - onCheckedChange → onValueChange
 * - disabled → isDisabled
 * 移动端触控目标 44px 通过 className 覆盖保证。
 */
import { Switch as HeroUISwitch } from "@heroui/react";
import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
}

export function Switch({ checked, onCheckedChange, disabled, className, id }: SwitchProps) {
  return (
    <HeroUISwitch
      id={id}
      isSelected={checked}
      onValueChange={onCheckedChange}
      isDisabled={disabled}
      /* 移动端触控目标 44px（CLAUDE.md 硬规则），桌面端恢复默认 */
      className={cn("min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0", className)}
    />
  );
}

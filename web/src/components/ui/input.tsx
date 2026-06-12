/**
 * 输入框 — 封装 HeroUI v3 Input（react-aria-components Input）。
 *
 * HeroUI v3 Input 是 react-aria 的 <input> 封装，直接渲染原生 input，
 * 因此 value/onChange/placeholder/type/disabled/ref 都可透传。
 *
 * variant 默认 primary（v3 合法值 primary|secondary），调用者可覆盖。
 * 实际边框/高度样式由 className 提供，保持统一外观。
 * 移动端 h-10（40px）、桌面端 h-8，符合移动端触控目标硬规则。
 */
import * as React from "react";
import { Input as HeroUIInput } from "@heroui/react";
import type { InputVariants } from "@heroui/styles";
import { cn } from "@/lib/utils";

/** HeroUI v3 Input variant 取值 */
type HeroInputVariant = NonNullable<InputVariants["variant"]>;

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** HeroUI Input variant，默认 primary */
  variant?: HeroInputVariant;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, variant = "primary", ...props }, ref) => {
    return (
      <HeroUIInput
        type={type}
        variant={variant}
        ref={ref}
        /* 移动端 h-10，桌面端 h-8；统一圆角和边框 hover 态 */
        className={cn(
          "h-10 md:h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-[16px] md:text-sm transition-all placeholder:text-muted-foreground focus:border-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[hover=true]:border-input",
          className
        )}
        {...(props as React.ComponentPropsWithRef<typeof HeroUIInput>)}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };

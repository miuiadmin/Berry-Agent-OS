/**
 * 输入框 — 封装 HeroUI v3 Input（react-aria-components Input）。
 *
 * 精简 adapter：直接暴露 HeroUI 原生 variant/size，
 * 不再手动复写边框/焦点样式——HeroUI variant="primary" 已原生处理。
 * 仅追加项目特有能力：
 *   - 移动端 h-10 / 桌面端 h-8（触控目标硬规则）
 *   - text-[16px] 防止 iOS Safari 自动缩放
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
        /**
         * 仅追加 HeroUI 未覆盖的项目特有样式：
         * - 移动端 h-10、桌面端 h-8（触控目标硬规则）
         * - text-[16px] 防止 iOS Safari 自动缩放
         * 边框/焦点/placeholder/disabled 样式全部由 HeroUI variant 系统原生处理
         */
        className={cn(
          "h-10 md:h-8 w-full text-[16px] md:text-sm",
          className
        )}
        {...(props as React.ComponentPropsWithRef<typeof HeroUIInput>)}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };

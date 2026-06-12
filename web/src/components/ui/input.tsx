/**
 * 输入框 — 封装 HeroUI v3 Input（react-aria-components Input）。
 *
 * 保持原有 forwardRef 和原生 input 属性透传。
 * HeroUI v3 Input 是 react-aria 的 <input> 封装，接受 variant + className。
 * （注意：v3 没有 classNames.inputWrapper，那是 NextUI/v2 的 API）
 * variant="bordered" 提供边框样式，移动端 h-10、桌面端 h-8 通过 className 覆盖。
 */
import * as React from "react";
import { Input as HeroUIInput } from "@heroui/react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <HeroUIInput
        type={type}
        variant="bordered"
        ref={ref}
        className={cn(
          "h-10 md:h-8 w-full rounded-lg border border-input bg-background px-3 py-1 text-[16px] md:text-sm transition-all placeholder:text-muted-foreground focus:border-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };

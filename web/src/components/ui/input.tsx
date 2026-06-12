/**
 * 输入框 — 封装 HeroUI Input。
 *
 * 保持原有 forwardRef 和原生 input 属性透传，
 * 内部委托 HeroUI Input（variant="bordered" 有边框样式）。
 * 移动端高度 h-10（40px），桌面端 h-8，通过 classNames.inputWrapper 覆盖。
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
        classNames={{
          /* 移动端 h-10，桌面端 h-8 */
          inputWrapper: cn("h-10 md:h-8 data-[hover=true]:border-input", className),
        }}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };

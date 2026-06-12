/**
 * 输入框 — 封装 HeroUI v3 Input（react-aria-components Input）。
 *
 * 保持原有 forwardRef 和原生 input 属性透传。
 * HeroUI v3 Input 是 react-aria 的 <input> 封装，直接渲染原生 input，
 * 因此 value/onChange/placeholder/type/disabled/ref 都可透传。
 *
 * 注意 variant 语义与 NextUI/v2 不同：v3 只支持 primary|secondary（无 bordered），
 * 且没有 classNames.inputWrapper 槽位 API。这里用 variant="primary" 作为默认外观，
 * 实际边框/高度样式由 className 提供，保持与原 shadcn 风格一致。
 *
 * 移动端 h-10（40px）、桌面端 h-8，符合移动端触控目标硬规则。
 */
import * as React from "react";
import { Input as HeroUIInput } from "@heroui/react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <HeroUIInput
        type={type}
        /* v3 合法 variant，避免传入 bordered（v3 不识别会被忽略） */
        variant="primary"
        ref={ref}
        /* 移动端 h-10，桌面端 h-8；统一圆角和边框 hover 态 */
        className={cn(
          "h-10 md:h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-[16px] md:text-sm transition-all placeholder:text-muted-foreground focus:border-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[hover=true]:border-input",
          className
        )}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };

/**
 * 多行文本框 — 封装 HeroUI v3 TextArea（react-aria-components TextArea）。
 *
 * HeroUI v3 TextArea 是 react-aria 的 <textarea> 封装，直接渲染原生 textarea，
 * 因此 value/onChange/placeholder/rows/disabled/ref 都可透传。
 *
 * variant 默认 primary（v3 合法值 primary|secondary），调用者可覆盖。
 * 移动端触控目标增强（最小 h-11 / 44px），桌面端恢复默认高度。
 */
import * as React from "react";
import { TextArea as HeroUITextArea } from "@heroui/react";
import type { TextAreaVariants } from "@heroui/styles";
import { cn } from "@/lib/utils";

/** HeroUI v3 TextArea variant 取值 */
type HeroTextAreaVariant = NonNullable<TextAreaVariants["variant"]>;

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** HeroUI TextArea variant，默认 primary */
  variant?: HeroTextAreaVariant;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, variant = "primary", ...props }, ref) => {
    return (
      <HeroUITextArea
        variant={variant}
        ref={ref}
        /**
         * 样式说明：
         * - 移动端 min-h-[44px]（触控目标硬规则）、桌面端恢复 min-h-0
         * - 统一圆角、边框、焦点态样式，与 Input adapter 保持一致
         * - text-[16px] 防止 iOS Safari 自动缩放页面
         */
        className={cn(
          "w-full rounded-md border border-input bg-background px-3 py-2 text-[16px] md:text-sm transition-all placeholder:text-muted-foreground focus:border-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 min-h-[44px] md:min-h-0",
          className
        )}
        /**
         * React Aria TextArea 的 props 类型与 HTML textarea 的 props 有细微差异，
         * 用类型断言绕过，运行时无影响（value/onChange/rows 等核心 prop 完全兼容）。
         */
        {...(props as React.ComponentPropsWithRef<typeof HeroUITextArea>)}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };

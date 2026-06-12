/**
 * 多行文本框 — 封装 HeroUI v3 TextArea（react-aria-components TextArea）。
 *
 * 精简 adapter：直接暴露 HeroUI 原生 variant，
 * 不再手动复写边框/焦点样式——HeroUI variant="primary" 已原生处理。
 * 仅追加项目特有能力：
 *   - 移动端 min-h-[44px]（触控目标硬规则）
 *   - text-[16px] 防止 iOS Safari 自动缩放
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
         * 仅追加 HeroUI 未覆盖的项目特有样式：
         * - 移动端 min-h-[44px]（触控目标硬规则）、桌面端恢复 min-h-0
         * - text-[16px] 防止 iOS Safari 自动缩放
         * 边框/焦点/placeholder/disabled 样式全部由 HeroUI variant 系统原生处理
         */
        className={cn(
          "w-full text-[16px] md:text-sm min-h-[44px] md:min-h-0",
          className
        )}
        {...(props as React.ComponentPropsWithRef<typeof HeroUITextArea>)}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };

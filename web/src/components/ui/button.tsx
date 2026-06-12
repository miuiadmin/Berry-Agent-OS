/**
 * 按钮 — 封装 HeroUI v3 Button。
 *
 * 设计原则（精简 adapter）：直接暴露 HeroUI 原生 variant 名，
 * 删除冗余的 CVA 与 switch-case 映射；仅追加项目特有的能力：
 *   - `link` 变体（HeroUI 无此变体，用 primary 基底 + 下划线）
 *   - `icon` / `icon-sm` 尺寸 → isIconOnly
 *   - 移动端 44px 触控目标（CLAUDE.md 硬规则）
 *
 * variant 取 HeroUI 原生值：primary / outline / secondary / ghost / danger / link
 * size：sm / md / lg / icon / icon-sm（HeroUI 原生 sm/md/lg，icon* 走 isIconOnly）
 */
import * as React from "react";
import { Button as HeroUIButton } from "@heroui/react";
import type { ButtonVariants } from "@heroui/styles";
import { cn } from "@/lib/utils";

/** HeroUI v3 支持的 variant 值 */
type HeroUIVariant = NonNullable<ButtonVariants["variant"]>;

/** HeroUI v3 支持的 size 值 */
type HeroUISize = NonNullable<ButtonVariants["size"]>;

/** 项目自有 variant：HeroUI 原生 + link（下划线文字按钮） */
export type ButtonVariant = HeroUIVariant | "link";

/** 项目自有 size：HeroUI 原生 + 图标专用 */
export type ButtonSize = HeroUISize | "icon" | "icon-sm";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 按钮变体，默认 primary */
  variant?: ButtonVariant;
  /** 按钮尺寸，默认 sm（移动端会自动放大到 44px 触控目标） */
  size?: ButtonSize;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "sm", disabled, ...props }, ref) => {
    /* 纯图标按钮：size 为 icon / icon-sm 时启用 isIconOnly */
    const isIconOnly = size === "icon" || size === "icon-sm";
    /* link 变体无 HeroUI 原生对应，用 primary 基底 + 下划线样式实现 */
    const isLink = variant === "link";

    /* 图标尺寸映射到 HeroUI sm（实际尺寸靠 isIconOnly 控制） */
    const heroSize: HeroUISize = isIconOnly ? "sm" : size;

    return (
      <HeroUIButton
        ref={ref}
        /* link → primary 基底；其余 variant 原样透传 HeroUI */
        variant={isLink ? "primary" : (variant as HeroUIVariant)}
        size={heroSize}
        isIconOnly={isIconOnly}
        /* HeroUI 用 isDisabled 而非 disabled */
        isDisabled={disabled}
        className={cn(
          /* link 变体追加下划线样式 */
          isLink && "underline underline-offset-4",
          /* 移动端触控目标 44px（CLAUDE.md 硬规则），桌面端恢复 HeroUI 默认尺寸 */
          !isIconOnly && "min-h-[44px] md:min-h-0",
          isIconOnly && "min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0",
          className
        )}
        /**
         * React Aria Button 的 value 类型为 string | undefined，
         * 而 HTMLButtonElement.value 包含 number | readonly string[]，
         * 类型不兼容。用类型断言绕过，运行时无影响（按钮很少用 value）。
         */
        {...(props as React.ComponentPropsWithRef<typeof HeroUIButton>)}
      />
    );
  }
);
Button.displayName = "Button";

export { Button };

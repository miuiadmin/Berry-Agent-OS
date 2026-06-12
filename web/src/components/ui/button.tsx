/**
 * 按钮 — 封装 HeroUI v3 Button。
 *
 * 保持原有 export 接口（Button / ButtonProps / buttonVariants），
 * 内部委托 HeroUI ButtonRoot 组件。
 *
 * HeroUI v3 Button API：
 *   - 没有 color 属性，variant 直接承载语义（primary/outline/ghost/danger 等）
 *   - isDisabled（非 disabled）、isIconOnly、fullWidth
 *   - size: sm / md / lg
 *   - 底层是 React Aria Button，支持原生 onClick / type 等属性
 *
 * 变体映射：
 *   default     → variant="primary"
 *   outline     → variant="outline"
 *   secondary   → variant="secondary"
 *   ghost       → variant="ghost"
 *   destructive → variant="danger"
 *   link        → variant="primary" + className 加下划线
 *
 * 尺寸映射：
 *   default(h-8)  → size="sm"
 *   sm(h-7)       → size="sm"
 *   lg(h-9)       → size="md"
 *   icon(size-8)  → isIconOnly + size="sm"
 *   icon-sm(size-7) → isIconOnly + size="sm"
 */
import * as React from "react";
import { Button as HeroUIButton } from "@heroui/react";
import type { ButtonVariants } from "@heroui/styles";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** HeroUI v3 支持的 variant 值 */
type HeroUIVariant = NonNullable<ButtonVariants["variant"]>;

/** HeroUI v3 支持的 size 值 */
type HeroUISize = NonNullable<ButtonVariants["size"]>;

/**
 * 保留 buttonVariants 以兼容可能的外部引用。
 * HeroUI v3 接管样式后此函数仅用于拼接 className，
 * 不再承担核心渲染职责。
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-lg text-sm font-medium transition-colors transition-transform outline-none select-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 active:scale-[0.97] [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        outline:
          "border border-border bg-background hover:bg-muted hover:text-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-muted hover:text-foreground",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 gap-1.5 px-3",
        sm: "h-7 gap-1 px-2.5 text-xs",
        lg: "h-9 gap-2 px-4",
        icon: "size-8",
        "icon-sm": "size-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, disabled, ...props }, ref) => {
    /* 判断是否为纯图标按钮 */
    const isIconOnly = size === "icon" || size === "icon-sm";
    /* link 变体需要额外下划线样式 */
    const isLink = variant === "link";

    /**
     * 将我们的 variant 映射到 HeroUI v3 的 variant。
     * v3 没有 color 属性，variant 本身包含颜色语义。
     */
    let heroVariant: HeroUIVariant = "primary";
    switch (variant) {
      case "default":
        heroVariant = "primary";
        break;
      case "outline":
        heroVariant = "outline";
        break;
      case "secondary":
        heroVariant = "secondary";
        break;
      case "ghost":
        heroVariant = "ghost";
        break;
      case "destructive":
        heroVariant = "danger";
        break;
      case "link":
        /* link 没有 HeroUI 原生对应，用 primary 基底 + className 下划线 */
        heroVariant = "primary";
        break;
    }

    /**
     * 将我们的 size 映射到 HeroUI v3 的 size。
     * HeroUI sm ≈ 我们的 default/sm，md ≈ 我们的 lg
     */
    let heroSize: HeroUISize = "sm";
    if (size === "lg") heroSize = "md";

    return (
      <HeroUIButton
        ref={ref}
        variant={heroVariant}
        size={heroSize}
        isIconOnly={isIconOnly}
        /* HeroUI 用 isDisabled 而非 disabled，同时保留原生 disabled 透传 */
        isDisabled={disabled}
        className={cn(
          /* link 变体追加下划线样式 */
          isLink && "underline underline-offset-4",
          /* 移动端触控目标 44px（CLAUDE.md 硬规则） */
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

export { Button, buttonVariants };

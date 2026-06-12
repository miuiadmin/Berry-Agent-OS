/**
 * 徽章 — 封装 HeroUI Chip。
 *
 * 保持原有 export 接口（variant + className），内部映射到 HeroUI v3 Chip 的
 * color（accent|danger|default|success|warning）与 variant（primary|secondary|soft|tertiary）。
 *
 * 注意 HeroUI v3 的 variant 语义与任务简述中的 flat/bordered 不同：
 * - v3 没有 "flat"，最接近的着色填充风格是 "soft"
 * - v3 没有 "bordered"，最接近的描边/弱化风格是 "tertiary"
 *
 * 映射策略：
 * - default     → soft    + accent   （主品牌色，软填充）
 * - secondary   → soft    + default  （中性灰，软填充）
 * - success     → soft    + success  （成功色）
 * - warning     → soft    + warning  （警告色）
 * - destructive → soft    + danger   （危险色）
 * - outline     → tertiary + default  （描边弱化风格，替代旧 bordered）
 *
 * size 固定为 sm 以贴近原有 Badge 的紧凑尺寸。
 */
import { Chip } from "@heroui/react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** 保留 badgeVariants 以兼容可能的外部引用（样式仅用于类型推断与回退，实际渲染走 Chip） */
const badgeVariants = cva(
  "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium transition-all",
  {
    variants: {
      variant: {
        default: "bg-primary/10 text-primary",
        secondary: "bg-secondary text-secondary-foreground",
        success: "bg-success/10 text-success",
        warning: "bg-warning/10 text-warning",
        destructive: "bg-destructive/10 text-destructive",
        outline: "border border-border text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

/** HeroUI v3 Chip 颜色取值 */
type HeroChipColor = "accent" | "danger" | "default" | "success" | "warning";
/** HeroUI v3 Chip variant 取值 */
type HeroChipVariant = "primary" | "secondary" | "soft" | "tertiary";

/** 旧 variant → HeroUI v3 Chip 的 {color, variant} 映射 */
const variantToChip: Record<
  NonNullable<BadgeProps["variant"]>,
  { color: HeroChipColor; chipVariant: HeroChipVariant }
> = {
  default: { color: "accent", chipVariant: "soft" },
  secondary: { color: "default", chipVariant: "soft" },
  success: { color: "success", chipVariant: "soft" },
  warning: { color: "warning", chipVariant: "soft" },
  destructive: { color: "danger", chipVariant: "soft" },
  outline: { color: "default", chipVariant: "tertiary" },
};

/**
 * Badge 渲染。
 *
 * 注意：不使用 `{...props}` 扩展传播——BadgeProps 继承自 HTMLAttributes，
 * 其中的 `color: string` 与 HeroUI Chip 的严格联合类型冲突（TS2322）。
 * 因此显式只透传 className 和 children。
 */
function Badge({ className, variant, children }: BadgeProps) {
  const mapping = variantToChip[variant ?? "default"] ?? variantToChip.default;

  return (
    <Chip
      variant={mapping.chipVariant}
      color={mapping.color}
      size="sm"
      className={cn(className)}
    >
      {children}
    </Chip>
  );
}

export { Badge, badgeVariants };

/**
 * 徽章 — 封装 HeroUI Chip。
 *
 * 保持原有 export 接口（variant + className），
 * 内部映射到 HeroUI Chip 的 color/variant 组合：
 * - default → primary flat
 * - secondary → default flat
 * - success → success flat
 * - warning → warning flat
 * - destructive → danger flat
 * - outline → default bordered
 */
import { Chip } from "@heroui/react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** 保留 badgeVariants 以兼容可能的外部引用 */
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

/** variant → HeroUI Chip color 映射 */
const variantToChipColor: Record<string, "primary" | "default" | "success" | "warning" | "danger"> = {
  default: "primary",
  secondary: "default",
  success: "success",
  warning: "warning",
  destructive: "danger",
};

function Badge({ className, variant, ...props }: BadgeProps) {
  const v = variant ?? "default";
  const isOutline = v === "outline";
  const chipColor = variantToChipColor[v] ?? "default";

  return (
    <Chip
      variant={isOutline ? "bordered" : "flat"}
      color={isOutline ? "default" : chipColor}
      size="sm"
      className={cn(className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };

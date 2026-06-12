/**
 * 徽章 — 封装 HeroUI v3 Chip。
 *
 * 精简 adapter：删除冗余 CVA，用简洁的对象映射将语义 variant 转换为
 * HeroUI Chip 的 color + variant 组合。
 *
 * variant 映射：
 * - default   → accent + soft   （青蓝品牌色，软填充）
 * - secondary → default + soft   （中性灰，软填充）
 * - success   → success + soft   （翠绿成功色）
 * - warning   → warning + soft   （琥珀警告色）
 * - danger    → danger + soft     （暖红危险色）
 * - outline   → default + tertiary（描边弱化风格）
 *
 * size 固定为 sm 以贴近原有 Badge 的紧凑尺寸。
 */
import { Chip } from "@heroui/react";
import { cn } from "@/lib/utils";

/** 语义 variant 名（直接暴露，不再做重命名映射） */
export type BadgeVariant =
  | "default"
  | "secondary"
  | "success"
  | "warning"
  | "danger"
  | "outline";

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 徽章样式变体，默认 default */
  variant?: BadgeVariant;
}

/** HeroUI v3 Chip 颜色取值 */
type HeroChipColor = "accent" | "danger" | "default" | "success" | "warning";
/** HeroUI v3 Chip variant 取值 */
type HeroChipVariant = "primary" | "secondary" | "soft" | "tertiary";

/** 语义 variant → HeroUI Chip {color, variant} 映射 */
const variantToChip: Record<BadgeVariant, { color: HeroChipColor; chipVariant: HeroChipVariant }> = {
  default:   { color: "accent",  chipVariant: "soft" },
  secondary: { color: "default", chipVariant: "soft" },
  success:   { color: "success", chipVariant: "soft" },
  warning:   { color: "warning", chipVariant: "soft" },
  danger:    { color: "danger",  chipVariant: "soft" },
  outline:   { color: "default", chipVariant: "tertiary" },
};

/**
 * Badge 渲染。
 *
 * 不使用 {...props} 扩展传播——HTMLAttributes 中的 `color: string`
 * 与 HeroUI Chip 的严格联合类型冲突（TS2322）。
 * 显式只透传 className 和 children。
 */
function Badge({ className, variant = "default", children }: BadgeProps) {
  const mapping = variantToChip[variant] ?? variantToChip.default;

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

export { Badge };

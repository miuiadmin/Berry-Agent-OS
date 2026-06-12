/**
 * 头像 — 封装 HeroUI v3 Avatar compound 组件。
 *
 * 精简 adapter：暴露 src/name/fallback 的简化 props。
 * HeroUI Avatar 支持 Image + Fallback 子组件：
 *   - 有 src 时渲染图片，加载失败自动回退到 Fallback
 *   - 无 src 时直接显示 Fallback（initials 或自定义内容）
 * 内置无障碍（alt、role）、图片加载状态、尺寸变体。
 */
import * as React from "react";
import { Avatar as HeroUIAvatar } from "@heroui/react";
import type { AvatarVariants } from "@heroui/styles";
import { cn } from "@/lib/utils";

/** HeroUI Avatar 支持的尺寸 */
type AvatarSize = NonNullable<AvatarVariants["size"]>;

/** HeroUI Avatar 支持的视觉变体（default 实色 / soft 柔和底） */
type AvatarVariantShape = NonNullable<AvatarVariants["variant"]>;

export interface AvatarProps {
  /** 图片 URL；不传则显示 Fallback */
  src?: string;
  /** 图片替代文字（同时作为无障碍 alt） */
  alt?: string;
  /** 显示名称；无 src 时用于生成 initials 回退内容 */
  name?: string;
  /** 尺寸，默认 sm */
  size?: AvatarSize;
  /** 视觉变体（default 实色 / soft 柔和底），默认 default */
  variant?: AvatarVariantShape;
  /** 自定义回退内容（优先于 name 生成的 initials） */
  fallback?: React.ReactNode;
  /** 透传 className */
  className?: string;
}

/** 从名称生成 1-2 个字符的 initials（大写） */
function getInitials(name?: string): string {
  if (!name) return "?";
  return name.trim().slice(0, 2).toUpperCase();
}

/**
 * 头像。映射到 HeroUI Avatar.Root + Image + Fallback。
 * 有 src 渲染图片并自动回退；无 src 显示 initials Fallback。
 * 形状（圆形/方形）通过 className 的 rounded-* 控制（HeroUI 默认圆形）。
 */
export function Avatar({
  src,
  alt,
  name,
  size = "sm",
  variant = "default",
  fallback,
  className,
}: AvatarProps) {
  return (
    <HeroUIAvatar size={size} variant={variant} className={cn(className)}>
      {src && <HeroUIAvatar.Image src={src} alt={alt ?? name} />}
      <HeroUIAvatar.Fallback>{fallback ?? getInitials(name)}</HeroUIAvatar.Fallback>
    </HeroUIAvatar>
  );
}

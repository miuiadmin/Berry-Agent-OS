/**
 * Tailwind CSS 类名合并工具。
 *
 * cn() = clsx + twMerge：合并条件类名 + 去重冲突的 Tailwind 类。
 * 全项目统一的 className 合并入口。
 */

import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

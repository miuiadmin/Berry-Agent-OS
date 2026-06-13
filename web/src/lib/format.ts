/**
 * 共享格式化工具函数。
 *
 * 集中管理前端各页面/组件通用的数值格式化逻辑，
 * 避免各文件重复定义相同函数。
 */

/**
 * 格式化 token 数量为人类可读的缩写形式。
 *
 * - ≥1,000,000 → "1.5M" 格式
 * - ≥1,000 → "12.3K" 格式
 * - <1,000 → 原始数字
 *
 * @param n token 数量
 * @returns 格式化后的字符串
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * 格式化 token 数量（整数版本，用于模型表格展示）。
 *
 * 与 formatTokens 的区别：千位使用整数（12K 而非 12.3K），
 * 适用于 channel-card 模型行等空间有限的场景。
 *
 * @param n token 数量
 * @returns 格式化后的字符串
 */
export function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/**
 * 格式化任务持续时间。
 *
 * 根据 startedAt/finishedAt 计算运行时长，运行中的任务显示省略号后缀。
 *
 * @param startedAt 开始时间（ISO 字符串）
 * @param finishedAt 结束时间（ISO 字符串），未结束则传 undefined
 * @param status 任务状态，"running" 时末尾加 "..."
 * @returns 格式化后的时间字符串（如 "3m 24s..."）
 */
export function formatDuration(startedAt?: string, finishedAt?: string, status?: string): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s${status === "running" ? "..." : ""}`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem}s${status === "running" ? "..." : ""}`;
}

/**
 * 格式化系统运行时间（从秒数转为人类可读形式）。
 *
 * - <60s → "42s"
 * - <60m → "5m"
 * - <24h → "3h 24m"
 * - ≥24h → "2d 5h"
 *
 * @param seconds 运行秒数
 * @returns 格式化后的时间字符串
 */
export function formatUptime(seconds: number | undefined | null): string {
  if (seconds == null || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return `${hours}h ${remainMin}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * 格式化 JSON 字符串（美化缩进）。
 *
 * 尝试解析并重新格式化，解析失败则原样返回（容错处理）。
 *
 * @param str 原始 JSON 字符串
 * @returns 缩进后的 JSON 字符串
 */
export function formatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

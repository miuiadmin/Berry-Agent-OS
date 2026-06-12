/**
 * 共享格式化工具函数。
 *
 * 从多个页面/组件中提取的重复逻辑，统一到此模块。
 */

/** 格式化 token/数量为人类可读短文本（如 1.2K, 3.5M） */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * 格式化任务持续时间。
 * @param startedAt 开始时间（ISO 字符串）
 * @param finishedAt 结束时间（ISO 字符串，运行中为 undefined）
 * @param status 任务状态（running 时追加 "..."）
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
 * 格式化毫秒级耗时（工具调用、调试抓取等短时延场景）。
 * 适配两个来源的旧实现：tool-call-cards（秒级带 1 位小数）、debug-capture（含分钟）。
 * 统一规则：< 1s 显示 "Nms"；< 1min 显示 "N.Ns"；否则显示 "Nm Ns"。
 * @param ms 毫秒数
 */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/** 格式化 JSON 字符串为缩进格式，解析失败返回原文 */
export function formatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

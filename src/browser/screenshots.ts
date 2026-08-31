/**
 * L3 browser — 截图落盘（契约篇 §6.10 截图管理段，第四十九批刀二）。
 *
 * 图像字节**永不进 durable / 工具结果 content**——工具面只落路径 + 尺寸
 * （规范钉死：图像走文件系统，会话事件账本零二进制）。
 * 目录形态：`<dataDir>/browser/screenshots/<sessionKey>/shot-<seq>.png`；
 * 每 sessionKey 滚动保留最近 KEEP 张（旧删——磁盘无上限增长防线）。
 */

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 每 session 滚动保留张数（超过即删最旧） */
export const SCREENSHOTS_KEEP = 20;

/** 截图落盘产物（browser_screenshot 工具返回面——details 字段值源） */
export interface SavedScreenshot {
  /** 绝对路径（人读/后续工具消费锚） */
  readonly path: string;
  /** 图像字节数（诊断面——尺寸披露不进 content） */
  readonly bytes: number;
}

/** sessionKey 目录名净化（sessionId 是内核生成物，防御位兜底路径穿越） */
function safeKey(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * 单图落盘 + 滚动清理（同步 IO——截图量级 KB~MB，同步写不伤响应面）。
 * @param dataDir 数据目录（组合根注入）
 * @param sessionKey 会话键（engine 同键——匿名兜底 '_default'）
 * @param seq per-session 递增序号（调用方维护——文件名排序即时序）
 * @param png PNG 字节（Page.captureScreenshot 的 base64 解码产物）
 */
export function saveScreenshot(dataDir: string, sessionKey: string, seq: number, png: Uint8Array): SavedScreenshot {
  const dir = join(dataDir, 'browser', 'screenshots', safeKey(sessionKey));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `shot-${seq}.png`);
  writeFileSync(path, png);
  pruneSessionShots(dir);
  return { path, bytes: png.byteLength };
}

/**
 * 单 session 滚动清理（保留最近 KEEP 张——按 mtime 降序，超帽删最旧）。
 * 清理失败静默（缺目录/竞态删除——清理是尽力面，不拦截图主路）。
 */
function pruneSessionShots(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // 目录已被并发清走——无事可做
  }
  const stamped: { name: string; mtimeMs: number }[] = [];
  for (const name of names) {
    try {
      stamped.push({ name, mtimeMs: statSync(join(dir, name)).mtimeMs });
    } catch {
      // 竞态删除——跳过该条
    }
  }
  if (stamped.length <= SCREENSHOTS_KEEP) return;
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs); // 新→旧
  for (const { name } of stamped.slice(SCREENSHOTS_KEEP)) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // 竞态删除——已不在即达清理效果
    }
  }
}

/**
 * L3 checkpoint — 文件恢复引擎（会话篇 §5.3 回退两段事务之「files first」段，
 * 2026-08-30）。
 *
 * 恢复 = manifest ∩ blob 仓逐路径覆写：含重建被删文件与父目录（mkdir recursive）。
 * **快照后新建文件 = 遗留报告不删**（无删除铁律，dsh D5——回退永不 rm 用户目录）：
 * 遗留清单如实点名，处置权在操作者。
 *
 * 只回放内容不回放 mode（v1 诚实简单——mode 记 manifest 供指纹判定，权限位
 * 恢复挂真实需求）。失败语义：任一路径恢复失败整体抛错——调用方如实报告
 * 「恢复失败不 fork、快照保留」（§5.3 失败语义）。
 */

import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { readBlob, type CheckpointManifest } from './store.js';
import { toPosix } from './snapshot.js';

/** 恢复报告（回执展示面） */
export interface RestoreReport {
  /** 已恢复文件数 */
  readonly restored: number;
  /** 快照后新建的遗留文件（当前工作区有、目标 manifest 无——报告不删） */
  readonly leftovers: readonly string[];
}

/** 枚举工作区当前全部普通文件相对路径（遗留检测用——与捕获同一遍历剪枝语义的轻量版：只列路径不 stat） */
async function listCurrentFiles(workspaceRoot: string, skipDirs: Set<string>): Promise<Set<string>> {
  const out = new Set<string>();
  const stack: string[] = [workspaceRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const sorted = [...entries].sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of sorted) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        stack.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.add(toPosix(relative(workspaceRoot, join(dir, entry.name))));
      }
    }
  }
  return out;
}

/**
 * 把工作区恢复到目标快照状态（files first 段）。
 * @param workspaceRoot canonical 工作区根
 * @param dataRoot 件数据根（blob 仓所在）
 * @param target 目标快照 manifest
 * @returns 恢复报告（restored + leftovers）
 * @throws 任一 blob 读/写失败——整体失败（调用方不进入 fork 段）
 */
export async function restoreWorkspace(
  workspaceRoot: string,
  dataRoot: string,
  target: CheckpointManifest,
): Promise<RestoreReport> {
  // 逐路径覆写：先建父目录（重建被删文件的目录树），blob 内容写回
  for (const entry of target.files) {
    const abs = join(workspaceRoot, entry.rel);
    const content = await readBlob(dataRoot, entry.hash);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }

  // 遗留检测：当前工作区有、目标 manifest 无的路径（快照后新建）——报告不删
  const snapshotted = new Set(target.files.map((f) => f.rel));
  const current = await listCurrentFiles(workspaceRoot, new Set(['node_modules', '.git']));
  const leftovers = [...current].filter((rel) => !snapshotted.has(rel)).sort();

  return { restored: target.files.length, leftovers };
}

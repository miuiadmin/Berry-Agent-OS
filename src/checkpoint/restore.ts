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
 *
 * 写段入 per-canonical-path 写串行链（2026-09-01 遗漏大扫 20260901-c #5，
 * 骨架篇 §7.5② 链覆盖的第四写者）：覆写与工具 write/edit 同链互斥——裸写
 * 会使宿主内两条写路径零互斥，同会话 run 窗口内启动的工具写与恢复覆写
 * 交叠同一文件可撕裂混合两态（修前形态）。
 */

import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { canonicalize, serializeWrites } from '../tools/fs.js';
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
  // 写段入 per-canonical-path 写串行链（2026-09-01 遗漏大扫 20260901-c #5，
  // 会话篇 §5.3 前置拒两段收口）：链键 = manifest 路径对 workspaceRoot 的
  // canonical 化——与工具 write/edit 同键同链，宿主内两条写路径在同一物理
  // 路径上零交叠。整批恢复共享同一占位（edit 多路径批同款全序锚）：恢复期间
  // 对任一目标路径的工具写排队在其后，反之亦然——不撕裂、写序可预期。
  // 不存在的路径 canonicalize 回退最近存在祖先再拼回尾部段（与工具写同源
  // ——重建被删文件与新建文件两形态同键）。
  const chainKeys = await Promise.all(target.files.map((entry) => canonicalize(join(workspaceRoot, entry.rel))));
  const leftovers = await serializeWrites(chainKeys, async () => {
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
    return [...current].filter((rel) => !snapshotted.has(rel)).sort();
  });

  return { restored: target.files.length, leftovers };
}

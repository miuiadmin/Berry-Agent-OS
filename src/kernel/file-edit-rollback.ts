/**
 * 用户拒绝后文件回滚机制（跨进程安全）。
 *
 * 用户拒绝任务后，Code Agent 的 onStop hook 读取本 task 的工具历史，按时间倒序
 * 从备份恢复所有修改类工具（write_file / edit_code）的副作用。
 *
 * 跨进程设计（关键）：Code Agent 是子进程，写入操作在子进程内完成，
 * 但回滚触发可能来自 Kernel 主进程（turn.correction action=stop / 用户拒绝）。
 * 因此备份必须落在共享文件系统，不能放进程内存。
 *
 * 实现方式：
 * - 备份目录：~/.berry/backups/<taskId>/<seq>.json（每个 task 一个子目录）
 * - 每个备份记录：被改文件的绝对路径 + 写入前的旧内容（null=原本不存在）
 * - rollback(taskId) 读目录、按 seq 倒序逐个恢复（最后写的最先回滚）
 * - commit(taskId) 删除整个备份子目录（任务正常完成，无需保留）
 *
 * 当前任务上下文：工具是无状态函数，通过 setCurrentTask 让工具知道
 * 归属哪个 task。Code Agent tool loop 开头 setCurrentTask，结束 commit/clear。
 */

import { readFile, writeFile, readdir, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { getAppHome } from '../utils/paths.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('file-edit-rollback');

/** 备份根目录：~/.berry/backups/ */
function getBackupsRoot(): string {
  return join(getAppHome(), 'backups');
}

/** 单个 task 的备份目录：~/.berry/backups/<taskId>/ */
function getTaskBackupDir(taskId: string): string {
  return join(getBackupsRoot(), taskId);
}

/** 单次变更记录（持久化到 <seq>.json） */
interface MutationRecord {
  /** 序号（同 task 内单调递增，回滚按它倒序） */
  seq: number;
  /** 被修改的文件绝对路径 */
  filePath: string;
  /** 写入前的旧内容；null 表示文件原本不存在（新建），回滚时删除该文件 */
  oldContent: string | null;
}

/** 模块级「当前任务」上下文 — 工具执行期间由 Code Agent 设置 */
let currentTaskId: string | null = null;

/** 当前 task 的下一个序号（内存缓存，避免每次 readdir 计数） */
const seqCounters = new Map<string, number>();

/**
 * 设置当前工具执行归属的 task（Code Agent tool loop 开头调用）。
 * @param taskId 当前 agent task 的 ID
 */
export async function setCurrentTask(taskId: string | null): Promise<void> {
  currentTaskId = taskId;
  if (taskId) {
    await mkdir(getTaskBackupDir(taskId), { recursive: true });
    if (!seqCounters.has(taskId)) seqCounters.set(taskId, 0);
  }
}

/** 清除当前任务上下文（tool loop 结束时调用）。 */
export function clearCurrentTask(): void {
  currentTaskId = null;
}

/**
 * 记录一次文件变更（写入前调用）。
 *
 * 把旧内容持久化到备份目录，供跨进程回滚读取。
 * 仅在当前 task 上下文存在时生效；无上下文时静默跳过（向后兼容）。
 *
 * @param filePath 即将写入的文件绝对路径
 */
export async function recordMutation(filePath: string): Promise<void> {
  if (!currentTaskId) return;
  const taskId = currentTaskId;

  // 读取写入前的旧内容（null=不存在，undefined=读取失败跳过）
  let oldContent: string | null | undefined;
  try {
    oldContent = await readFile(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      oldContent = null;
    } else {
      logger.warn({ err, filePath, taskId }, 'file-edit-rollback: 读取旧内容失败，跳过备份');
      return;
    }
  }

  const seq = seqCounters.get(taskId) ?? 0;
  seqCounters.set(taskId, seq + 1);

  const record: MutationRecord = { seq, filePath, oldContent };
  try {
    await writeFile(join(getTaskBackupDir(taskId), `${seq}.json`), JSON.stringify(record), 'utf-8');
  } catch (err) {
    logger.warn({ err, filePath, taskId, seq }, 'file-edit-rollback: 持久化备份失败，该次写入不可回滚');
  }
}

/**
 * 读取并排序某 task 的全部备份记录（按 seq 升序）。
 */
async function loadRecords(taskId: string): Promise<MutationRecord[]> {
  const dir = getTaskBackupDir(taskId);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const records: MutationRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, entry), 'utf-8');
      records.push(JSON.parse(raw) as MutationRecord);
    } catch (err) {
      logger.warn({ err, entry, taskId }, 'file-edit-rollback: 读取备份记录失败，跳过');
    }
  }
  return records.sort((a, b) => a.seq - b.seq);
}

/**
 * 按倒序回滚指定 task 的所有文件变更（§13.7「反向回退，按时间倒序」）。
 *
 * 最后写入的最先恢复，保证多次修改同一文件时最终回到原始状态。
 * 跨进程安全：直接操作共享文件系统。
 *
 * @param taskId 要回滚的任务 ID
 * @returns 回滚统计
 */
export async function rollbackTask(taskId: string): Promise<{ restored: number; failed: number }> {
  let records: MutationRecord[];
  try {
    records = await loadRecords(taskId);
  } catch (err) {
    logger.warn({ err, taskId }, 'file-edit-rollback: 加载备份记录失败');
    return { restored: 0, failed: 0 };
  }

  let restored = 0;
  let failed = 0;

  for (let i = records.length - 1; i >= 0; i--) {
    const { filePath, oldContent } = records[i];
    try {
      if (oldContent === null) {
        // 原本不存在 → 删除新建的文件
        await rm(filePath, { force: true });
      } else {
        // 恢复旧内容
        await writeFile(filePath, oldContent, 'utf-8');
      }
      restored++;
    } catch (err) {
      failed++;
      logger.error({ err, filePath, taskId }, 'file-edit-rollback: 恢复失败');
    }
  }

  // 回滚后清理备份目录
  try {
    await rm(getTaskBackupDir(taskId), { recursive: true, force: true });
  } catch {
    // 清理失败不影响回滚结果
  }
  seqCounters.delete(taskId);

  logger.info({ taskId, restored, failed, total: records.length }, 'file-edit-rollback: 回滚完成');
  return { restored, failed };
}

/**
 * 任务正常完成：删除备份目录（无需回滚，释放磁盘）。
 * @param taskId 完成的任务 ID
 */
export async function commitTask(taskId: string): Promise<void> {
  seqCounters.delete(taskId);
  try {
    await rm(getTaskBackupDir(taskId), { recursive: true, force: true });
  } catch {
    // 清理失败不阻塞任务完成
  }
}

/**
 * 查询指定 task 已记录的变更数（供测试 / 调试 / onStop 决策使用）。
 */
export async function getMutationCount(taskId: string): Promise<number> {
  try {
    return (await loadRecords(taskId)).length;
  } catch {
    return 0;
  }
}

/**
 * 检查指定 task 是否有可回滚的变更。
 * onStop hook 据此判断是否需要触发回滚。
 */
export async function hasMutations(taskId: string): Promise<boolean> {
  return (await getMutationCount(taskId)) > 0;
}

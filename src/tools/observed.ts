/**
 * L2 tools — fs 观察态 CAS（骨架篇 §7.5；第七批安全四件之一）。
 *
 * 模型对文件的写意图按「观察态」分派（运行时自动判定，非模型显式传参）：
 *
 *   未读（无观察记录）   → create-if-absent：文件已存在即拒绝（FS_NOT_OBSERVED——
 *                          防覆盖从未见过的内容；先 read 再写）；
 *   读过且在（present）  → replace-if-version：当前 stat 指纹与观察指纹一致才
 *                          允许替换，不符即 FS_VERSION_CONFLICT（丢失更新守卫）；
 *   读过且不在（absent） → create-if-absent：读时不存在、现在出现 = 他方并发
 *                          创建，FS_VERSION_CONFLICT。
 *
 * edit（补丁编辑）额外要求：必须已读过（present），否则 FS_NOT_OBSERVED。
 *
 * 与 fence 正交：fence（可写根 containment）管「允不允许写这里」，CAS 管
 * 「你写的内容是否基于最新观察」——两者都过才落盘。
 */

import { AppError, FS_NOT_OBSERVED, FS_VERSION_CONFLICT } from '../contracts/errors.js';

/** 单文件观察态 */
export interface ObservedState {
  /** present = 读到过内容；absent = 读时文件不存在（此时创建是合法意图） */
  state: 'present' | 'absent';
  /** 观察时的版本指纹（size:mtimeMs）；仅 present 有意义 */
  version?: string;
}

/** 由 stat 产出版本指纹——size 与 mtimeMs 组合，内容变或重写同尺寸都会动 mtime */
export function statVersion(size: number, mtimeMs: number): string {
  return `${size}:${mtimeMs}`;
}

/**
 * 写意图分派结果：
 * - create-if-absent：仅当目标当前不存在才允许写（存在即按码拒绝）；
 * - replace-if-version：仅当当前指纹等于观察指纹才允许写。
 */
export type WriteIntent = { kind: 'create-if-absent' } | { kind: 'replace-if-version'; expectedVersion: string };

/**
 * 按「读前观察态 × 当前盘上状态」分派写意图。
 *
 * @param observed   观察记录（undefined = 从未读过）
 * @param current    当前盘上指纹（undefined = 文件此刻不存在）
 */
export function resolveWriteIntent(
  observed: ObservedState | undefined,
  current: { version: string } | undefined,
): WriteIntent {
  if (!observed) {
    // 从未读过：只允许「不存在即创建」——文件已在盘上且未见过 = 拒绝覆盖
    if (current) {
      throw new AppError(FS_NOT_OBSERVED, `[FS_NOT_OBSERVED] 文件已存在但从未读取过，拒绝覆盖：先 read 观察后再写`);
    }
    return { kind: 'create-if-absent' };
  }
  if (observed.state === 'absent') {
    // 读时不存在：合法意图是创建；若此刻已出现 = 他方并发创建，冲突
    if (current) {
      throw new AppError(
        FS_VERSION_CONFLICT,
        `[FS_VERSION_CONFLICT] 读取时文件不存在，但现在已存在（他方并发创建）：重新 read 后再写`,
      );
    }
    return { kind: 'create-if-absent' };
  }
  // present：指纹一致才替换
  if (!current) {
    throw new AppError(FS_VERSION_CONFLICT, `[FS_VERSION_CONFLICT] 读取后文件已被删除：重新 read 确认意图`);
  }
  if (current.version !== observed.version) {
    throw new AppError(
      FS_VERSION_CONFLICT,
      `[FS_VERSION_CONFLICT] 文件在读取后被修改（观察 ${observed.version} ≠ 当前 ${current.version}）：重新 read 最新版后再写`,
    );
  }
  return { kind: 'replace-if-version', expectedVersion: current.version };
}

/**
 * edit 意图守卫：补丁编辑必须基于「读过且在」的观察（未读/读时不在都拒绝）。
 * 返回 replace-if-version 意图（指纹校验继续走 resolveWriteIntent 的 present 分支
 * 语义——本函数只补「必须已读」这道门）。
 */
export function requireObservedForEdit(
  observed: ObservedState | undefined,
  current: { version: string } | undefined,
): WriteIntent {
  if (!observed || observed.state === 'absent') {
    throw new AppError(
      FS_NOT_OBSERVED,
      `[FS_NOT_OBSERVED] 编辑前必须先 read 目标文件（观察态 ${observed?.state ?? '未读'}不满足补丁编辑前提）`,
    );
  }
  return resolveWriteIntent(observed, current);
}

/** 观察态登记表：canonicalPath → 观察记录（fs 工具族持有，随会话生命周期） */
export class ObservedFiles {
  private readonly files = new Map<string, ObservedState>();

  /** 登记「读到内容」；写成功后的观察回填也走这里（写完即最新观察，立即 stat 产指纹） */
  observePresent(path: string, version: string): void {
    this.files.set(path, { state: 'present', version });
  }

  /** 登记「读时不存在」（后续 create 合法） */
  observeAbsent(path: string): void {
    this.files.set(path, { state: 'absent' });
  }

  get(path: string): ObservedState | undefined {
    return this.files.get(path);
  }

  /**
   * 清空观察登记簿（B12——第十一轮遗漏大扫 20260904-b 勘正：原头注引用
   * 不存在的消费方「fs.ts 跳过冗余 stat」——fs.ts 只读 get() 做写意图
   * 判定，从不 clear；本方法唯一消费方是测试重置。注释承诺实现里不存在
   * 的东西是稳定缺陷族，随手修死）
   */
  clear(): void {
    this.files.clear();
  }
}

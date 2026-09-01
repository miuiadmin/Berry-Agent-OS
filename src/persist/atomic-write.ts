/**
 * L1 persist — 原子写公共件（应用契约篇 §1.5.1(b)，2026-08-23 M2 /reload 纵切兑现）。
 *
 * 纪律：**禁止应用逐个复刻 writeAtomic**（dsh-chat-import 裸 node:fs 复刻原子写反例）
 * ——需要原子写的面（宿主 overlay 写回、Ring 2/3 应用落盘）一律用本件。
 *
 * 双形态（2026-09-02 成熟度扫描 20260901 P1-6 增 Buffer 形）：string 面
 * `writeAtomicFile`（overlay/manifest 等文本态）+ Buffer 面 `writeAtomicBuffer`
 * （首位消费者 = checkpoint blob 仓——快照件的安全网自己必须是原子的）。两形态
 * 共享同一写核，同低频同步定位。
 *
 * 机制：同目录临时文件 → 写入 + fsync → rename 原子替换。进程在任一步中途死：
 * 目标文件要么是完整旧内容、要么是完整新内容，永不留半文件；临时文件残骸至多
 * 一份（下次写不撞名——'wx' 独占 + UUID 后缀）。
 */

import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';

/**
 * 原子写核（两形态共享——string 形经 Buffer 转换归一到本核）。
 * @param path 目标绝对/相对路径（父目录须已存在——目录创建是调用方职责）
 * @param content 全量新内容（整体替换语义，不做追加/局部改写）
 * @param mode 创建权限位（仅作用新建：既有文件 rename 覆盖不改权限）
 */
function writeAtomicCore(path: string, content: Buffer, mode: number): void {
  // 临时文件与目标同目录：rename 跨设备会抛 EXDEV，同目录才保证原子性成立
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    // 'wx' 独占创建：临时文件已存在（理论撞名/上次残骸）即抛错，绝不复用旧临时文件
    const fd = openSync(temp, 'wx', mode);
    try {
      // Buffer 形 writeSync：position 缺省 null = 从当前文件指针接着写（新文件即从头）
      writeSync(fd, content);
      // 先 fsync 再改名：rename 完成后新内容保证已到物理介质（掉电不回退成空文件）
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (err) {
    // 任意一步失败：清掉临时文件（force——半写状态也清），目标文件从未被碰、保持旧内容
    rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * 原子写文件（string 形——overlay 写回等低频小文件场景；高频路径走 write-behind 不走此件）。
 * @param path 目标绝对/相对路径（父目录须已存在——目录创建是调用方职责）
 * @param content 全量新内容（整体替换语义，不做追加/局部改写）
 * @param mode 创建权限位（缺省 0o644；daemon token 等 0600 敏感面显式传 0o600——
 *   仅作用新建：既有文件 rename 覆盖不改权限，0600 面由调用方 boot 时 chmod 收紧兜底）
 */
export function writeAtomicFile(path: string, content: string, mode: number = 0o644): void {
  writeAtomicCore(path, Buffer.from(content, 'utf8'), mode);
}

/**
 * 原子写文件（Buffer 形——二进制落盘场景；首位消费者 = checkpoint blob 仓）。
 * 语义与 string 形全同（同核同纪律），仅内容形态分立。
 * @param path 目标路径（父目录须已存在）
 * @param content 全量新内容（字节态整体替换）
 * @param mode 创建权限位（缺省 0o644）
 */
export function writeAtomicBuffer(path: string, content: Buffer, mode: number = 0o644): void {
  writeAtomicCore(path, content, mode);
}

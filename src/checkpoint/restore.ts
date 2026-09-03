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
 *
 * 恢复全程持 blob 仓共享读锁（第十一轮遗漏大扫 20260904-b A1）：与捕获
 * 同行、与清孤独占互斥——目标 blob 在恢复全程不可被扫删（半事务免疫），
 * 锁内并核验目标 manifest 在场性（缺场即拒——见函数内注）。
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertTargetStable, canonicalize, serializeWrites } from '../tools/fs.js';
import { manifestPath, readBlob, withBlobStoreRead, type CheckpointManifest } from './store.js';
import { listPrunedRelPaths } from './snapshot.js';

/** 恢复报告（回执展示面） */
export interface RestoreReport {
  /** 已恢复文件数 */
  readonly restored: number;
  /** 快照后新建的遗留文件（当前工作区有、目标 manifest 无——报告不删） */
  readonly leftovers: readonly string[];
}

/**
 * 把工作区恢复到目标快照状态（files first 段）。
 * @param workspaceRoot canonical 工作区根
 * @param dataRoot 件数据根（blob 仓所在）
 * @param target 目标快照 manifest
 * @param exclude 排除 glob（与捕获同一拼接全集——遗留检测复用捕获剪枝语义，
 *   遗漏大扫 20260902-c #6，会话篇 §5.3 遗留检测枚举语义条款）
 * @returns 恢复报告（restored + leftovers）
 * @throws 任一 blob 读/写失败——整体失败（调用方不进入 fork 段）
 */
export async function restoreWorkspace(
  workspaceRoot: string,
  dataRoot: string,
  target: CheckpointManifest,
  exclude: readonly string[],
): Promise<RestoreReport> {
  // 恢复全程持 blob 仓共享读锁（第十一轮遗漏大扫 20260904-b A1 修死，会话篇
  // §5.3 裁剪条）：修前恢复是读写锁的唯一无锁消费者——恢复中段（逐路径
  // readBlob 的 await 窗）并发清孤可把目标 manifest 判弃后扫删其独占 blob，
  // readBlob 中途 ENOENT 整体抛错但**部分文件已覆写**（半事务：工作区两不沾
  // 且回执谎称「快照保留」）。持读锁后清孤独占排队到恢复收场，目标 blob 在
  // 恢复全程不可被扫删。锁序与捕获一致（读锁 → 写串行链），无逆向嵌套；
  // /rewind 流程的 guard 捕获（含其尾部清孤）在恢复前顺序收场——无自死锁面。
  return withBlobStoreRead(dataRoot, async () => {
    // 锁内目标 manifest 在场性前置核验（同笔）：/rewind 的清单读取与目标解析
    // 在锁外，选标到恢复起点的窗内目标可已被裁剪（manifest 已删、独占 blob
    // 已扫、共享 blob 仍在）——照跑会共享文件先覆写、独占文件 ENOENT 中止的
    // 半事务。在场性是 blob 生存性的充分条件（读写锁模型不变式：manifest 在
    // 盘 ⇒ 任意已跑清孤的白名单含它 ⇒ 其引用 blob 未被扫删；捕获的 blob 先落
    // 窗在捕获读锁内清孤插不进）——缺场即整体拒，零字节写过、点名已被裁剪。
    await stat(manifestPath(dataRoot, target.sessionId, target.id)).catch(() => {
      throw new Error(
        `目标快照 ${target.id} 已被裁剪（manifest 不在盘面）——恢复未开始、零字节写过；请从 /rewind 清单重选在场快照。`,
      );
    });
    // 写段入 per-canonical-path 写串行链（2026-09-01 遗漏大扫 20260901-c #5，
    // 会话篇 §5.3 前置拒两段收口）：链键 = manifest 路径对 workspaceRoot 的
    // canonical 化——与工具 write/edit 同键同链，宿主内两条写路径在同一物理
    // 路径上零交叠。整批恢复共享同一占位（edit 多路径批同款全序锚）：恢复期间
    // 对任一目标路径的工具写排队在其后，反之亦然——不撕裂、写序可预期。
    // 不存在的路径 canonicalize 回退最近存在祖先再拼回尾部段（与工具写同源
    // ——重建被删文件与新建文件两形态同键）。
    const chainKeys = await Promise.all(target.files.map((entry) => canonicalize(join(workspaceRoot, entry.rel))));
    const leftovers = await serializeWrites(chainKeys, async () => {
      // 逐路径覆写：先建父目录（重建被删文件的目录树），blob 内容写回。
      // 段内目标漂移重验（遗漏大扫 20260902-b #10，会话篇 §5.3 恢复写段条款）：
      // 链键在段外定（T0），段内 readBlob await 撑宽窗口——若目标路径父组件被
      // 链外写者换成指向工作区外的符号链，恢复字节在 open 时重新解析落到链键
      // 与 manifest 都不曾锚定的区外目标（宿主信任级恢复写引出工作区）。每路径
      // writeFile 前重跑 canonicalize 与段外定键值比对、漂移即整体抛错中止
      // （FS_WRITE_TARGET_DRIFTED——快照保留不 fork，既有失败语义同款收场；
      // 与工具写腿同一 assertTargetStable 同一纪律）。
      for (const [i, entry] of target.files.entries()) {
        const abs = join(workspaceRoot, entry.rel);
        const content = await readBlob(dataRoot, entry.hash);
        // 恢复段物理写序（遗漏大扫 20260902-c #8，会话篇 §5.3 恢复段物理写序
        // 条款）：mkdir 同为物理写面受同一漂移重验辖——序恒为「重验 → mkdir →
        // 复验 → writeFile（末次复验与 writeFile 之间零 await）」。修前 mkdir 在
        // 首验之前：readBlob await 撑宽的窗口里父组件被链外写者换成指向工作区外
        // 的符号链（目标目录已存在形）时，mkdir recursive 顺着符号链把目录树建到
        // 区外——文件写虽被随后的重验拒掉，区外目录已留痕。先验再建把目录创建
        // 收进同一漂移裁决辖（mkdir 自身 await 撑开新窗，故建后复验再写）。
        await assertTargetStable(abs, chainKeys[i]!);
        await mkdir(join(abs, '..'), { recursive: true });
        await assertTargetStable(abs, chainKeys[i]!); // 复验与物理写之间零 await
        await writeFile(abs, content);
      }

      // 遗留检测：当前工作区有、目标 manifest 无的路径（快照后新建）——报告不删。
      // 枚举与捕获同一剪枝语义件内单源（遗漏大扫 20260902-c #6，会话篇 §5.3 遗留
      // 检测枚举语义条款）：捕获剪掉的路径（秘密缺省族/gitignore 面）从未入快照
      // 面，当「遗留」点名是误报；skipped 超限跳过路径捕获时已在场，并入已快照
      // 集（超限跳过是披露面不是遗留面）。
      const snapshotted = new Set([...target.files.map((f) => f.rel), ...target.skipped]);
      const current = await listPrunedRelPaths(workspaceRoot, exclude);
      return [...current].filter((rel) => !snapshotted.has(rel)).sort();
    });

    return { restored: target.files.length, leftovers };
  });
}

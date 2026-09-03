/**
 * L3 checkpoint — 快照文件域原语（会话篇 §5.3 快照形态/裁剪条，2026-08-30）。
 *
 * 数据域布局（ctx.paths.appDataDir 行数据根之下；应用代码原生可写——进程内
 * 全权限受信，不经 fence）：
 *
 *   <dataRoot>/blobs/<hash前2位>/<hash全码>   —— sha256 内容寻址仓（跨快照/
 *                                               跨会话天然去重）
 *   <dataRoot>/manifests/<sessionId>/<id>.json —— per-run 快照清单（活集——
 *                                               /rewind 清单与恢复读此）
 *
 * 活集 = 文件、审计 = 事件的分居（§5.3 账的分居条）：manifest 是唯一活集，
 * durable 事件只是审计账——本模块只管文件域，不触会话库。
 *
 * 写入统一走 persist 原子写公共件（2026-09-02 成熟度扫描 P1-6 收编——blob 用
 * Buffer 形 writeAtomicBuffer、manifest 用 string 形 writeAtomicFile；O_EXCL
 * temp + fsync + rename，读者永不见半文件且掉电不回退）——blob 内容寻址不可
 * 变，同 hash 重复写为幂等 no-op；读侧 sha256 复核（文件名即承诺 hash）。
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppLogger } from '../contracts/app.js';
import { AppError, CHECKPOINT_BLOB_CORRUPT } from '../contracts/errors.js';
import { writeAtomicBuffer, writeAtomicFile } from '../persist/index.js';

/** 单文件入快照上限（8 MiB——超限跳过并记入 manifest `skipped` 披露） */
export const MAX_SNAPSHOT_FILE_BYTES = 8 * 1024 * 1024;

/** manifest 文件条目：指纹三元组 + 内容寻址哈希（mode 参与指纹判定；恢复只回放内容不回放 mode——诚实简单 v1） */
export interface ManifestFileEntry {
  /** 工作区相对路径（POSIX 分隔符） */
  readonly rel: string;
  /** 内容 sha256（blob 仓键） */
  readonly hash: string;
  /** 字节数 */
  readonly size: number;
  /** 修改时间毫秒（stat 快径指纹成分——rsync 同界：同尺寸+mtime 回拨的改写盲，§5.3 诚实边界②） */
  readonly mtimeMs: number;
  /** 权限位（指纹成分；v1 不回放） */
  readonly mode: number;
}

/** 快照 manifest（活集单据——一个动手 run 一个回退点） */
export interface CheckpointManifest {
  /** 快照 id（cp-<8hex>——/rewind 寻址键） */
  readonly id: string;
  /** 归属会话 id（manifest 目录键） */
  readonly sessionId: string;
  /** 捕获时刻（毫秒） */
  readonly time: number;
  /** 触发工具名（审计：变更类工具调用；guard 捕获 = '/rewind'） */
  readonly triggerTool: string;
  /** true = /rewind 前的防误退捕获（清单带 ◆ 标；回退到 guard 即撤销上次回退） */
  readonly guard: boolean;
  /** 回退边界（捕获时 lastClosedTurnBoundary——注册表会话可算；子代理会话 null = 不可回退） */
  readonly forkSeq: number | null;
  /** 触发指令文本（回执展示用——截断存储；子代理会话 null） */
  readonly triggerText: string | null;
  /** 文件条目（快照时的指纹全集） */
  readonly files: readonly ManifestFileEntry[];
  /** 超 8 MiB 跳过的相对路径（披露面——恢复时不碰） */
  readonly skipped: readonly string[];
  /** 本快照新写 blob 字节数（存储成本审计——未变引用既有 blob 零新增） */
  readonly newBytes: number;
  /** 工作区快照总字节数（条目 size 之和——体量观测） */
  readonly totalBytes: number;
}

/** 生成快照 id（cp-<8hex>——随机前缀，全局不依赖序号避免并发撞名） */
export function newManifestId(): string {
  return `cp-${randomBytes(4).toString('hex')}`;
}

/** 内容 sha256（blob 仓键） */
export function hashContent(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** blob 文件路径（两级分桶防单目录巨量） */
function blobPath(dataRoot: string, hash: string): string {
  return join(dataRoot, 'blobs', hash.slice(0, 2), hash);
}

/** manifest 文件路径 */
export function manifestPath(dataRoot: string, sessionId: string, id: string): string {
  return join(dataRoot, 'manifests', sessionId, `${id}.json`);
}

/** 确保数据域骨架就位（幂等——blobs/ 与 manifests/ 两目录） */
export async function ensureLayout(dataRoot: string): Promise<void> {
  await mkdir(join(dataRoot, 'blobs'), { recursive: true });
  await mkdir(join(dataRoot, 'manifests'), { recursive: true });
}

/**
 * 写入 blob（内容寻址幂等：目标已存在即 no-op——内容相同无需重写）。
 * 写面统一走 persist 原子写公共件 Buffer 形（O_EXCL temp + fsync + rename——
 * 掉电撕裂防护是快照件的安全网属性，安全网自己必须是原子的；成熟度扫描
 * 20260901 P1-6 收编，会话篇 §5.3 写侧纪律）。返回是否实际落盘（新写计数用）。
 */
export async function writeBlob(dataRoot: string, hash: string, content: Buffer): Promise<boolean> {
  const path = blobPath(dataRoot, hash);
  try {
    await stat(path);
    return false; // 既有 blob：内容寻址命中，零写
  } catch {
    // 不存在——落盘（先建分桶目录）
    await mkdir(join(path, '..'), { recursive: true });
    writeAtomicBuffer(path, content);
    return true;
  }
}

/**
 * 读 blob（恢复路——hash 由 manifest 给出）。读侧 sha256 复核（成熟度扫描
 * 20260901 P1-6，会话篇 §5.3 读侧校验）：内容寻址仓的文件名即承诺 hash，
 * 磁盘内容与其不符（掉电撕裂/外部损坏）时 fail-loud 拒读点名——撕裂数据绝不
 * 静默进恢复面。缺失 blob 仍由 readFile 原生 ENOENT 抛错、调用方如实报告。
 */
export async function readBlob(dataRoot: string, hash: string): Promise<Buffer> {
  const content = await readFile(blobPath(dataRoot, hash));
  if (hashContent(content) !== hash) {
    throw new AppError(
      CHECKPOINT_BLOB_CORRUPT,
      `blob 损坏：内容与文件名承诺 hash 不符（${blobPath(dataRoot, hash)}）——恢复中止、快照保留。处置：删除该 blob 文件后重试（后续捕获重写自愈）`,
    );
  }
  return content;
}

/** 写 manifest（原子写公共件 string 形；目录随建——fsync 纪律同 writeBlob 条） */
export async function writeManifest(dataRoot: string, manifest: CheckpointManifest): Promise<void> {
  const path = manifestPath(dataRoot, manifest.sessionId, manifest.id);
  await mkdir(join(path, '..'), { recursive: true });
  writeAtomicFile(path, JSON.stringify(manifest));
}

/** 删 manifest（prune 执行面——ENOENT 幂等视为成功） */
export async function deleteManifest(dataRoot: string, sessionId: string, id: string): Promise<void> {
  await rm(manifestPath(dataRoot, sessionId, id), { force: true });
}

/**
 * 解析 manifest 文件（形状窄校验——损坏文件跳过不炸清单：返回 undefined）。
 * 损坏必 warn 点名落痕（复盘 E-1）：该快照从 /rewind 清单消失必须有痕——
 * 静默消失 + 随后清孤销毁 blob = 数据面不可审计的永久丢失。
 */
function parseManifest(raw: string, file: string, logger?: Pick<AppLogger, 'warn'>): CheckpointManifest | undefined {
  try {
    const obj = JSON.parse(raw) as Partial<CheckpointManifest>;
    const shapeOk =
      typeof obj.id === 'string' &&
      typeof obj.sessionId === 'string' &&
      typeof obj.time === 'number' &&
      typeof obj.triggerTool === 'string' &&
      typeof obj.guard === 'boolean' &&
      Array.isArray(obj.files);
    if (shapeOk) return obj as CheckpointManifest;
    // 形状不符（缺必填字段）——落到统一损坏出口
  } catch {
    // JSON.parse 失败（截断/半写历史遗留）——落到统一损坏出口
  }
  // 统一损坏出口：单文件损坏不拖垮清单面，但损坏本身必须可见（复盘 E-1——
  // 该快照不可回退，且本轮清孤将进入保护模式）
  logger?.warn(`checkpoint manifest 损坏（跳过，该快照不可回退）：${file}`);
  return undefined;
}

/** 单会话目录读取共核：活集（时间降序）+ 损坏文件名账（复盘 E-1——损坏账驱动清孤保护） */
async function readSessionDir(
  dataRoot: string,
  sessionId: string,
  logger?: Pick<AppLogger, 'warn'>,
): Promise<{ manifests: CheckpointManifest[]; corrupt: string[] }> {
  const dir = join(dataRoot, 'manifests', sessionId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { manifests: [], corrupt: [] }; // 会话从未拍过快照
  }
  const manifests: CheckpointManifest[] = [];
  const corrupt: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const parsed = parseManifest(await readFile(join(dir, name), 'utf8'), name, logger);
    if (parsed !== undefined) manifests.push(parsed);
    else corrupt.push(`${sessionId}/${name}`); // 会话前缀相对名（warn 与损坏账同源键）
  }
  // 时间降序；同 time（毫秒粒度并发）以 id 字典序稳定化
  manifests.sort((a, b) => b.time - a.time || (a.id < b.id ? -1 : 1));
  return { manifests, corrupt };
}

/** 读单会话全部 manifest（时间降序——/rewind 清单与 latest 取用）；目录缺失 = 空数组 */
export async function listSessionManifests(
  dataRoot: string,
  sessionId: string,
  logger?: Pick<AppLogger, 'warn'>,
): Promise<CheckpointManifest[]> {
  return (await readSessionDir(dataRoot, sessionId, logger)).manifests;
}

/** 全局清单视图（prune 消费面，复盘 E-1）：活集 + 损坏账——损坏非空即清孤保护模式 */
export interface ManifestInventory {
  /** 解析成功的活集（prunePlan 输入） */
  readonly manifests: readonly CheckpointManifest[];
  /** 损坏 manifest 文件（会话前缀相对名）——非空即本轮清孤整体跳过（解析失败 ≠ 可删） */
  readonly corruptFiles: readonly string[];
}

/** 读全部会话全部 manifest（prune 面——跨会话 oldest-first 需要全局视图 + 损坏账） */
export async function listAllManifests(dataRoot: string, logger?: Pick<AppLogger, 'warn'>): Promise<ManifestInventory> {
  const root = join(dataRoot, 'manifests');
  let sessionIds: string[];
  try {
    sessionIds = await readdir(root);
  } catch {
    return { manifests: [], corruptFiles: [] };
  }
  const manifests: CheckpointManifest[] = [];
  const corruptFiles: string[] = [];
  for (const sessionId of sessionIds) {
    const view = await readSessionDir(dataRoot, sessionId, logger);
    manifests.push(...view.manifests);
    corruptFiles.push(...view.corrupt);
  }
  return { manifests, corruptFiles };
}

/* ---------- 捕获/清孤读写互斥（遗漏大扫 20260904 #0 改判重构，会话篇 §5.3 裁剪条） ----------
 * 初版执法 = 清孤时点重读 + 在飞捕获注册表（全面复盘 20260903 #1），读后行模型
 * 对并发捕获有两结构性缺口：① 注册表在 sweep 入口一次性快照，决策点跨 await 比对
 * 陈旧集——注册晚于入口的在飞 blob 越守门被删；② 捕获在 sweep 扫描窗内完整收场
 * （blob 与 manifest 全落、注册已注销）——任何「读清单 ∪ 读守门集」的快照组合都
 * 看不见它。现行执法 = per 数据根读写锁统一模型（初版注册表整体退役）：
 *   - 捕获持共享（captureSnapshot 全程——捕获间互相同行，并发是结构常态）；
 *   - 清孤独占且临界段覆盖三步一气：删弃项 manifest → 重读全局清单视图 → 扫删；
 *   - 互斥之下「清单盘面」成为唯一真相源且线性化——清孤起扫前一切在飞捕获已
 *     收场（其 manifest 已入锁内重读的白名单），重读结果不再陈旧。
 * 写者优先（独占申请后新捕获排队，防清孤饿死）；锁为进程内存态（与写串行链自有
 * 边界同判）：双进程共享数据域的残余窗不闭死（§6 多实例「允许双开」的既有边界，
 * 如实挂账）。真孤儿语义不变：捕获失败无 manifest，后续清孤照常回收其 blob。
 */
/** blob 仓读写锁面（共享 = 捕获临界段；独占 = 清孤临界段） */
interface BlobStoreRwLock {
  /** 在读临界段执行（捕获路——互相同行，与独占清孤互斥） */
  withRead<T>(fn: () => Promise<T>): Promise<T>;
  /** 在写临界段执行（清孤路——与一切捕获及其他清孤互斥） */
  withWrite<T>(fn: () => Promise<T>): Promise<T>;
}

/** per 数据根锁表（dataRoot → 锁；进程生命周期同寿——与写串行链自有边界同判） */
const blobStoreLocks = new Map<string, BlobStoreRwLock>();

/** 取（或建）数据根的 blob 仓读写锁（写者优先——队首写者就绪即同步置位再唤醒，无空窗） */
function blobStoreLock(dataRoot: string): BlobStoreRwLock {
  let lock = blobStoreLocks.get(dataRoot);
  if (lock === undefined) {
    // 活跃读者数 / 写临界段进行中旗标 / 挂起写者队列 / 挂起读者队列（FIFO）
    let activeReaders = 0;
    let writerActive = false;
    const waitingWriters: Array<() => void> = [];
    const waitingReaders: Array<() => void> = [];
    // 队首写者就绪即启动：无写者在跑且读者清零才放行（唤醒前同步置 writerActive
    // ——写者续体晚于 resolve 的微任务间隙里新读者/新写者都见「写占中」无空窗）
    const tryStartWriter = (): void => {
      if (writerActive || activeReaders > 0 || waitingWriters.length === 0) return;
      writerActive = true;
      waitingWriters.shift()!();
    };
    lock = {
      async withRead(fn) {
        // 有写者占中或挂起（写者优先——读者不得越过挂起写者，防其饿死）即排队；
        // 唤醒后重查（唤醒 resolve 与本续体之间的微任务间隙可能有新写者入场）
        while (writerActive || waitingWriters.length > 0) {
          await new Promise<void>((resolve) => waitingReaders.push(resolve));
        }
        activeReaders++;
        try {
          return await fn();
        } finally {
          activeReaders--;
          tryStartWriter(); // 末位读者放行队首写者
        }
      },
      async withWrite(fn) {
        const gate = new Promise<void>((resolve) => waitingWriters.push(resolve));
        tryStartWriter(); // 无人在场即刻进临界段；否则等读者清零/前任写者交接
        await gate;
        try {
          return await fn();
        } finally {
          writerActive = false;
          // 交接序：后任写者优先（写链串行防读者插队饿死写者），无后任放行全体读者
          if (waitingWriters.length > 0) tryStartWriter();
          else while (waitingReaders.length > 0) waitingReaders.shift()!();
        }
      },
    };
    blobStoreLocks.set(dataRoot, lock);
  }
  return lock;
}

/** 捕获临界段入口（captureSnapshot 全程持共享——manifest 与 blob 落盘一气） */
export function withBlobStoreRead<T>(dataRoot: string, fn: () => Promise<T>): Promise<T> {
  return blobStoreLock(dataRoot).withRead(fn);
}

/** 清孤临界段入口（executePrune 全程持独占——删 manifest + 重读 + 扫删三步一气） */
export function withBlobStoreWrite<T>(dataRoot: string, fn: () => Promise<T>): Promise<T> {
  return blobStoreLock(dataRoot).withWrite(fn);
}

/**
 * 全量引用计数清孤 blob：扫描 blobs/ 分桶，删掉幸存 manifest 集合不再引用的
 * blob（blob 为多 manifest 共享，引用计数是唯一正确删法——§5.3 裁剪条）。
 * 直连消费面（测试/工具）自持独占；executePrune 已持锁走锁内核免嵌套自死锁。
 */
export function sweepOrphanBlobs(dataRoot: string, survivors: readonly CheckpointManifest[]): Promise<number> {
  return withBlobStoreWrite(dataRoot, () => sweepOrphanBlobsLocked(dataRoot, survivors));
}

/** 清孤内核（调用方须已持该数据根的独占——锁内白名单 = 幸存引用集单源，无第二真相） */
export async function sweepOrphanBlobsLocked(
  dataRoot: string,
  survivors: readonly CheckpointManifest[],
): Promise<number> {
  const referenced = new Set<string>();
  for (const m of survivors) {
    for (const f of m.files) referenced.add(f.hash);
  }
  let removed = 0;
  const blobsRoot = join(dataRoot, 'blobs');
  let buckets: string[];
  try {
    buckets = await readdir(blobsRoot);
  } catch {
    return 0;
  }
  for (const bucket of buckets) {
    const bucketDir = join(blobsRoot, bucket);
    for (const name of await readdir(bucketDir).catch(() => [] as string[])) {
      if (!referenced.has(name)) {
        await rm(join(bucketDir, name), { force: true });
        removed++;
      }
    }
  }
  return removed;
}

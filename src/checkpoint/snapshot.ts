/**
 * L3 checkpoint — 快照捕获引擎 + 裁剪规划（会话篇 §5.3 快照形态/裁剪条，2026-08-30）。
 *
 * 捕获 = 三段：
 *   ① 遍历工作区产指纹集（gitignore-aware DFS——遍历语义与检索族同源；
 *      **语义同源不共享**〔CR-10 裁定〕：v1 各自实现，共享挂真实第三形态需求）；
 *   ② 与上一 manifest 逐路径比对：指纹未变 = 引用既有 blob 零读零写（stat 快径）；
 *      指纹变/新增 = 读内容 sha256 入 blob 仓（内容寻址天然跨快照去重；捕获读
 *      逐路径入写串行链——防兄弟写撕裂中间态永固，遗漏大扫 20260902-b #4）；
 *   ③ 落 manifest + 顺手裁剪（单入口不设第二触发点）。
 *
 * prunePlan = 纯函数（可单测）：每会话 maxSnapshots oldest-first + 全局 blob
 * 软帽跨会话 oldest-first；下界只保**驱动注册表在册会话**的最新一条（CR-8——
 * 子代理等不可达会话不享下界，否则孤儿 manifest 钉住 blob 无界累积）。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ignore from 'ignore';
import { canonicalize, serializeWrites } from '../tools/fs.js';
import {
  MAX_SNAPSHOT_FILE_BYTES,
  hashContent,
  listAllManifests,
  listSessionManifests,
  newManifestId,
  registerInflightCaptureBlob,
  unregisterInflightCaptureBlobs,
  writeBlob,
  writeManifest,
  sweepOrphanBlobs,
  deleteManifest,
  type CheckpointManifest,
} from './store.js';
import type { AppLogger } from '../contracts/app.js';

/** 硬剪枝表（与检索族 PRUNE_DIRS 同值——node_modules/.git 永不可入快照：装机物与 git 对象体量毁快照面；exclude 配置在此之上叠加） */
const PRUNE_DIRS = new Set(['node_modules', '.git']);

/** posix 相对路径工具（工作区跨平台一致键——manifest 存 posix 形） */
function toPosix(p: string): string {
  return p.split('\\').join('/');
}

/** ignore 匹配器类型（ReturnType 推导——与检索族同法，不依赖包类型导出面） */
type IgnoreMatcher = ReturnType<typeof ignore>;

/** 读取 dir 下 .gitignore 并按所在目录前缀化挂上匹配器（规则只作用于所在目录子树）；无文件/读失败静默跳过 */
async function addIgnoreRules(matcher: IgnoreMatcher, dir: string, rootDir: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(join(dir, '.gitignore'), 'utf8');
  } catch {
    return;
  }
  const prefix = toPosix(relative(rootDir, dir));
  const prefixed = prefix ? `${prefix}/` : '';
  const patterns = content
    .split(/\r?\n/)
    .map((line) => prefixIgnorePattern(line, prefixed))
    .filter((line): line is string => line !== null);
  if (patterns.length > 0) matcher.add(patterns);
}

/** gitignore 行前缀化（锚定根去前导 /；否定/转义原样保形——检索族同算法） */
function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#') && !trimmed.startsWith('\\#')) return null;
  let pattern = line;
  let negated = false;
  if (pattern.startsWith('!')) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith('\\!')) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}

/** 指纹条目（walk + stat 产物——与上一 manifest 比对的原料） */
interface FingerPrint {
  rel: string;
  size: number;
  mtimeMs: number;
  mode: number;
}

/**
 * 剪枝感知工作区遍历核（捕获指纹 walk 与遗留检测枚举的件内单源——遗漏大扫
 * 20260902-c #6，会话篇 §5.3 遗留检测枚举语义条款）：DFS 枚举 root 子树全部
 * 普通文件。剪枝 = PRUNE_DIRS 硬表 + exclude 配置规则 + 祖先链 .gitignore
 * （逐目录前缀化挂载）；符号链目录不跟随（Dirent.isDirectory 对符号链 false，
 * 防环）；目录读失败跳过本目录继续其余子树（best-effort——捕获是安全网非账目）。
 */
async function* walkPruned(root: string, exclude: readonly string[]): AsyncGenerator<{ rel: string; abs: string }> {
  const matcher = ignore().add([...exclude]);
  const stack: string[] = [root]; // DFS 显式栈（目录序确定）
  while (stack.length > 0) {
    const dir = stack.pop()!;
    await addIgnoreRules(matcher, dir, root);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // 倒序入栈 + pop 取首 → 名称字典序访问（结果确定）
    const sorted = [...entries].sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of sorted) {
      if (entry.isDirectory()) {
        if (PRUNE_DIRS.has(entry.name)) continue;
        const dirPrefix = toPosix(relative(root, dir));
        const rel = dirPrefix ? `${dirPrefix}/${entry.name}` : entry.name;
        // 目录双测（带/不带尾斜杠）：兼容 `dir/` 与 `dir` 两种规则写法
        if (matcher.ignores(rel) || matcher.ignores(`${rel}/`)) continue;
        stack.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        const rel = toPosix(relative(root, join(dir, entry.name)));
        if (matcher.ignores(rel)) continue;
        yield { rel, abs: join(dir, entry.name) };
      }
    }
  }
}

/**
 * gitignore-aware 工作区遍历：枚举 root 子树全部普通文件的 stat 指纹
 * （walkPruned 核之上叠 stat——剪枝语义见核注释）。
 */
async function walkFingerprints(root: string, exclude: readonly string[]): Promise<FingerPrint[]> {
  const out: FingerPrint[] = [];
  for await (const { rel, abs } of walkPruned(root, exclude)) {
    try {
      const s = await stat(abs);
      out.push({ rel, size: s.size, mtimeMs: s.mtimeMs, mode: s.mode });
    } catch {
      continue; // stat 失败（竞态消失/权限）——跳过该文件
    }
  }
  return out;
}

/**
 * 剪枝感知路径枚举（遗留检测复用捕获同一剪枝语义——遗漏大扫 20260902-c #6，
 * 会话篇 §5.3 遗留检测枚举语义条款）：恢复侧的「快照后新建」清单以此枚举，
 * 与捕获遍历同一 PRUNE_DIRS + exclude + .gitignore 语义单源——捕获剪掉的
 * 路径（秘密缺省族/gitignore 面）绝不在恢复侧作为「遗留」误报（它们从未入
 * 快照面，谈不上「快照后新建」）。
 */
export async function listPrunedRelPaths(root: string, exclude: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for await (const { rel } of walkPruned(root, exclude)) out.add(rel);
  return out;
}

/** 捕获调用面（文件域上下文——件本体组装后传入） */
export interface CaptureContext {
  /** 件数据根（blobs/ + manifests/ 所在） */
  readonly dataRoot: string;
  /** canonical 工作区根（paths.workspaceRoot()——禁 env 猜 cwd） */
  readonly workspaceRoot: string;
  /** 排除 glob（行 config exclude——已填缺省） */
  readonly exclude: readonly string[];
}

/** 捕获元信息（件本体按会话身份算好传入——引擎不触会话库） */
export interface CaptureMeta {
  readonly sessionId: string;
  readonly triggerTool: string;
  readonly guard: boolean;
  /** 回退边界（注册表会话可算；子代理 null） */
  readonly forkSeq: number | null;
  /** 触发指令文本（回执展示；子代理 null） */
  readonly triggerText: string | null;
}

/**
 * 拍一次快照（pre-mutation 语义——监听器先 await 本函数再放行工具）。
 * stat 快径：与上一 manifest 指纹相同的路径零读零写引用既有 blob；变更/新增
 * 读内容 sha256 入仓。超 8 MiB 单文件跳过记 skipped（披露——恢复时不碰）。
 */
export async function captureSnapshot(cx: CaptureContext, meta: CaptureMeta): Promise<CheckpointManifest> {
  const prevList = await listSessionManifests(cx.dataRoot, meta.sessionId);
  const prev = prevList[0]; // 时间降序首 = 最新
  // 上一 manifest 的 rel → 条目索引（指纹比对快查）
  const prevByRel = new Map<string, CheckpointManifest['files'][number]>();
  if (prev !== undefined) {
    for (const f of prev.files) prevByRel.set(f.rel, f);
  }

  const fingerprints = await walkFingerprints(cx.workspaceRoot, cx.exclude);
  const files: CheckpointManifest['files'][number][] = [];
  const skipped: string[] = [];
  let newBytes = 0;
  let totalBytes = 0;
  // 本捕获的在飞登记面（全面复盘 20260903 #1）：decision 时点逐 hash 登记（早于
  // writeBlob），manifest 落盘或异常收尾统一注销（finally 单点——真孤儿照常可回收）
  const inflightHashes: string[] = [];
  try {
    for (const fp of fingerprints) {
      if (fp.size > MAX_SNAPSHOT_FILE_BYTES) {
        skipped.push(fp.rel); // 体量上限跳过（披露面——不静默）
        continue;
      }
      totalBytes += fp.size;
      const prevEntry = prevByRel.get(fp.rel);
      if (prevEntry !== undefined && prevEntry.size === fp.size && prevEntry.mtimeMs === fp.mtimeMs) {
        // stat 快径命中：指纹未变引用既有 blob（零读零写）。快径引用同样入登记面
        //——旧 manifest 可能恰被并发裁掉，此 blob 的存亡此刻只靠注册表护住
        registerInflightCaptureBlob(cx.dataRoot, prevEntry.hash);
        inflightHashes.push(prevEntry.hash);
        files.push({ rel: fp.rel, hash: prevEntry.hash, size: fp.size, mtimeMs: fp.mtimeMs, mode: fp.mode });
        continue;
      }
      // 捕获读入写串行链（遗漏大扫 20260902-b #4，会话篇 §5.3 捕获读条款）：兄弟
      // 会话的工具写正 truncate-then-write 到一半时，链外裸读会把撕裂中间态 hash
      // 进 blob 仓永固——`/rewind` 恢复出从未存在过的半截文件（读侧 sha256 校验
      // 只验 blob 自身完整，防不住源面撕裂）。逐路径短临界段与工具写/恢复写同键
      // 同链互斥（canonical 化与工具写同源；不锁未变化路径——与「不设全工作区
      // 互斥」立场一致）。
      const content = await serializeWrites([await canonicalize(join(cx.workspaceRoot, fp.rel))], () =>
        readFile(join(cx.workspaceRoot, fp.rel)),
      );
      const hash = hashContent(content);
      // decision 时点先登记再落盘：并发的清孤在此刻起即认得这是「正在写」的引用
      registerInflightCaptureBlob(cx.dataRoot, hash);
      inflightHashes.push(hash);
      if (await writeBlob(cx.dataRoot, hash, content)) {
        newBytes += fp.size; // 实际落盘才计新写（既有 blob 命中零新增）
      }
      files.push({ rel: fp.rel, hash, size: fp.size, mtimeMs: fp.mtimeMs, mode: fp.mode });
    }

    const manifest: CheckpointManifest = {
      id: newManifestId(),
      sessionId: meta.sessionId,
      time: Date.now(),
      triggerTool: meta.triggerTool,
      guard: meta.guard,
      forkSeq: meta.forkSeq,
      triggerText: meta.triggerText,
      files,
      skipped,
      newBytes,
      totalBytes,
    };
    await writeManifest(cx.dataRoot, manifest);
    return manifest;
  } finally {
    // 注销必达：成功（manifest 已落盘，后续清孤由时点重读接管）与失败（真孤儿
    // 语义——后续清孤照常回收其 blob）同格收尾
    unregisterInflightCaptureBlobs(cx.dataRoot, inflightHashes);
  }
}

/** 裁剪配置（prunePlan 入参——缺省值由件本体填充） */
export interface PruneOptions {
  readonly maxSnapshots: number;
  readonly maxTotalBytes: number;
}

/**
 * 裁剪规划（纯函数）：给定全部 manifest 与在册会话集，算出应弃清单。
 * 规则两条（§5.3 裁剪条）：
 *   ① 每会话 maxSnapshots——按时间 asc 超出即弃（含不可达会话一视同仁）；
 *   ② 全局 blob 软帽——幸存集唯一引用字节超 maxTotalBytes 时按时间 asc 跨会话
 *      续弃；受保护下界 = 每个在册会话的最新一条（不可达会话不享下界，CR-8；
 *      软帽 = 下界耗尽即止，宁可超帽不自剪成「无快照」）。
 */
export function prunePlan(
  all: readonly CheckpointManifest[],
  opts: PruneOptions,
  activeSessions: ReadonlySet<string>,
): CheckpointManifest[] {
  const drop = new Set<string>();
  // 步①：每会话按时间 asc 排序，超出 maxSnapshots 的旧端全弃
  const bySession = new Map<string, CheckpointManifest[]>();
  for (const m of all) {
    const list = bySession.get(m.sessionId) ?? [];
    list.push(m);
    bySession.set(m.sessionId, list);
  }
  const survivors: CheckpointManifest[] = [];
  for (const list of bySession.values()) {
    list.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
    const overflow = Math.max(0, list.length - opts.maxSnapshots);
    for (let i = 0; i < overflow; i++) drop.add(list[i]!.id);
    survivors.push(...list.slice(overflow));
  }

  // 步②：全局软帽（幸存集内 time asc 续弃；下界 = 在册会话最新一条）
  survivors.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
  // 每会话最新一条（幸存集中该会话 time 最大者）——在册会话的此条受保护
  const newestOfSession = new Map<string, CheckpointManifest>();
  for (const m of survivors) {
    newestOfSession.set(m.sessionId, m); // survivors 已 asc——后写胜 = 最新
  }
  const protectedIds = new Set<string>();
  for (const [sid, m] of newestOfSession) {
    if (activeSessions.has(sid)) protectedIds.add(m.id);
  }

  const usedBytes = (): number => {
    const hashes = new Set<string>();
    let bytes = 0;
    for (const m of survivors) {
      if (drop.has(m.id)) continue;
      for (const f of m.files) {
        if (!hashes.has(f.hash)) {
          hashes.add(f.hash);
          bytes += f.size;
        }
      }
    }
    return bytes;
  };
  while (usedBytes() > opts.maxTotalBytes) {
    // time asc 找首个未弃且未受保护的候选；全在下界即止（软帽语义）
    const victim = survivors.find((m) => !drop.has(m.id) && !protectedIds.has(m.id));
    if (victim === undefined) break;
    drop.add(victim.id);
  }
  return all.filter((m) => drop.has(m.id));
}

/**
 * 执行裁剪：删 manifest + 全量引用计数清孤 blob。
 * 捕获后单入口调用（不设第二触发点）。
 *
 * 清孤竞速收口（全面复盘 20260903 #1，会话篇 §5.3 裁剪条）：幸存集**不采信调用
 * 时点的清单快照**——删完弃项后**时点重读**全局清单视图取当下全集（并发捕获后落
 * 的新 manifest，其引用即时可见），清孤白名单 = 重读幸存集 ∪ 在飞捕获注册表
 * （注册表在 sweepOrphanBlobs 内并——「blob 已落、manifest 未落」窗口的唯一护栏）。
 * 损坏账以重读为准（复盘 E-1 保护形态不变：解析失败 ≠ 可删）。
 */
export async function executePrune(
  dataRoot: string,
  drop: readonly CheckpointManifest[],
  logger?: Pick<AppLogger, 'warn'>,
): Promise<void> {
  for (const m of drop) {
    await deleteManifest(dataRoot, m.sessionId, m.id);
  }
  // 时点重读：幸存面 = 当下盘面全集（弃项已删不在内；并发新落 manifest 即时入册）
  const fresh = await listAllManifests(dataRoot, logger);
  if (fresh.corruptFiles.length > 0) return; // 清孤保护模式（解析失败 ≠ 可删）
  await sweepOrphanBlobs(dataRoot, fresh.manifests);
}

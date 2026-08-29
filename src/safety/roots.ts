/**
 * L3 safety — 可写根唯一推导函数 + carve-out 层叠例外（骨架篇 §7.3，第七批拍板）。
 *
 * writableRoots() 是「workspace-write 档是什么意思」的唯一 home：Seatbelt
 * profile 与进程内 fs fence（tools/fs.ts）都从这里取根列表，两套防线同源
 * 生成、永不漂移。carve-out 在根列表之上叠加按路径层叠的例外条目
 * （.git 转只读 / .env 遮罩 / 嵌套例外），命中走升权审批而非硬失败。
 */

import { readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath, sep } from 'node:path';
import type { SandboxMode, WritableRootsInput } from './types.js';

/** carve-out 例外条目：pattern 相对 workspace（或以 / 起的绝对路径）；层叠=最具体（最长路径）匹配胜出 */
export interface CarveOutEntry {
  /**
   * 路径模式：字面相对路径（`.git`、`src/secrets.json`）或顶层单层 glob
   * （`*.env`、`.env*`——`*` 不跨目录分隔符）。glob 先展开再遮罩：展开时刻
   * 实际存在的文件集合生效，新文件不追溯遮罩（诚实语义）。
   */
  readonly pattern: string;
  /** allow = 在被更浅 deny 覆盖处重新放开（孙再可写）；deny = 遮罩为只读 */
  readonly effect: 'deny' | 'allow';
  /** 条目说明（升权审批 reason 与审计用） */
  readonly note?: string;
}

/**
 * 路径 canonical 化（符号链解析到真实位置）。
 * 解析失败（路径或前缀不存在）原样返回——缺失的根匹配不到任何东西，
 * 正是保守结果；虚构回退路径反而会授权调用方从未指名的位置。
 */
export function canonicalPath(path: string): string {
  try {
    // native 实现按文件系统逐组件查找（与 chdir/spawn 及各强制层一致）；
    // JS 实现在部分平台会先做词法折叠再解析符号链，与强制层判定不一致
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * 按档位推导可写根列表（canonical 化去重）——「某档是什么意思」的唯一 home：
 * - workspace-write：workspace + /tmp + os.tmpdir()；
 * - read-only：空列表（fence 拒全量写——2026-08-25 修订：原实现 mode 无关，
 *   read-only 档 fence 实际不拦写，深读 workflow 实证缺口后 mode 升为一等输入）；
 * - danger-full-access：文件系统根 [sep]（全盘可写——配合 fence 侧 isInside 的
 *   根分隔符特判，'/' 前缀即全命中）。
 * 这是 fs fence 与沙箱 profile（Seatbelt/Bwrap）的共同数据源。
 */
export function deriveWritableRoots(workspace: string, mode: SandboxMode): string[] {
  if (mode === 'read-only') return [];
  if (mode === 'danger-full-access') return [sep];
  return [...new Set([workspace, '/tmp', tmpdir()].map(canonicalPath))];
}

/**
 * external 域（fork 进程载体）的 PM 写白名单**执法基线**变体（契约篇 §1.7
 * 第三十七批增补 4——与 deriveWritableRoots 同族新变体）：workspace ∪ 该行
 * 件数据根（`<dataDir>/apps/<行id>`）。与 workspace-write 档的两点刻意差异：
 * - **不含 /tmp 族**（本批裁定）：全域 tmp 是跨域共享写面——external 分域
 *   语义下给全域 tmp = 域间互见互毁。tmp 需求经子进程 TMPDIR 指向件数据根
 *   内的 per-域子目录（装配面预建——落基线内零新增根，痕迹随行清算）；
 * - 件数据根进基线：external 域的件自有数据（应用清单数据域双键三桶）是
 *   装载承诺的写面——宿主推导恒为执法基线（「单 fence 在能力出口」+
 *   「grants 只收窄不放大」两律同源），应用声明只能在此之上收窄。
 */
export function externalWritableRoots(workspace: string, appDataDir: string): string[] {
  return [...new Set([workspace, appDataDir].map(canonicalPath))];
}

/**
 * external 域行有效白名单**单源推导**（契约篇 §1.7 增补 2c R1 复盘批注记
 * 2026-08-29）：有效白名单 = 执法基线 ∩ 行声明（声明缺席 = 全基线；交集可空
 * = 只读域）。两消费面共取本函数——装载面（舰队 spawn 参数：PM 旗 + OS 层
 * confine writableRoots）与 exec 侧运行期（分域行经 svc-invoke 调宿主 exec 的
 * 间接子进程按行收窄软禁，不吃会话档宽面）。
 * 越基线**拒绝式执法只在装载面**（spawn 前、行进失败清单）；本函数只做交集
 * 不判拒绝——运行期消费面的行必已过装载期闩二，运行期交集不可能越基线
 * （装载面如需拒绝式判据，自行对 `externalWritableRoots` 基线预检，勿在此
 * 混入第二语义）。
 */
export function externalEffectiveRoots(workspace: string, appDataDir: string, declared?: readonly string[]): string[] {
  const baseline = externalWritableRoots(workspace, appDataDir);
  if (declared === undefined) return baseline;
  const normalized = declared.map(canonicalPath);
  return normalized.filter((d) => baseline.some((b) => isInsideRoot(d, b)));
}

/** child 是否位于 root 内（相等或隔分隔符的前缀，防 /root 与 /root-evil 误判；
 * 根为文件系统根 sep（danger-full-access 的全盘根）时任意绝对路径皆命中） */
export function isInsideRoot(child: string, root: string): boolean {
  const prefix = root === sep ? sep : root + sep;
  return child === root || child.startsWith(prefix);
}

/**
 * carve-out 条目展开：pattern → canonical 绝对路径集合。
 * 字面 pattern 直接转绝对；含 `*` 的 pattern 扫描其所在目录层（单层，不
 * 递归）把实际存在的匹配项展开——「glob 先展开再遮罩」。展开结果同时用于
 * 判定表构建与审计输出。
 */
export function expandCarveOutEntry(workspace: string, entry: CarveOutEntry): string[] {
  const dir = entry.pattern.includes('/')
    ? resolvePath(workspace, entry.pattern.slice(0, entry.pattern.lastIndexOf('/')))
    : workspace;
  const leaf = entry.pattern.includes('/') ? entry.pattern.slice(entry.pattern.lastIndexOf('/') + 1) : entry.pattern;
  if (!leaf.includes('*')) {
    // 字面路径：不检查存在性（尚未存在的敏感路径也预先遮罩——.git 在 init 前就该挡）
    return [canonicalPath(resolvePath(workspace, entry.pattern))];
  }
  // 顶层单层 glob：`*` 不跨分隔符，扫描目录层取实际存在的匹配
  const pattern = new RegExp(`^${leaf.replace(/[.+^${}()|[\]\\]/g, String.raw`\$&`).replaceAll('*', '[^/]*')}$`);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => pattern.test(e.name))
      .map((e) => canonicalPath(join(dir, e.name)));
  } catch {
    // 目录不存在：glob 无可展开（字面条目不同——见上）
    return [];
  }
}

/** 展开后的 carve-out 判定节点（路径 → 生效条目；构建时按层叠规则解决冲突） */
export interface CarveOutNode {
  /** canonical 绝对路径（该条目管辖此前缀下的一切） */
  readonly path: string;
  readonly effect: 'deny' | 'allow';
  /** 命中的原始条目（审批 reason 与审计引用） */
  readonly entry: CarveOutEntry;
}

/**
 * 构建 carve-out 判定表：全部条目展开后按「最具体路径胜出」排序
 * （路径段数多者先；同深按 deny 优先——保守）。层叠语义由排序后的
 * 首个前缀匹配实现：父条目宽、子条目窄，孙条目比子条目更窄时赢回。
 */
export function buildCarveOutTable(workspace: string, entries: readonly CarveOutEntry[]): CarveOutNode[] {
  const nodes: CarveOutNode[] = [];
  for (const entry of entries) {
    for (const path of expandCarveOutEntry(workspace, entry)) {
      nodes.push({ path, effect: entry.effect, entry });
    }
  }
  // 最长路径（最深）优先；同路径 deny 胜 allow（保守）；再按 pattern 字典序稳定排序
  return nodes.sort((a, b) => {
    const depth = b.path.split(sep).length - a.path.split(sep).length;
    if (depth !== 0) return depth;
    if (a.effect !== b.effect) return a.effect === 'deny' ? -1 : 1;
    return a.entry.pattern.localeCompare(b.entry.pattern);
  });
}

/** 可写性判定结果 */
export type WritabilityVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** outside-roots = 不在任何可写根内（fence 粗粒度拒绝面）；carve-out = 根内但命中例外遮罩（走升权审批的面） */
      readonly kind: 'outside-roots' | 'carve-out';
      /** carve-out 命中时的条目（审批 reason 引用） */
      readonly matched?: CarveOutNode;
    };

/**
 * 判定一个 canonical 绝对路径在当前策略下的可写性：
 * carve-out 判定表首个前缀命中即为其效果（无命中再看根 containment）。
 * 根 containment 与 carve-out 的顺序保证「根内但被遮罩」判为 carve-out
 * （可升权的面），「根外」判为 outside-roots（fence 的面）——两个拒绝面
 * 词汇不同、去处不同。
 */
export function resolveWritability(
  absPath: string,
  roots: readonly string[],
  carveOut: readonly CarveOutNode[],
): WritabilityVerdict {
  // carve-out 先判：表按最具体优先排序，首个（最深的）前缀命中即生效
  for (const node of carveOut) {
    const inside = absPath === node.path || absPath.startsWith(node.path + sep);
    if (inside) {
      return node.effect === 'deny' ? { allowed: false, kind: 'carve-out', matched: node } : { allowed: true };
    }
  }
  // 根 containment：相等或隔分隔符前缀（防 /root-evil 误判；全盘根见 isInsideRoot）
  const inRoots = roots.some((root) => isInsideRoot(absPath, root));
  return inRoots ? { allowed: true } : { allowed: false, kind: 'outside-roots' };
}

/**
 * 组装 fs 工具族的 writableRoots provider（app 装配层接线：替换 tools/fs
 * 的 M1 过渡默认）。返回的根列表按当前档位推导（mode getter 每次 fence
 * 检查取最新——read-only 空根 / danger 全盘根 / workspace-write 三根），
 * 已 canonical 化，与沙箱 profile 同源。
 */
export function createRootsProvider(input: WritableRootsInput): () => string[] {
  const workspace = canonicalPath(input.workspace);
  return () => deriveWritableRoots(workspace, input.mode());
}

/** 绝对化工具：相对路径锚 workspace、绝对路径原样（供守门行预检用） */
export function absolutize(input: WritableRootsInput, p: string): string {
  const workspace = canonicalPath(input.workspace);
  return canonicalPath(isAbsolute(p) ? resolvePath(p) : resolvePath(workspace, p));
}

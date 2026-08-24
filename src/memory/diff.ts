/**
 * L3 memory — 简报差分追注（记忆篇 §6 完整差分版三件，2026-08-24 第十二批题二）。
 *
 * 题一效用进化让简报权威面在会话进行中漂移（新条目入库 / 引用复活 / 30 天离开 /
 * forget-restore），冻结基线会在长会话里变陈旧。本模块是差分形态的纯函数面：
 *
 * 1. 基线冻结不动：`memory/core` 段照既有语义在重建时点物化——差分永不触发
 *    systemPrompt 重建（prompt cache 前缀稳定是差分形态的全部意义）；
 * 2. 权威变化落 durable 事件：`memory/diff`（surface 类别，todo/write 同族），
 *    data = 全量差分（相对基线，非增量）+ 基线指纹——重放取最后一条即得视图
 *    （last-wins，与 todo/write「全量快照非增量」同构）；
 * 3. 请求尾差分注入 = 日志的纯函数派生：context_transform handler 注入
 *    `memory-diff` 自定义角色消息（与 memory-recall 同族，hidden 不进时间线）。
 *
 * 本文件运行时依赖保持轻量（store 仅类型引用）——check-events 经 jiti 导入
 * 本模块触发词汇注册，不连锁拉起 better-sqlite3。
 */

import { createHash } from 'node:crypto';
import type { SessionEvent } from '../contracts/events.js';
import { registerSessionEventType } from '../session/event-types.js';
import type { MemoryStore } from './store.js';
import type { MemoryKind } from './store.js';
import { shortIdOf } from './id.js';
import { quoteAsCitation, sanitizeForModel } from './scan.js';

/** 差分事件类型词汇（插件显式注册——surface 类别：事实事件 + 派生注入形态） */
export const MEMORY_DIFF_TYPE = 'memory/diff';

// 模块加载时注册词汇（官方件每进程只经宿主注册表 import 一次，无重复注册路径；
// 文件插件 + /reload 的重注册 seam 见记忆篇 §6 落码定稿注记）
registerSessionEventType({ type: MEMORY_DIFF_TYPE, category: 'surface' });

/** 三态操作词汇：'+', '~', and '-' (新增 / 修正 / 撤回——ASCII 编码，规范篇的 '−' 是排版形态) */
export type MemoryDiffOp = '+' | '~' | '-';

/** 差分条目（事件 data.entries 成员）：短 id 与 summary——注入行直接复用引用标记形态 */
export interface MemoryDiffEntry {
  /** 三态：'+', '~', or '-' (新增进入简报 / 内容修正 / 离开简报) */
  readonly op: MemoryDiffOp;
  /** 条目短 id（8 位十六进制——与 [m:短id] 引用标记同面） */
  readonly id: string;
  /** 条目 kind（撤回条目带的是基线时的 kind） */
  readonly kind: MemoryKind;
  /** 条目摘要（'+'/'~' 取当前面摘要，'-' 取基线面摘要——注入面已消毒引述化） */
  readonly summary: string;
}

/** memory/diff 事件载荷：全量差分（相对基线，非增量）+ 基线指纹 */
export interface MemoryDiffData {
  /** 基线指纹（faceFingerprint 产物——纪元身份，重放侧按此归账） */
  readonly baseline: string;
  /** 相对基线的全量差分（空数组 = 收敛清账） */
  readonly entries: readonly MemoryDiffEntry[];
}

/** 简报权威面条目（差分的比较面）：消毒引述化后的 {id, kind, summary} */
export interface FaceEntry {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly summary: string;
}

/**
 * 取简报权威面（基线物化与差分计算的共同面定义——单一事实源）：
 * briefing() 取数 → sanitizeForModel 消毒（secret 命中剔除 / 指令样引述化）。
 * 基线（render 时点）与当前面（handler 每请求）都走本函数——两侧差异即差分。
 * @param store 记忆库 DAO
 * @param ownerKeys 生效归属键（global + 当前项目）
 * @param opts.unusedDays 未用排除阈值天（透传 briefing——插件配置项）
 */
export function briefingFace(
  store: Pick<MemoryStore, 'briefing'>,
  ownerKeys: readonly string[],
  opts: { unusedDays?: number } = {},
): { face: FaceEntry[]; truncated: boolean } {
  const brief = store.briefing(ownerKeys, opts.unusedDays !== undefined ? { unusedDays: opts.unusedDays } : {});
  const sanitized = sanitizeForModel(brief.records);
  const face: FaceEntry[] = sanitized.entries.map((e) => ({
    id: e.record.id,
    kind: e.record.kind,
    summary: e.quoted ? quoteAsCitation(e.record.summary) : e.record.summary,
  }));
  return { face, truncated: brief.truncated };
}

/**
 * 权威面指纹（基线纪元身份）：sha256 over 规范序列化（按 id 排序——次序不敏感：
 * 简报排序随效用分漂移是常态，条目集与内容不变 = 同一面，不该换纪元）。
 * @returns 16 位十六进制前缀（事件内可读；纪元身份碰撞概率可忽略）
 */
export function faceFingerprint(face: readonly FaceEntry[]): string {
  const canonical = [...face]
    .map(({ id, kind, summary }) => ({ id, kind, summary }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

/** 三态排序（确定性输出：'+' → '~' → '-'，同态内按短 id——与库内次序解耦） */
const OP_ORDER: Record<MemoryDiffOp, number> = { '+': 0, '~': 1, '-': 2 };

/**
 * 计算两面差分（纯函数，三态全量——todo/write 同构的非增量语义）：
 * '+' 当前有基线无；'~' 两面都有但 kind/summary 变了；'-' 基线有当前无。
 * 面漂移后回到基线（净变化为零）= 空差分；纯重排 = 空差分（id 集与内容未变）。
 * id 比较用完整 id（唯一键），差分条目携带短 id（注入面与引用标记同形）。
 */
export function diffFaces(baseline: readonly FaceEntry[], current: readonly FaceEntry[]): MemoryDiffEntry[] {
  const baseById = new Map(baseline.map((e) => [e.id, e]));
  const curById = new Map(current.map((e) => [e.id, e]));
  const out: MemoryDiffEntry[] = [];
  for (const [id, cur] of curById) {
    const base = baseById.get(id);
    if (base === undefined) {
      out.push({ op: '+', id: shortIdOf(id), kind: cur.kind, summary: cur.summary });
    } else if (base.kind !== cur.kind || base.summary !== cur.summary) {
      out.push({ op: '~', id: shortIdOf(id), kind: cur.kind, summary: cur.summary });
    }
  }
  for (const [id, base] of baseById) {
    if (!curById.has(id)) {
      out.push({ op: '-', id: shortIdOf(id), kind: base.kind, summary: base.summary });
    }
  }
  return out.sort((a, b) => OP_ORDER[a.op] - OP_ORDER[b.op] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 重放派生视图（纯函数——「重放差分事件即重现同一视图」的证明件）：
 * 取日志中**最后一条** baseline 指纹匹配的 memory/diff 事件，其 entries 即视图。
 * 全量差分语义下最后一条就是全部真相（last-wins 整体替换，非逐条合并）——
 * 收敛清账事件（entries=[]）自然使视图为空。
 * 旧纪元事件（指纹不匹配）自动出局——重建时点新基线物化即账清零。
 * @param events 会话事件日志（任意前缀亦可——只看 memory/diff 族）
 * @param baseline 当前纪元的基线指纹
 */
export function deriveDiffView(events: readonly SessionEvent[], baseline: string): MemoryDiffEntry[] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type !== MEMORY_DIFF_TYPE) continue;
    const data = event.data as Partial<MemoryDiffData> | undefined;
    if (data?.baseline !== baseline) continue;
    return Array.isArray(data.entries) ? (data.entries as MemoryDiffEntry[]) : [];
  }
  return [];
}

/**
 * 两条差分视图是否等价（handler 的追加判据：算出的差分 ≠ 已落账的视图才追加）。
 * 两侧都是确定性排序产物，规范序列化直比即可。
 */
export function sameDiffView(a: readonly MemoryDiffEntry[], b: readonly MemoryDiffEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

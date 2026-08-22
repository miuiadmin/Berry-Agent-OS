/**
 * L1 session — 会话事件日志（会话篇全篇的唯一运行时实现）。
 *
 * Session 类只有 append（含合成事件）：append-only、写入即冻结、物理删除仅
 * 存两处例外（撕裂尾截断 / 批量写失败回滚，均在 persist 物理层）。落盘为零——
 * write-behind 由 persist 订阅活体通知完成，本类不做任何 I/O。
 */

import { randomUUID } from 'node:crypto';
import {
  AppError,
  SESSION_EVENT_TOO_LARGE,
  SESSION_FORK_BOUNDARY_INVALID,
  SESSION_FORMAT_UNSUPPORTED,
  SESSION_SURFACE_OP_INVALID,
  SESSION_WRITE_CONFLICT,
} from '../contracts/errors.js';
import type { SessionEvent, SurfaceOp } from '../contracts/events.js';
import { getSessionEventType } from './event-types.js';
import { deriveMessages } from './derive.js';
import type { ProjectedMessage } from './derive.js';
import { interruptedTurnClosers } from './recover.js';
import type { SyntheticCloser } from './recover.js';
import { deepFreeze, jsonBytes, snapshotJsonValue } from './snapshot.js';

/** 会话血缘 header（sessions 表同构；非 fork 会话 seedLength=0、depth=0） */
export interface SessionHeader {
  readonly sessionId: string;
  /** fork/delegation 种子的源会话 id */
  readonly parentSession?: string;
  /** 种子前缀事件数（含源前缀 + 收尾的 session/end-seed；非 fork = 0） */
  readonly seedLength: number;
  /** 会话来源：用户新建 / fork / 委派 / 恢复 */
  readonly origin: 'user' | 'fork' | 'delegation' | 'resume';
  /** 委派链深度（防无限递归委派的护栏计数） */
  readonly delegationDepth: number;
}

/** 构造参数 */
export interface SessionOptions {
  /** 会话 id（缺省 randomUUID） */
  sessionId?: string;
  /** 种子事件（恢复 loadStored / 已冻结可直接共享引用）；构造时做读侧校验 */
  seed?: readonly SessionEvent[];
  /** origin 缺省 'user'；随 fork/恢复场景显式传入 */
  origin?: SessionHeader['origin'];
  parentSession?: string;
  /**
   * 种子边界显式覆盖（恢复路径用）：种子数组可能长于血缘边界（fork 子会话的
   * 活区事件随种子一起读回），seedLength 仍应以 sessions 表血缘为准。
   * 缺省 = seed.length。
   */
  seedLength?: number;
  delegationDepth?: number;
  /** 单事件 data 体积护栏（字节，默认 64 KiB——会话篇 §1.2 拍板） */
  maxEventBytes?: number;
  /** 活体通知回调（组合根接 ctx.emit('session/event')；观察者异常隔离由 ctx.emit 提供） */
  emit?: (event: SessionEvent) => void;
}

/** append 可选项 */
export interface AppendOptions {
  /** 毫秒时间戳（缺省 Date.now()；合成/测试事件可显式注入保确定性） */
  time?: number;
  /** 携带遮蔽指令（改历史的唯一合法形态） */
  surfaceOp?: SurfaceOp;
  /** 遮蔽溯源：被遮蔽节点 + 依据事件 seq 的完整列表 */
  sourceEventSeqs?: number[];
}

/** 单事件体积护栏默认值：64 KiB */
const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;

export class Session {
  readonly header: SessionHeader;
  /** 事件日志（冻结事件；仅构造与 append 写入，无 update/delete） */
  private readonly log: SessionEvent[] = [];
  private readonly maxEventBytes: number;
  private readonly emitLive?: (event: SessionEvent) => void;
  /** 投影缓存（同长度直接复用；append-only + 遮蔽只增使失效条件简单可靠） */
  private cache: { length: number; messages: ProjectedMessage[] } | null = null;

  constructor(options: SessionOptions = {}) {
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.emitLive = options.emit;
    this.header = {
      sessionId: options.sessionId ?? randomUUID(),
      parentSession: options.parentSession,
      seedLength: options.seedLength ?? options.seed?.length ?? 0,
      origin: options.origin ?? 'user',
      delegationDepth: options.delegationDepth ?? 0,
    };
    if (options.seed && options.seed.length > 0) {
      validateSeed(options.seed);
      // 种子事件已冻结（fork 共享引用 / persist 读出），防御性再冻结一次幂等
      for (const event of options.seed) {
        deepFreeze(event.data);
        this.log.push(event);
      }
    }
  }

  /** 只读事件视图 */
  get events(): readonly SessionEvent[] {
    return this.log;
  }

  /** 当前事件数（= 下一个 seq） */
  get length(): number {
    return this.log.length;
  }

  /**
   * 追加一个事件（append 七步流水线，会话篇 §1.2）：
   * ①单遍 JSON 校验+快照 ②deepFreeze ③validateNext（类型已知性/遮蔽校验/体积护栏）
   * ④push（seq=log.length 强制连续）⑤⑥同步活体通知（persist write-behind 与 UI 订阅）
   * ⑦落盘为零（持久化由 persist 订阅活体事件完成）。
   * @returns 已入库的事件（含分配的 seq）
   */
  append(type: string, data: unknown, options: AppendOptions = {}): SessionEvent {
    // ①单遍校验 + 快照拷贝（getter 双读免疫、非 JSON 值拒绝）
    const snapshot = snapshotJsonValue(data, 'data');
    // ②深冻结快照——日志内事件从此不可变
    deepFreeze(snapshot);

    // ③下一步校验（类型已知性 → 遮蔽校验 → 体积护栏）
    // 写侧对未知类型早拦（读侧同码 SESSION_FORMAT_UNSUPPORTED 整体拒绝）
    const def = getSessionEventType(type);
    if (!def) {
      throw new AppError(SESSION_FORMAT_UNSUPPORTED, `未知事件类型：${type}（未注册且非 ignorable）`);
    }
    if (options.surfaceOp) {
      this.validateSurfaceOp(type, snapshot, options.surfaceOp, options.sourceEventSeqs);
    }
    const size = jsonBytes(snapshot);
    if (size > this.maxEventBytes) {
      throw new AppError(
        SESSION_EVENT_TOO_LARGE,
        `事件 data 体积 ${size}B 超护栏 ${this.maxEventBytes}B（type=${type}）`,
      );
    }

    // ④⑤push：seq = log.length 强制连续 0 起
    const event: SessionEvent = {
      type,
      seq: this.log.length,
      time: options.time ?? Date.now(),
      data: snapshot,
      ...(options.surfaceOp ? { surfaceOp: options.surfaceOp } : {}),
      ...(options.sourceEventSeqs ? { sourceEventSeqs: options.sourceEventSeqs } : {}),
    };
    this.log.push(event);
    this.cache = null; // append-only 但遮蔽语义随新事件变化，统一失效最简可靠

    // ⑥同步活体通知（观察者异常隔离由 ctx.emit 的 per-handler catch 提供；本层不吞装配错误）
    this.emitLive?.(event);
    return event;
  }

  /**
   * 遮蔽校验（会话篇 §2）：
   * - 区间合法：0 ≤ start ≤ end < log.length（遮蔽必须指向已存在节点）
   * - 溯源完整：sourceEventSeqs 必须覆盖 [start,end] 全部 seq，且只能引用更早的 seq
   * - tool/result 的 replace 只能改 content（其余字段须与被遮蔽事件深度相等）
   */
  private validateSurfaceOp(
    type: string,
    newData: unknown,
    op: SurfaceOp,
    sourceEventSeqs: readonly number[] | undefined,
  ): void {
    if (!(op.start >= 0 && op.start <= op.end && op.end < this.log.length)) {
      throw new AppError(
        SESSION_SURFACE_OP_INVALID,
        `遮蔽区间非法：[${op.start},${op.end}]（当前日志长度 ${this.log.length}）`,
      );
    }
    const nextSeq = this.log.length; // 引用只能指向更早的 seq
    const required = new Set<number>();
    for (let seq = op.start; seq <= op.end; seq++) {
      required.add(seq);
    }
    for (const seq of sourceEventSeqs ?? []) {
      if (!(Number.isInteger(seq) && seq >= 0 && seq < nextSeq)) {
        throw new AppError(SESSION_SURFACE_OP_INVALID, `溯源引用了非法 seq：${seq}（须为 0..${nextSeq - 1}）`);
      }
      required.delete(seq);
    }
    if (required.size > 0) {
      throw new AppError(
        SESSION_SURFACE_OP_INVALID,
        `溯源不完整：sourceEventSeqs 未覆盖被遮蔽区间 seq ${[...required].sort((a, b) => a - b).join(', ')}`,
      );
    }
    // tool/result 的 replace 限定只能改 content（toolCallId/error/meta 均不得变）
    if (type === 'tool/result') {
      if (op.start !== op.end) {
        throw new AppError(SESSION_SURFACE_OP_INVALID, 'tool/result 的 replace 只能遮蔽单个事件');
      }
      const oldEvent = this.log[op.start]!;
      if (oldEvent.type !== 'tool/result') {
        throw new AppError(SESSION_SURFACE_OP_INVALID, 'tool/result 的 replace 目标必须是 tool/result 事件');
      }
      const oldData = oldEvent.data as Record<string, unknown>;
      const next = newData as Record<string, unknown>;
      for (const key of new Set([...Object.keys(oldData), ...Object.keys(next ?? {})])) {
        if (key === 'content') {
          continue;
        }
        if (!deepEqual(oldData[key], next?.[key])) {
          throw new AppError(SESSION_SURFACE_OP_INVALID, `tool/result 的 replace 只能改 content（${key} 不允许变化）`);
        }
      }
    }
  }

  /**
   * 模型历史投影（缓存复用；纯函数转换见 derive.ts——单一转换源，此处仅缓存层）。
   */
  deriveMessages(): ProjectedMessage[] {
    if (this.cache && this.cache.length === this.log.length) {
      return this.cache.messages;
    }
    const messages = deriveMessages(this.log);
    this.cache = { length: this.log.length, messages };
    return messages;
  }

  /**
   * 中断恢复（会话篇 §4）：计算 closers 并经 append 提交（合成事件与普通事件无形态差异）。
   * 幂等：闭合日志第二遍调用不追加任何事件。
   * @returns 本次追加的合成事件（空数组 = 日志本就闭合）
   */
  recoverFromInterruption(): SessionEvent[] {
    const closers: SyntheticCloser[] = interruptedTurnClosers(this.log);
    const appended: SessionEvent[] = [];
    for (const closer of closers) {
      appended.push(this.append(closer.type, closer.data, { time: closer.time }));
    }
    return appended;
  }

  /**
   * fork 种子（会话篇 §5）：以 [0, boundary) 前缀为种子建新会话，
   * 种子收尾追加 session/end-seed 标记边界，读侧 consumers 从 seedLength 起读活区。
   * 注意：子会话默认不继承父 emit——父 emit 闭包捕获的是父实例，继承会让子会话
   * 事件写进父的观察者/队列（实测即 cursor 断裂）；持久化接线由 Persistence.forkSession 注入。
   * @param opts.boundary 种子边界（缺省 = 当前日志全长，快照式 fork）
   * @param opts.emit 子会话活体通知回调（持久化门面注入自引用接线）
   * @throws AppError SESSION_FORK_BOUNDARY_INVALID 边界落在敞开 turn 内或越界
   */
  fork(
    opts: {
      boundary?: number;
      sessionId?: string;
      origin?: 'fork' | 'delegation';
      emit?: (event: SessionEvent) => void;
    } = {},
  ): Session {
    const boundary = opts.boundary ?? this.log.length;
    if (!(Number.isInteger(boundary) && boundary >= 0 && boundary <= this.log.length)) {
      throw new AppError(SESSION_FORK_BOUNDARY_INVALID, `边界越界：${boundary}（日志长度 ${this.log.length}）`);
    }
    // 边界必须落在 turn 闭合之后——扫前缀计 turn/start 与 turn/end 的差值
    let open = 0;
    for (let i = 0; i < boundary; i++) {
      const t = this.log[i]!.type;
      if (t === 'turn/start') open++;
      else if (t === 'turn/end') open--;
    }
    if (open !== 0) {
      throw new AppError(SESSION_FORK_BOUNDARY_INVALID, `边界 ${boundary} 落在敞开 turn 内（须落在 turn 闭合之后）`);
    }
    // 种子收尾标记：end-seed 占据 seq=boundary，位置即边界；种子里不发活体通知（历史不重播）
    const endSeed: SessionEvent = Object.freeze({
      type: 'session/end-seed',
      seq: boundary,
      time: this.log[boundary - 1]?.time ?? Date.now(),
      data: deepFreeze({}),
    });
    // 完整种子 = 源前缀（共享冻结引用）+ 边界标记；构造时 seedLength 自动 = boundary + 1
    const child = new Session({
      sessionId: opts.sessionId,
      seed: [...this.log.slice(0, boundary), endSeed],
      origin: opts.origin ?? 'fork',
      parentSession: this.header.sessionId,
      delegationDepth: this.header.delegationDepth + (opts.origin === 'delegation' ? 1 : 0),
      // 不传 this.emitLive：父闭包捕获父实例，继承 = 子事件写进父队列（见上注释）
      emit: opts.emit,
      maxEventBytes: this.maxEventBytes,
    });
    return child;
  }
}

/**
 * 种子读侧校验（恢复路径 loadStored 的会话侧半边）：
 * seq 强制连续 0 起；未知类型且非 ignorable → SESSION_FORMAT_UNSUPPORTED 整体拒绝。
 */
function validateSeed(seed: readonly SessionEvent[]): void {
  for (let i = 0; i < seed.length; i++) {
    const event = seed[i]!;
    if (event.seq !== i) {
      throw new AppError(SESSION_WRITE_CONFLICT, `种子 seq 断裂：位置 ${i} 的事件 seq=${event.seq}`);
    }
    const def = getSessionEventType(event.type);
    if (!def && !event.ignorable) {
      throw new AppError(SESSION_FORMAT_UNSUPPORTED, `未知事件类型：${event.type}（seq=${event.seq}，非 ignorable）`);
    }
  }
}

/** 结构化深度相等（遮蔽校验用；只处理纯 JSON 值域） */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) {
    return false;
  }
  for (const key of ak) {
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

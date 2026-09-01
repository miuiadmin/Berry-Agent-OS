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
import { createFoldState, stepFold, snapshotProjection, occludedSeqs } from './derive.js';
import type { FoldState, ProjectedMessage } from './derive.js';
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
  /**
   * 会话来源：用户新建 / fork / 委派 / 恢复 / 导入。
   * 闭集管理（会话篇 §5.1）：应用不可自定义——服务面 createSession 无 origin 参数
   * （钉死 'import'）、fork 面钉死 'fork'，四值各自宿主写点，结构上无入参面。
   */
  readonly origin: 'user' | 'fork' | 'delegation' | 'resume' | 'import';
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

/**
 * 投影增量缓存形状（deriveMessages / projectedJsonChars 共同底账，会话篇
 * §3.1 增量推进落码注记——2026-09-01 遗漏大扫 O-6 兑现）。
 */
interface FoldCache {
  /** 活体折算状态：推进到 foldedUpto；openAssistant 活缓冲只在发布拷贝时冲刷（缓冲仍可收迟到 tool/call） */
  readonly state: FoldState;
  /** 遮蔽 seq 集（代际重建时从全日志 surfaceOp 重建；无新遮蔽则增量路径零维护） */
  occluded: Set<number>;
  /** state 已折算到的事件数（= log.length 快照；落后即待推进） */
  foldedUpto: number;
  /** 发布物（拷贝数组——未推进时复用同一引用，O(1) 读） */
  published: ProjectedMessage[] | null;
  /** 发布物 JSON 字符总长（= JSON.stringify(published).length，全等式增量维护） */
  publishedChars: number;
  /** state.messages 已计字符的条数前缀（冲刷进活数组即定格，按条恰计一次） */
  countedUpto: number;
  /** state.messages[0..countedUpto) 各条 JSON.stringify 长度和 */
  sumLens: number;
}

export class Session {
  readonly header: SessionHeader;
  /** 事件日志（冻结事件；仅构造与 append 写入，无 update/delete） */
  private readonly log: SessionEvent[] = [];
  private readonly maxEventBytes: number;
  private readonly emitLive?: (event: SessionEvent) => void;
  /**
   * 投影增量缓存（§3.1 增量推进 + §10#5「首发纯内存增量缓存」）：读时惰性推进
   * ——append 零缓存动作（每事件在下次读时恰折一次 O(new)），surfaceOp 代际
   * 失效见 advanceFold 注记。
   */
  private fold: FoldCache | null = null;

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
    // 写侧对未知类型早拦（读侧同码 SESSION_FORMAT_UNSUPPORTED 整体拒绝）。
    // ignorable 盖章纪律（2026-08-23 生态读码补钉 dsh-1）：向前兼容位唯一生产者 =
    // 事件类型注册项——注册即写入许可，append 按注册表统一盖章；调用者不能手填、
    // 不存在「写侧偶尔忘记 ignorable」的口子（泛化教训：每个向前兼容位必须在
    // 写路径有一个确定性生产者）。
    const def = getSessionEventType(type);
    if (!def) {
      throw new AppError(
        SESSION_FORMAT_UNSUPPORTED,
        `未知事件类型：${type}（未注册——注册即写入许可，向前兼容在注册项声明 ignorable）`,
      );
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

    // ④⑤push：seq = log.length 强制连续 0 起；ignorable 由注册表盖章（见上）
    const event: SessionEvent = {
      type,
      seq: this.log.length,
      time: options.time ?? Date.now(),
      data: snapshot,
      ...(def.ignorable ? { ignorable: true } : {}),
      ...(options.surfaceOp ? { surfaceOp: options.surfaceOp } : {}),
      ...(options.sourceEventSeqs ? { sourceEventSeqs: options.sourceEventSeqs } : {}),
    };
    this.log.push(event);
    // append 零缓存动作：增量缓存读时惰性推进（advanceFold），失效判定集中在读侧

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
    // 配对不切断断言（会话篇 §2 边缘纪律 1——切点永不落在 tool 配对中间）：
    // 区间首事件是 tool/result ⇒ 其配对 tool/call（紧邻前一事件）必在区间外 = 切断；
    // 区间末事件是 tool/call ⇒ 其配对 tool/result（紧邻后一事件）必在区间外 = 切断。
    // 恢复时投影出无 result 的 call / 无 call 的 result 都是 loop 侧必炸形态
    // （pi 出生 7 天重写的直接教训）——宿主级不变式，任何遮蔽写者统一受保护。
    // 豁免：type==='tool/result' 的单点自遮蔽 replace 是既有合法特例（下方
    // 「只改 content」校验全权管辖——op.start 即 op.end 即目标本身，非切断）。
    if (type !== 'tool/result' && this.log[op.start]!.type === 'tool/result') {
      throw new AppError(
        SESSION_SURFACE_OP_INVALID,
        `遮蔽区间起点 seq ${op.start} 是 tool/result——切断了 tool 配对（区间应整体含入或排除配对，边缘纪律 1）`,
      );
    }
    if (this.log[op.end]!.type === 'tool/call') {
      throw new AppError(
        SESSION_SURFACE_OP_INVALID,
        `遮蔽区间终点 seq ${op.end} 是 tool/call——切断了 tool 配对（区间应整体含入或排除配对，边缘纪律 1）`,
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
   * 增量缓存（§3.1 增量推进落码注记 + §10#5）：日志未推进时返回**同一引用** O(1)
   * ——引用稳定性是锁定的可观察契约（session.test.ts 回归锁，遗漏大扫 20260901 O-6）。
   */
  deriveMessages(): ProjectedMessage[] {
    return this.advanceFold().published!;
  }

  /**
   * 投影 JSON 字符总长（compaction 阈值判据底账）：恒等于
   * JSON.stringify(deriveMessages()).length，但按严格可加性增量维护
   * （公式见 advanceFold 尾注），不随读频全量 stringify。
   */
  projectedJsonChars(): number {
    return this.advanceFold().publishedChars;
  }

  /**
   * 折算推进（读时惰性，四步）：
   * ①O(1) 命中：foldedUpto === log.length 且已发布 → 原样复用（引用与字符双 O(1)）。
   * ②代际失效判定：冷启动（fold 为空）或新段含 surfaceOp 事件 → 全量重建。
   *   遮蔽只能指回更早 seq（validateSurfaceOp 保证），增量步进无法回溯摘除已折
   *   节点，故遇新遮蔽整体清态重折——仍走 stepFold 同一转换函数（单一转换源不破）。
   *   「从遮蔽起点重折」的精化形挂 checkpoint 持久化批（§3.1 注记），v1 取退化形。
   * ③增量步进：foldedUpto..log.length 逐事件 stepFold（新段事件不可能命中旧遮蔽
   *   ——遮蔽只指向更早 seq；判定照做求统一），每事件恰折一次 O(new)。
   * ④发布：snapshotProjection 拷贝发布（pending assistant 缓冲冲刷进**拷贝**，活缓冲
   *   继续收迟到 tool/call）；字符按可加性维护——
   *   JSON.stringify(arr).length = 2 + Σ len(JSON.stringify(item)) + (n-1)
   *   sumLens 只累计已冲刷条目（冲刷即定格、条目从此不变），pending 条目每次发布
   *   现算（缓冲跨发布可增，不缓存）。
   */
  private advanceFold(): FoldCache {
    const upto = this.log.length;
    let fold = this.fold;
    if (fold && fold.foldedUpto === upto && fold.published) {
      return fold; // ①命中：引用与字符都不动
    }
    // ②代际失效：冷启动或新段携带 surfaceOp → 整体重建（occludedSeqs 全日志重建遮蔽集）
    let rebuild = !fold;
    for (let i = fold?.foldedUpto ?? 0; i < upto; i++) {
      if (this.log[i]!.surfaceOp) {
        rebuild = true;
        break;
      }
    }
    if (rebuild) {
      const occluded = occludedSeqs(this.log);
      const state = createFoldState();
      for (const event of this.log) {
        if (!occluded.has(event.seq)) {
          stepFold(state, event);
        }
      }
      this.fold = fold = this.publish({
        state,
        occluded,
        foldedUpto: upto,
        published: null,
        publishedChars: 0,
        countedUpto: 0,
        sumLens: 0,
      });
      return fold;
    }
    // ③增量步进：新事件逐个折入活态（不可达遮蔽，判定照做）
    fold = fold!;
    for (let i = fold.foldedUpto; i < upto; i++) {
      const event = this.log[i]!;
      if (!fold.occluded.has(event.seq)) {
        stepFold(fold.state, event);
      }
    }
    fold.foldedUpto = upto;
    // ④发布（就地更新 published/publishedChars 并返回同一缓存对象）
    this.fold = this.publish(fold);
    return this.fold;
  }

  /**
   * 发布步进后的缓存（就地更新 fold 并返回）：推进前缀字符计数（已冲刷条目
   * 恰计一次）→ 生成发布拷贝 → 按可加式合成总长。
   */
  private publish(fold: FoldCache): FoldCache {
    const msgs = fold.state.messages;
    for (let i = fold.countedUpto; i < msgs.length; i++) {
      fold.sumLens += JSON.stringify(msgs[i]!).length;
    }
    fold.countedUpto = msgs.length;
    fold.published = snapshotProjection(fold.state);
    const n = fold.published.length;
    // pending 条目（若有）只在拷贝尾——每次发布现算，不缓存
    const pendingLen = n > msgs.length ? JSON.stringify(fold.published[n - 1]!).length : 0;
    fold.publishedChars = n === 0 ? 2 : 2 + fold.sumLens + pendingLen + (n - 1);
    return fold;
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

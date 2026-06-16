/**
 * 任务板投影辅助层（架构升级 16.0 P4）—— fire-and-forget 落板封装。
 *
 * 设计文档/23 §9 P4 验收：板可建、可指派、可附成果。
 * 本模块集中所有「在现有派发/结果/审核路径上加 board 信封落板」逻辑，
 * 避免散落补丁（CLAUDE.md「补丁过多即重构」）。
 *
 * 核心原则：
 *   - 所有调用 fire-and-forget（try/catch + logger.debug，失败 no-op）
 *   - 现有派发/审核/结果主路径零回归——板只 insert 不读，delegation state 机仍是权威
 *   - 这一阶段建立「板可信」——后续 P3 才敢把触发入口迁过来
 *
 * 4 个 helper（对应 doc23 §3.3 收敛表的 4 个核心映射）：
 *   - postDelegateEnvelope：派发点落 delegate 信封
 *   - postReportEnvelope：结果/审核点落 report 信封
 *   - postSystemReportEnvelope：系统兜底失败落 from:'system' report
 *   - safePost：通用 try/catch 包装
 */

import { getDb } from '../memory/db.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import { metrics } from '../observability/metrics.js';
import { getEventBus } from './event-bus.js';
import {
  postBoardMessage,
  initBoard,
  addBoardMember,
  updateBoardMeta,
  getBoardMeta,
  getBoardContext,
  applyBoardStatus,
  transferLeadership,
  createSubBoard,
  setBoardLineage,
} from './board-repo.js';
import { peekBlockCollector } from './block-collector.js';
import type { BoardMessage, BoardStatusEvent } from '../contracts/board-message.js';
import type { Block, DelegationBlock } from '../contracts/message-blocks.js';
import { routeGovernance } from './flows/governance-switch.js';

const logger = getLogger('board-projection');

/**
 * 通用落板包装：所有投影统一经此。
 *
 * P5 同步必达前置（权威路径可观测化）：DB 写入（postBoardMessage，better-sqlite3 同步写——本身可靠）
 * 是 board 权威路径，失败须**可见（warn + metric）**，不再 debug 静默吞——P5 权威切换后 board 写失败
 * = 权威丢失（须告警），审计影子期也不应无声丢。UI emit（board.message.posted / task_progress 投影）
 * 是 best-effort（前端可刷新拉历史补救），单独 try/catch，不与权威路径耦合。
 *
 * 不抛异常——派发/审核主路径零回归（board 仍是审计影子，写失败不阻塞主路径，但可观测）。
 */
function safePost(taskId: string, build: () => BoardMessage, label: string): void {
  let msg: BoardMessage;
  try {
    msg = build();
  } catch (err) {
    // 信封构造失败（罕见，如 redact 异常）——warn + metric，不入 emit
    logger.warn({ err, taskId, label }, `board-projection: ${label} 构造信封失败`);
    metrics.counter('board_projection_failed_total').inc({ label, phase: 'build' });
    return;
  }
  // ── board DB 写入（权威路径）：失败 warn + metric，不再静默吞 ──
  try {
    postBoardMessage(taskId, msg);
  } catch (err) {
    logger.warn({ err, taskId, label }, `board-projection: ${label} 落库失败（board 权威路径；P5 切换后此失败=权威丢失，须告警）`);
    metrics.counter('board_projection_failed_total').inc({ label, phase: 'write' });
    return; // 落库失败则不 emit（board 没落，emit 投影无意义）
  }
  // ── UI emit（best-effort）：board.message.posted（WsEventBridge 转发前端）+ task_progress 投影。
  // 注：不在此派生 delegation.*（delegation-manager 是当前权威源，直 emit；P5 切换后由 deriveDelegationEventFromBoardMessage 派生）。
  try {
    emitBoardMessagePosted(taskId, msg);
    emitTaskProgressForBoard(taskId);
  } catch (err) {
    // UI 投影失败不影响 board 权威（前端可刷新拉历史补救）——debug 即可
    logger.debug({ err, taskId, label }, `board-projection: ${label} emit 失败（UI best-effort，不影响 board 权威）`);
  }
}

/**
 * P5-C2：emit 'board.message.posted' 事件（WsEventBridge 订阅后转发前端）。
 *
 * fire-and-forget：emit 失败仅 debug 日志（board 已落库是事实，前端刷新失败可下次拉历史补救）。
 * 字段从已落板的 msg 里取，保证与 task_thread 表内容一致（单一事实源）。
 */
function emitBoardMessagePosted(taskId: string, msg: BoardMessage): void {
  try {
    const bus = getEventBus();
    // messageType 是 BoardMessage 判别联合的 type 字段（'delegate'|'report'|'ask'|...），
    // 与 EventMap['board.message.posted'].messageType 字面量联合完全对齐。
    bus.emit('board.message.posted', {
      taskId,
      sessionId: msg.sessionId,
      messageType: msg.type,
      messageId: msg.id,
      from: msg.from,
      to: msg.to,
    });
  } catch (err) {
    // emit 失败不影响 board 落板主路径（fire-and-forget，前端可经拉历史补救）
    logger.debug({ err, taskId, messageType: msg.type }, 'board-projection: emit board.message.posted 失败（不影响主路径）');
  }
}

/**
 * 从 board 状态派生任务进展卡的字段（goal/status/leader/members/turnCount/activitySummary）。
 * §14.5：live emit（emitTaskProgressForBoard）与 timeline 刷新重建（api-routes 富化）共用此推导——
 * 单一事实源，避免两处 task_progress 派生逻辑分叉。无 board / 失败 → null。
 */
export function deriveTaskProgressFromBoard(taskId: string): {
  goal: string;
  status: string;
  leader?: string;
  members: string[];
  turnCount: number;
  maxTurns: number;
  spawnDepth: number;
  activitySummary: string;
} | null {
  try {
    const ctx = getBoardContext(taskId, 10);
    if (!ctx) return null;
    // 用 governance-switch.routeGovernance 分类近期消息为治理类别（让任务卡显示治理视图，
    // 也让 governance-switch 非闲置——P3 单一 switch 路由真正被消费）
    const counts = { gate: 0, review: 0, escalate: 0, command: 0, none: 0 };
    for (const m of ctx.recentMessages) {
      const route = routeGovernance(m);
      if (route.kind === 'gate') counts.gate++;
      else if (route.kind === 'review') counts.review++;
      else if (route.kind === 'escalate' || route.kind === 'peer_help') counts.escalate++;
      else if (route.kind === 'command') counts.command++;
      else counts.none++;
    }
    return {
      goal: ctx.meta.goal ?? '(无目标)',
      status: ctx.meta.boardStatus,
      leader: ctx.meta.leader ?? undefined,
      members: ctx.members.map((mem) => mem.agentId),
      turnCount: ctx.meta.turnCount,
      maxTurns: ctx.meta.maxTurns,
      spawnDepth: ctx.meta.spawnDepth,
      activitySummary: `${counts.gate}工具闸 ${counts.review}审核 ${counts.command}纠偏 ${counts.escalate}求助 ${counts.none}发言`,
    };
  } catch {
    return null;
  }
}

/**
 * §14.5 任务进展卡投影：board 活动 → deriveTaskProgressFromBoard →
 * peekBlockCollector(taskId).onTaskProgress emit（collector 知道 messageId，桥接 board→chat 消息块）。
 * live-only fire-and-forget：无 collector（非 board 或已 dispose）静默跳过，失败 no-op。
 */
function emitTaskProgressForBoard(taskId: string): void {
  const collector = peekBlockCollector(taskId);
  if (!collector) return; // 无 collector = 无关联 chat 消息，跳过（非 board 路径或板已 dispose）
  const opts = deriveTaskProgressFromBoard(taskId);
  if (opts) collector.onTaskProgress(opts);
}

/**
 * §14.5 timeline 刷新重建：对含 delegation 块的消息，从 board 状态重建 task_progress 块追加到 blocks。
 * task_progress 是 board 的 upsert 投影（不入 append-only timeline 持久化），刷新时从此处重建——
 * 让用户刷新对话后任务进展卡仍可见（board 是持久事实源，卡是派生视图）。
 *
 * 链接：DelegationBlock.id = board taskId（派发时 delegation.id 即板 id）。
 * 幂等：消息已含 task_progress（不应有，live-only）则跳过。无 board / 无 delegation 块 → 跳过。
 */
export function enrichTimelineWithTaskProgress<T extends { id: string; blocks?: Block[] }>(messages: T[]): T[] {
  for (const msg of messages) {
    const blocks = msg.blocks;
    if (!blocks || blocks.length === 0) continue;
    if (blocks.some((b) => b.type === 'task_progress')) continue; // 幂等：已有 task_progress 则跳过
    // 找首个 delegation 块（其 id = board taskId）→ 据板状态重建 task_progress 卡
    const deleg = blocks.find((b): b is DelegationBlock => b.type === 'delegation');
    if (!deleg) continue;
    const opts = deriveTaskProgressFromBoard(deleg.id);
    if (!opts) continue; // 无 board（任务未建板或板已清）→ 不重建
    blocks.push({ type: 'task_progress', id: `${msg.id}#taskprog`, ...opts });
  }
  return messages;
}

// ─── delegate 投影：派发点落「指派」信封 ───

export interface DelegateEnvelopeOpts {
  /** 派发者（当前 brain，future leader agentId） */
  from: string;
  /** 被指派的目标 agent */
  to: string;
  /** 子任务目标 */
  subTaskGoal: string;
  /** 会话 id */
  sessionId?: string;
  /** 父板 id（子任务递归，顶层空） */
  parentTaskId?: string;
  /** active_scope（allowTools/blockTools/allowPaths，§5.5 继承） */
  scope?: Record<string, unknown>;
  /** 整任务交接（§12 注：handoff 特例，true 时换板 leader = opts.to） */
  transferLeadership?: boolean;
  /** 辩论模式（§5.7：leader 显式开启板内辩论子区，≥2 agent 对抗产出方案） */
  mode?: 'debate';
  /** 辩论收敛条件（mode='debate' 时必填：rounds N 轮后停 / converged 达成一致 / judge 裁决） */
  debateConfig?: { rounds?: number; converged?: boolean; judge?: string };
}

/**
 * 派发点投影：initBoard（幂等）+ addMember + postBoardMessage(delegate)。
 * 在 delegationManager.create 返回 taskId 之后、ipc.send('agent.task') 之前调用。
 * 幂等：重复调同一 taskId 安全（initBoard UPDATE + addMember INSERT OR IGNORE + postBoardMessage 追加）。
 */
export function postDelegateEnvelope(taskId: string, opts: DelegateEnvelopeOpts): void {
  safePost(taskId, () => {
    // P5 board-existence：dm.create 已基础 init board（created）——此处若已存在则不重 init（避免重置 status）。
    if (!getBoardMeta(taskId)) {
      initBoard(taskId, {
        goal: opts.subTaskGoal,
        leader: opts.from,
      });
    }
    // lineage 总是设（即使 board 已由 dm.create 基础 init）——sub-board 的 parent/spawn 不能因 board 已存在而漏。
    // setBoardLineage 单独 UPDATE parent_task_id + spawn_depth，不重置 board_status（initBoard 会重置，故分开）。
    if (opts.parentTaskId) {
      setBoardLineage(taskId, opts.parentTaskId, 1);
    }
    addBoardMember(taskId, opts.to, 'member');
    // 板状态 created → in_progress（首次/再次 delegate 触发）。经 applyBoardStatus 状态机单一事实源
    // 推导（§6.5.1），替代原硬编码 updateBoardMeta——校验合法流转 + 终态安全（completed/failed/interrupted
    // 不被 delegate 打回）。与 postReportEnvelope 一致走 nextBoardStatus。
    applyBoardStatus(taskId, { kind: 'delegate' });
    // 整任务交接（§12 注）：transferLeadership:true 时换板 leader（新 leader=opts.to，旧 leader 降 member）
    if (opts.transferLeadership) {
      transferLeadership(taskId, opts.to);
    }

    // §5.7 辩论模式：mode='debate' 时开辩论子板（createSubBoard 创建辩论 arena childTaskId）
    let debateChildTaskId: string | undefined;
    if (opts.mode === 'debate') {
      const sub = createSubBoard(taskId, {
        goal: opts.subTaskGoal,
        leader: opts.from,
        sessionId: opts.sessionId ?? '',
        correlationId: genId('corr'),
        requester: opts.from,
      });
      if (sub.status === 'ok') {
        debateChildTaskId = sub.childTaskId;
        // 辩论参与者加入辩论子板花名册
        addBoardMember(debateChildTaskId, opts.to, 'member');
      }
      // cant_split（spawnDepth 封顶）：辩论开不出，delegate 仍落板记录尝试，brain 看板可纠偏
    }

    return {
      id: genId('bmsg'),
      type: 'delegate' as const,
      from: opts.from,
      to: opts.to,
      taskId,
      parentTaskId: opts.parentTaskId,
      childTaskId: debateChildTaskId,
      sessionId: opts.sessionId,
      ts: Date.now(),
      subTaskGoal: opts.subTaskGoal,
      scope: opts.scope,
      transferLeadership: opts.transferLeadership,
      mode: opts.mode,
      debateConfig: opts.debateConfig,
    };
  }, 'delegate');
}

// ─── report 投影：结果/审核点落「附成果」信封 ───

export interface ReportEnvelopeOpts {
  /** 产出方 agentId（或 'reviewer'/'system'） */
  from: string;
  /** 上报对象（'leader'/'brain'/'user'） */
  to: string;
  /** 成果摘要 */
  summary: string;
  /** 成果状态 */
  status: 'done' | 'partial' | 'blocked' | 'cant_split';
  /** 会话 id */
  sessionId?: string;
  /** 成果文件引用（artifact，§10.5） */
  artifactRefs?: string[];
  /** 父板 id */
  parentTaskId?: string;
}

/**
 * 结果/审核点投影：postBoardMessage(report) + updateBoardMeta(boardStatus)。
 * 在 handleForegroundTaskResult 结果到达时 / handleTaskReviewResult 审核裁决时调用。
 * board_status 联动：默认按 report.status 推导（done→completed / blocked→failed / partial→in_progress）；
 * boardStatusEvent 显式覆盖（如 interrupt→interrupted、enter_review→awaiting_review），解耦 report 信封的
 * 审计 status 与板状态机流转（§6.5.1 单一事实源——审计说什么 ≠ 板状态机转到哪）。
 *
 * @param boardStatusEvent 可选：显式板状态事件。省略则按 opts.status 推导（report→completed/failed/in_progress）
 */
export function postReportEnvelope(taskId: string, opts: ReportEnvelopeOpts, boardStatusEvent?: BoardStatusEvent): void {
  safePost(taskId, () => {
    // board 状态机联动（§6.5.1 单一事实源）：经 applyBoardStatus 统一推导 + 校验合法流转。
    // boardStatusEvent 覆盖默认推导（解耦审计 status 与状态机）。
    applyBoardStatus(taskId, boardStatusEvent ?? { kind: 'report', status: opts.status });

    return {
      id: genId('bmsg'),
      type: 'report' as const,
      from: opts.from,
      to: opts.to,
      taskId,
      parentTaskId: opts.parentTaskId,
      sessionId: opts.sessionId,
      ts: Date.now(),
      summary: opts.summary,
      status: opts.status,
      artifactRefs: opts.artifactRefs ?? [],
    };
  }, `report(${opts.status})`);
}

// ─── P5 enabler：从 board 消息派生 delegation 生命周期事件 ───

/** 从 board report 信封派生的 delegation 生命周期事件（P5 权威切换后供 board 派生 delegation.* 用） */
export type DerivedDelegationEvent =
  | { type: 'delegation.completed'; delegationId: string; targetAgent: string }
  | { type: 'delegation.failed'; delegationId: string; targetAgent: string; error: string };

/**
 * 从 board report 信封派生 delegation 生命周期事件（P5 enabler，纯函数，可单测）。
 *
 * 映射（§3.3 收敛 + §6.5 board 状态机）：agent 的 report(status:done)→delegation.completed；
 * report(status:blocked/cant_split)→delegation.failed。
 * system report（from:'system'，fail/interrupt 兜底）+ partial（非终态）→ null（系统报告的
 * targetAgent 不在消息内，需板上下文派生；partial 非终态不派生）。
 *
 * 当前 board 是审计影子（delegation-manager 直 emit delegation.* 为权威源）；P5 权威切换后
 * delegation-manager 停发，board 据消息经本函数派生 + emit delegation.*（单一事实源收敛）。
 *
 * @param msg 板上信封（BoardMessage）
 * @returns 派生的 delegation 生命周期事件；null=该消息不映射到 delegation 终态
 */
export function deriveDelegationEventFromBoardMessage(msg: BoardMessage): DerivedDelegationEvent | null {
  if (msg.type !== 'report') return null;
  // system report（from:'system'）的 targetAgent 不在消息内 → 无法从单消息派生（留 P5 板上下文派生）
  if (msg.from === 'system') return null;
  switch (msg.status) {
    case 'done':
      return { type: 'delegation.completed', delegationId: msg.taskId, targetAgent: msg.from };
    case 'blocked':
    case 'cant_split':
      return { type: 'delegation.failed', delegationId: msg.taskId, targetAgent: msg.from, error: msg.summary };
    case 'partial':
    default:
      return null; // partial = 非终态，不派生 delegation 生命周期事件
  }
}

// ─── system report 投影：兜底失败落 from:'system' 的 report ───

export interface SystemReportOpts {
  /** 失败原因 */
  summary: string;
  /** 会话 id */
  sessionId?: string;
  /** 父板 id */
  parentTaskId?: string;
}

/**
 * 系统兜底失败投影：reviewer 崩溃 / heartbeat 超时 / interrupt 等 review 主路径外的失败（§6.5.2/6.5.3）。
 * from 固定 'system'，审计 status 固定 'blocked'；板状态默认 blocked→failed。
 *
 * @param boardStatusEvent 可选：显式板状态事件（如 interrupt 用 {kind:'interrupt'}→interrupted，
 *   解耦审计 report(blocked) 与板状态机——cancel/中断的审计记录是 blocked，但板终态是 interrupted）。
 */
export function postSystemReportEnvelope(taskId: string, opts: SystemReportOpts, boardStatusEvent?: BoardStatusEvent): void {
  postReportEnvelope(taskId, {
    from: 'system',
    to: 'leader',
    summary: opts.summary,
    status: 'blocked',
    sessionId: opts.sessionId,
    parentTaskId: opts.parentTaskId,
  }, boardStatusEvent);
}

// ─── ask 投影：escalation 出口落「求助」信封 ───

export interface AskEnvelopeOpts {
  /** 求助者（触发升级的 agent 或治理专员） */
  from: string;
  /** 求助问题（escalation.questionToUser） */
  question: string;
  /** 是否阻塞（true=等回复才继续） */
  blocking?: boolean;
  /** 会话 id */
  sessionId?: string;
}

/**
 * escalation 出口投影：postBoardMessage(ask, to:'brain')。
 *
 * 15.0 机制 B 的 4 个 escalation 触发点（route/review/approval/checkpoint）统一加此投影。
 * ask(@brain) 落板不阻塞——brain 异步看板消费（§4.2）。现有 complete/handleUserConfirm 语义不变。
 */
export function postAskEnvelope(taskId: string, opts: AskEnvelopeOpts): void {
  safePost(taskId, () => ({
    id: genId('bmsg'),
    type: 'ask' as const,
    from: opts.from,
    to: 'brain',
    taskId,
    sessionId: opts.sessionId,
    ts: Date.now(),
    question: opts.question,
    blocking: opts.blocking ?? true,
  }), 'ask(@brain)');
}

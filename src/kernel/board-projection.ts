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
} from './board-repo.js';
import { peekBlockCollector } from './block-collector.js';
import type { BoardMessage } from '../contracts/board-message.js';
import { routeGovernance } from './flows/governance-switch.js';

const logger = getLogger('board-projection');

/**
 * 通用 fire-and-forget 落板包装：所有投影统一经此，确保 try/catch + 日志一致。
 * 失败仅 debug 日志，不抛异常——现有派发/审核主路径零回归。
 */
function safePost(taskId: string, build: () => BoardMessage, label: string): void {
  try {
    const msg = build();
    postBoardMessage(taskId, msg);
    // board 落板成功后 emit 统一的 'board.message.posted'（WsEventBridge 订阅后转发前端看板 UI）。
    // 注：不再派生 delegation.* 旧事件——delegation-manager/orchestrator/observer/ask-handler 是
    // 这些生命周期/信号事件的权威源（直 emit），board 派生会造成双 emit（onTermination/
    // correction-flow 双触发）。P5 board 权威切换后让 delegation-manager 停发 + board 派生恢复。
    // 统一在此 emit board.message.posted（而非散落各 postXxxEnvelope），遵循「补丁过多即重构」。
    emitBoardMessagePosted(taskId, msg);
    // §14.5 任务进展卡：board 活动 → 投影 task_progress block（live-only，经 block-collector 桥接到 chat 消息）
    emitTaskProgressForBoard(taskId);
  } catch (err) {
    logger.debug({ err, taskId, label }, `board-projection: ${label} 落板失败（fire-and-forget，不影响主路径）`);
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
 * §14.5 任务进展卡投影：board 活动 → getBoardContext → TaskProgressBlock →
 * peekBlockCollector(taskId).onTaskProgress emit（collector 知道 messageId，桥接 board→chat 消息块）。
 * live-only fire-and-forget：无 collector（非 board 或已 dispose）静默跳过，失败 no-op。
 */
function emitTaskProgressForBoard(taskId: string): void {
  try {
    const ctx = getBoardContext(taskId, 10);
    if (!ctx) return;
    const collector = peekBlockCollector(taskId);
    if (!collector) return; // 无 collector = 无关联 chat 消息，跳过（非 board 路径或板已 dispose）
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
    collector.onTaskProgress({
      goal: ctx.meta.goal ?? '(无目标)',
      status: ctx.meta.boardStatus,
      leader: ctx.meta.leader ?? undefined,
      members: ctx.members.map((mem) => mem.agentId),
      turnCount: ctx.meta.turnCount,
      maxTurns: ctx.meta.maxTurns,
      spawnDepth: ctx.meta.spawnDepth,
      activitySummary: `${counts.gate}工具闸 ${counts.review}审核 ${counts.command}纠偏 ${counts.escalate}求助 ${counts.none}发言`,
    });
  } catch {
    // fire-and-forget：任务卡投影失败不影响主路径
  }
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
}

/**
 * 派发点投影：initBoard（幂等）+ addMember + postBoardMessage(delegate)。
 * 在 delegationManager.create 返回 taskId 之后、ipc.send('agent.task') 之前调用。
 * 幂等：重复调同一 taskId 安全（initBoard UPDATE + addMember INSERT OR IGNORE + postBoardMessage 追加）。
 */
export function postDelegateEnvelope(taskId: string, opts: DelegateEnvelopeOpts): void {
  safePost(taskId, () => {
    // 幂等初始化板元数据（已存在则 UPDATE 不破坏）
    if (!getBoardMeta(taskId)) {
      initBoard(taskId, {
        goal: opts.subTaskGoal,
        leader: opts.from,
        parentTaskId: opts.parentTaskId,
        spawnDepth: opts.parentTaskId ? 1 : 0,
      });
    }
    addBoardMember(taskId, opts.to, 'member');
    // 板状态 created → in_progress（首次 delegate 触发）
    updateBoardMeta(taskId, { boardStatus: 'in_progress' });
    // 整任务交接（§12 注）：transferLeadership:true 时换板 leader（新 leader=opts.to，旧 leader 降 member）
    if (opts.transferLeadership) {
      transferLeadership(taskId, opts.to);
    }

    return {
      id: genId('bmsg'),
      type: 'delegate' as const,
      from: opts.from,
      to: opts.to,
      taskId,
      parentTaskId: opts.parentTaskId,
      sessionId: opts.sessionId,
      ts: Date.now(),
      subTaskGoal: opts.subTaskGoal,
      scope: opts.scope,
      transferLeadership: opts.transferLeadership,
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
 * board_status 联动：done→completed / blocked→failed 或 awaiting_review。
 */
export function postReportEnvelope(taskId: string, opts: ReportEnvelopeOpts): void {
  safePost(taskId, () => {
    // board 状态机联动（§6.5.1 单一事实源）：经 applyBoardStatus 统一推导 + 校验合法流转，
    // 替代原散落的硬编码 statusMap。done→completed / blocked→failed / partial+cant_split→in_progress。
    // 终态板收到迟到 report → no-op（防已完成板被打回）；旧库无 board 列 → 静默降级。
    applyBoardStatus(taskId, { kind: 'report', status: opts.status });

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
 * from 固定 'system'，status 固定 'blocked'。
 */
export function postSystemReportEnvelope(taskId: string, opts: SystemReportOpts): void {
  postReportEnvelope(taskId, {
    from: 'system',
    to: 'leader',
    summary: opts.summary,
    status: 'blocked',
    sessionId: opts.sessionId,
    parentTaskId: opts.parentTaskId,
  });
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

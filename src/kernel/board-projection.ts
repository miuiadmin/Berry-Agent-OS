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
} from './board-repo.js';
import type { BoardMessage } from '../contracts/board-message.js';

const logger = getLogger('board-projection');

/**
 * 通用 fire-and-forget 落板包装：所有投影统一经此，确保 try/catch + 日志一致。
 * 失败仅 debug 日志，不抛异常——现有派发/审核主路径零回归。
 */
function safePost(taskId: string, build: () => BoardMessage, label: string): void {
  try {
    const msg = build();
    postBoardMessage(taskId, msg);
    // P5-C1：board 信封落板后派生 EventBus 事件（让现有订阅者无感迁移，§9 P5「旧通道降兼容层」）
    deriveEventFromBoardMessage(taskId, msg);
    // P5-C2：board 落板成功后 emit 统一的 'board.message.posted'，
    // WsEventBridge 订阅后转发 ws.type='board.message' 给前端（前端看板 UI 实时刷新）。
    // 此事件是 P5-C2 唯一新增的前端可见信号，与 deriveEventFromBoardMessage 派生的旧事件正交：
    //   - 旧事件（delegation.created/completed/failed/checkpoint_needed）→ 服务端内部订阅者
    //   - board.message.posted → 前端看板 UI（经 WsEventBridge 桥接）
    // 统一在此 emit（而非散落各 postXxxEnvelope），遵循 CLAUDE.md「补丁过多即重构」——
    // 所有 board 落板都经 safePost，在此一处派生前端信号即可覆盖全部信封类型。
    emitBoardMessagePosted(taskId, msg);
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
 * P5-C1：从 BoardMessage 派生 EventBus 事件（现有订阅者无感迁移）。
 *
 * board 信封是语义层（说什么），EventBus 是传输层（怎么送达）。P5 阶段在 board 落板后
 * 同时 emit 对应的旧 EventBus 事件名，让 WsEventBridge/Evolution/现有订阅者继续读旧事件
 * 而不感知 board 的存在。待订阅者全切到 board thread 再删旧事件（P5-C4）。
 */
function deriveEventFromBoardMessage(taskId: string, msg: BoardMessage): void {
  try {
    const bus = getEventBus();
    switch (msg.type) {
      case 'delegate':
        // delegate → delegation.created（现有订阅者：onTermination/cleanupTaskState）
        bus.emit('delegation.created', { delegationId: taskId, sessionId: msg.sessionId ?? '', targetAgent: msg.to });
        break;
      case 'report':
        // report(done) → delegation.completed / report(blocked) → delegation.failed
        if (msg.status === 'done') {
          bus.emit('delegation.completed', { delegationId: taskId, targetAgent: msg.from, durationMs: 0 });
        } else {
          bus.emit('delegation.failed', { delegationId: taskId, targetAgent: msg.from, error: msg.summary });
        }
        break;
      case 'ask':
        // ask(@brain) → checkpoint_needed（现有 correction-flow/Evolution 订阅者）
        if (msg.to === 'brain') {
          bus.emit('delegation.checkpoint_needed', { delegationId: taskId, trigger: 'board_ask' });
        }
        break;
      // tell / tool_request / tool_result / command 暂无对应旧事件——P5 后续按需添加
    }
  } catch { /* 派生事件失败不影响 board 落板主路径 */ }
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
    // board 状态机联动（§6.5.1）
    const statusMap: Record<ReportEnvelopeOpts['status'], string> = {
      done: 'completed',
      partial: 'in_progress',
      blocked: 'failed',
      cant_split: 'in_progress',
    };
    try {
      updateBoardMeta(taskId, { boardStatus: statusMap[opts.status] as 'completed' | 'failed' | 'in_progress' });
    } catch { /* board 列不存在（旧库未跑 v28）→ 静默 */ }

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

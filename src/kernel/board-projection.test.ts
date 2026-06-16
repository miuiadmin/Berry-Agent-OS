/**
 * board-projection P5-C2 验证测试 —— board.message.posted 事件转发链路。
 *
 * 背景：16.0 P5-C2 要求 board 落板后 emit 'board.message.posted' 事件，
 * WsEventBridge 订阅后转发 ws.type='board.message' 给前端（前端看板 UI 实时刷新）。
 * 本测试钉死 safePost → emitBoardMessagePosted 的派生关系，防止未来重构漏 emit。
 *
 * 不测：
 *   - WsEventBridge 的 ws 转发（那是 web 层，需 WS server harness，归 1-to-1/真实测试）
 *   - board-repo 的 postBoardMessage 落库细节（建表由 schema.ts TASK_BOARD_SQL + migration v28 负责；
 *     board-repo 的 DB 不变量钉死见 board-repo.test.ts）
 *   - AI 生成内容（CLAUDE.md 禁止）
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, getDb } from '../memory/db.js';
import { initEventBus, getEventBus } from './event-bus.js';
import {
  postDelegateEnvelope,
  postReportEnvelope,
  postAskEnvelope,
  postSystemReportEnvelope,
} from './board-projection.js';
import { getBoardMeta, applyBoardStatus } from './board-repo.js';

/** 捕获到的 board.message.posted 事件 payload 类型（从 EventMap 推导，保持与契约一致） */
type BoardMessagePostedPayload = {
  taskId: string;
  sessionId?: string;
  messageType: 'delegate' | 'report' | 'ask' | 'tool_request' | 'tool_result' | 'command' | 'tell';
  messageId?: string;
  from?: string;
  to?: string;
};

describe('board-projection P5-C2: board.message.posted 事件转发', () => {
  let dir: string;

  beforeEach(() => {
    // 每个用例独立临时库 + 独立 EventBus（避免跨用例事件串扰）
    dir = mkdtempSync(join(tmpdir(), 'berry-board-proj-'));
    initDb(join(dir, 'test.db'));
    initEventBus();
  });

  afterEach(() => {
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('postDelegateEnvelope 落板后 emit board.message.posted（messageType=delegate）', () => {
    const captured: BoardMessagePostedPayload[] = [];
    getEventBus().on('board.message.posted', (p) => captured.push(p));

    postDelegateEnvelope('task-d1', {
      from: 'brain',
      to: 'evolution',
      subTaskGoal: '提取反馈',
      sessionId: 'sess-1',
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].taskId).toBe('task-d1');
    expect(captured[0].messageType).toBe('delegate');
    expect(captured[0].sessionId).toBe('sess-1');
    expect(captured[0].from).toBe('brain');
    expect(captured[0].to).toBe('evolution');
    expect(captured[0].messageId).toBeTruthy();
  });

  it('postReportEnvelope(done) 落板后 emit board.message.posted（messageType=report）', () => {
    const captured: BoardMessagePostedPayload[] = [];
    getEventBus().on('board.message.posted', (p) => captured.push(p));

    // report 需要板已 init（postReportEnvelope 调 updateBoardMeta），先 delegate 建板
    postDelegateEnvelope('task-r1', {
      from: 'brain',
      to: 'evolution',
      subTaskGoal: '子任务',
      sessionId: 'sess-2',
    });
    captured.length = 0; // 清掉 delegate 的 emit，只看 report

    postReportEnvelope('task-r1', {
      from: 'evolution',
      to: 'leader',
      summary: '完成',
      status: 'done',
      sessionId: 'sess-2',
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].taskId).toBe('task-r1');
    expect(captured[0].messageType).toBe('report');
    expect(captured[0].from).toBe('evolution');
    expect(captured[0].to).toBe('leader');
  });

  it('postAskEnvelope 落板后 emit board.message.posted（messageType=ask）', () => {
    const captured: BoardMessagePostedPayload[] = [];
    getEventBus().on('board.message.posted', (p) => captured.push(p));

    postAskEnvelope('task-a1', {
      from: 'evolution',
      question: '需要 brain 帮忙决策',
      blocking: true,
      sessionId: 'sess-3',
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].taskId).toBe('task-a1');
    expect(captured[0].messageType).toBe('ask');
    expect(captured[0].sessionId).toBe('sess-3');
    expect(captured[0].from).toBe('evolution');
    // ask 信封 to 固定 'brain'（postAskEnvelope 内部硬编码）
    expect(captured[0].to).toBe('brain');
  });

  it('board.message.posted emit，不再派生 delegation.*（P5-2：根治双 emit，delegation-manager 是权威源）', () => {
    // P5-2：board-projection 不再从 delegate 派生 delegation.created——delegation-manager.create
    // 是权威源，board 派生会造成双 emit（onTermination/correction-flow 双触发）。
    // P5 board 权威切换后让 delegation-manager 停发 + board 派生恢复，届时再改回。
    const boardPosted: BoardMessagePostedPayload[] = [];
    const delegationCreated: unknown[] = [];
    getEventBus().on('board.message.posted', (p) => boardPosted.push(p));
    getEventBus().on('delegation.created', (p) => delegationCreated.push(p));

    postDelegateEnvelope('task-ortho', {
      from: 'brain',
      to: 'code',
      subTaskGoal: '正交验证',
      sessionId: 'sess-ortho',
    });

    // board.message.posted（前端看板信号）emit
    expect(boardPosted).toHaveLength(1);
    expect(boardPosted[0].messageType).toBe('delegate');
    // delegation.created 不再由 board-projection 派生（避免双 emit）
    expect(delegationCreated).toHaveLength(0);
  });
});

/**
 * §6.5.1 板状态机接线测试（P2-D：delegate 单一事实源 + enter_review/(B) report 时序 + interrupt 解耦）。
 *
 * 钉死 P2 三批接线的板状态语义，防未来重构回归：
 *   - delegate 走 applyBoardStatus（非硬编码 updateBoardMeta）
 *   - report(done, {enter_review}) → awaiting_review（review 前不提前 completed）
 *   - review 裁决 approve→completed / reject→failed（awaiting_review → terminal）
 *   - postSystemReportEnvelope(blocked, {interrupt}) → interrupted（解耦审计 blocked 与状态机 interrupted）
 *   - 终态板不被迟到信封打回
 */
describe('board-projection §6.5.1 状态机接线（P2-D）', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'berry-board-fsm-'));
    initDb(join(dir, 'test.db'));
    initEventBus();
  });

  afterEach(() => {
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** 插入一行 agent_tasks（board 元数据列由 migration v28 ALTER 补默认值，initBoard 再 UPDATE 覆写） */
  function insertAgentTask(taskId: string, sessionId: string): void {
    getDb()
      .prepare(
        `INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, input_payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(taskId, sessionId, 'corr-test', 'test', 'brain', 'code', '{}');
  }

  it('delegate → in_progress（applyBoardStatus 单一事实源，非硬编码 updateBoardMeta）', () => {
    insertAgentTask('fsm-1', 's1');
    postDelegateEnvelope('fsm-1', { from: 'brain', to: 'code', subTaskGoal: '改模块 X', sessionId: 's1' });
    expect(getBoardMeta('fsm-1')?.boardStatus).toBe('in_progress');
  });

  it('(B) report(done, {enter_review}) → awaiting_review（report 审计 done 但板等审核，不提前 completed）', () => {
    insertAgentTask('fsm-2', 's2');
    postDelegateEnvelope('fsm-2', { from: 'brain', to: 'code', subTaskGoal: '改 Y', sessionId: 's2' });
    postReportEnvelope('fsm-2', { from: 'code', to: 'leader', status: 'done', summary: '完成', sessionId: 's2' }, { kind: 'enter_review' });
    expect(getBoardMeta('fsm-2')?.boardStatus).toBe('awaiting_review');
  });

  it('(B) review approve → completed（awaiting_review → completed）', () => {
    insertAgentTask('fsm-3', 's3');
    postDelegateEnvelope('fsm-3', { from: 'brain', to: 'code', subTaskGoal: '改 Z', sessionId: 's3' });
    postReportEnvelope('fsm-3', { from: 'code', to: 'leader', status: 'done', summary: '完成', sessionId: 's3' }, { kind: 'enter_review' });
    expect(getBoardMeta('fsm-3')?.boardStatus).toBe('awaiting_review');
    // review 裁决 approve：默认 postReport(done) → completed
    postReportEnvelope('fsm-3', { from: 'code', to: 'leader', status: 'done', summary: '完成', sessionId: 's3' });
    expect(getBoardMeta('fsm-3')?.boardStatus).toBe('completed');
  });

  it('(B) review reject → failed（awaiting_review → failed）', () => {
    insertAgentTask('fsm-4', 's4');
    postDelegateEnvelope('fsm-4', { from: 'brain', to: 'code', subTaskGoal: '改 W', sessionId: 's4' });
    postReportEnvelope('fsm-4', { from: 'code', to: 'leader', status: 'done', summary: '完成', sessionId: 's4' }, { kind: 'enter_review' });
    // review 裁决 reject：postReport(blocked) → failed
    postReportEnvelope('fsm-4', { from: 'code', to: 'leader', status: 'blocked', summary: '审核拒绝', sessionId: 's4' });
    expect(getBoardMeta('fsm-4')?.boardStatus).toBe('failed');
  });

  it('interrupt 解耦：postSystemReportEnvelope(blocked, {interrupt}) → interrupted（审计 blocked 但状态机 interrupted，非 failed）', () => {
    insertAgentTask('fsm-5', 's5');
    postDelegateEnvelope('fsm-5', { from: 'brain', to: 'code', subTaskGoal: '改 V', sessionId: 's5' });
    postSystemReportEnvelope('fsm-5', { summary: '执行已取消', sessionId: 's5' }, { kind: 'interrupt' });
    expect(getBoardMeta('fsm-5')?.boardStatus).toBe('interrupted');
  });

  it('终态板（interrupted）不被迟到的 delegate 信封打回 in_progress', () => {
    insertAgentTask('fsm-6', 's6');
    postDelegateEnvelope('fsm-6', { from: 'brain', to: 'code', subTaskGoal: '改 U', sessionId: 's6' });
    postSystemReportEnvelope('fsm-6', { summary: '取消', sessionId: 's6' }, { kind: 'interrupt' });
    expect(getBoardMeta('fsm-6')?.boardStatus).toBe('interrupted');
    // 迟到的 delegate（applyBoardStatus 终态守卫）不应复活终态板
    postDelegateEnvelope('fsm-6', { from: 'brain', to: 'code', subTaskGoal: '迟到派发', sessionId: 's6' });
    expect(getBoardMeta('fsm-6')?.boardStatus).toBe('interrupted');
  });

  it('genuine fail（无 boardStatusEvent）→ failed：postSystemReportEnvelope(blocked) 默认 blocked→failed', () => {
    insertAgentTask('fsm-7', 's7');
    postDelegateEnvelope('fsm-7', { from: 'brain', to: 'code', subTaskGoal: '改 T', sessionId: 's7' });
    postSystemReportEnvelope('fsm-7', { summary: '任务失败：crash', sessionId: 's7' });
    expect(getBoardMeta('fsm-7')?.boardStatus).toBe('failed');
  });

  it('await_user：agent 问用户 → awaiting_user（in_progress → awaiting_user）', () => {
    insertAgentTask('fsm-8', 's8');
    postDelegateEnvelope('fsm-8', { from: 'brain', to: 'code', subTaskGoal: '改 A', sessionId: 's8' });
    applyBoardStatus('fsm-8', { kind: 'await_user' });
    expect(getBoardMeta('fsm-8')?.boardStatus).toBe('awaiting_user');
  });

  it('user_resumed：用户回复 → in_progress（awaiting_user → in_progress，恢复干活）', () => {
    insertAgentTask('fsm-9', 's9');
    postDelegateEnvelope('fsm-9', { from: 'brain', to: 'code', subTaskGoal: '改 B', sessionId: 's9' });
    applyBoardStatus('fsm-9', { kind: 'await_user' });
    applyBoardStatus('fsm-9', { kind: 'user_resumed' });
    expect(getBoardMeta('fsm-9')?.boardStatus).toBe('in_progress');
  });

  it('user_rejected：用户拒绝 → failed（awaiting_user → failed）', () => {
    insertAgentTask('fsm-10', 's10');
    postDelegateEnvelope('fsm-10', { from: 'brain', to: 'code', subTaskGoal: '改 C', sessionId: 's10' });
    applyBoardStatus('fsm-10', { kind: 'await_user' });
    applyBoardStatus('fsm-10', { kind: 'user_rejected' });
    expect(getBoardMeta('fsm-10')?.boardStatus).toBe('failed');
  });
});

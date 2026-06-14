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
import { initDb, closeDb } from '../memory/db.js';
import { initEventBus, getEventBus } from './event-bus.js';
import {
  postDelegateEnvelope,
  postReportEnvelope,
  postAskEnvelope,
} from './board-projection.js';

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

  it('board.message.posted 与 P5-C1 派生的旧事件正交（一次落板可同时 emit 多个）', () => {
    // delegate 落板应同时 emit：
    //   - board.message.posted（P5-C2 前端信号）
    //   - delegation.created（P5-C1 旧订阅者信号，deriveEventFromBoardMessage）
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

    // 两类事件都 emit，互不干扰（正交性是 P5-C2 设计要点）
    expect(boardPosted).toHaveLength(1);
    expect(delegationCreated).toHaveLength(1);
    expect(boardPosted[0].messageType).toBe('delegate');
  });
});

/**
 * board-reconciler 孤儿板恢复测试（设计文档/23 §6.5.3）。
 *
 * 钉死启动时板孤儿恢复的不变量：in_progress 但 agent_task 已终态 → 标 failed + 系统 report；
 * 活跃板（task 仍 running）不动；幂等（已 failed 不再扫）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, getDb } from '../memory/db.js';
import { initEventBus } from './event-bus.js';
import { initBoard, getBoardMeta } from './board-repo.js';
import { reconcileOrphanBoards } from './board-reconciler.js';

/** 插入一行 agent_tasks（board-reconciler 落库前置依赖）+ 可指定 task status */
function insertAgentTask(taskId: string, status = 'running'): void {
  getDb()
    .prepare(
      `INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, foreground, input_payload, status, created_at)
       VALUES (?, 's', 'c', 't', 'r', 'a', 0, '{}', ?, 0)`,
    )
    .run(taskId, status);
}

describe('board-reconciler 孤儿板恢复（§6.5.3）', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'berry-reconciler-'));
    initDb(join(dir, 'test.db'));
    initEventBus();
  });

  afterEach(() => {
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('in_progress 板 + agent_task 已 failed → 标 failed（孤儿恢复）', () => {
    insertAgentTask('task-orphan', 'failed'); // agent_task 已崩溃
    initBoard('task-orphan', { goal: '崩溃板', leader: 'code' });
    // 模拟板曾活跃（initBoard 设 created，手动置 in_progress 模拟运行中崩溃）
    getDb().prepare(`UPDATE agent_tasks SET board_status = 'in_progress' WHERE id = ?`).run('task-orphan');

    const count = reconcileOrphanBoards();
    expect(count).toBe(1);
    expect(getBoardMeta('task-orphan')!.boardStatus).toBe('failed');
  });

  it('in_progress 板 + agent_task 仍 running → 非孤儿，不动', () => {
    insertAgentTask('task-active', 'running');
    initBoard('task-active', { goal: '活跃板', leader: 'code' });
    getDb().prepare(`UPDATE agent_tasks SET board_status = 'in_progress' WHERE id = ?`).run('task-active');

    expect(reconcileOrphanBoards()).toBe(0);
    expect(getBoardMeta('task-active')!.boardStatus).toBe('in_progress'); // 未被恢复
  });

  it('多个孤儿板一次全恢复', () => {
    for (const id of ['task-o1', 'task-o2', 'task-o3']) {
      insertAgentTask(id, 'timeout');
      initBoard(id, { goal: '孤儿', leader: 'code' });
      getDb().prepare(`UPDATE agent_tasks SET board_status = 'in_progress' WHERE id = ?`).run(id);
    }
    expect(reconcileOrphanBoards()).toBe(3);
    for (const id of ['task-o1', 'task-o2', 'task-o3']) {
      expect(getBoardMeta(id)!.boardStatus).toBe('failed');
    }
  });

  it('幂等：已 failed 的板不再扫（再跑返回 0）', () => {
    insertAgentTask('task-idem', 'cancelled');
    initBoard('task-idem', { goal: 'x', leader: 'code' });
    getDb().prepare(`UPDATE agent_tasks SET board_status = 'in_progress' WHERE id = ?`).run('task-idem');
    expect(reconcileOrphanBoards()).toBe(1);
    // 再跑：板已 failed，不在 in_progress 查询范围 → 0
    expect(reconcileOrphanBoards()).toBe(0);
  });
});

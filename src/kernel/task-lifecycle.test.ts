import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TaskLifecycle } from './task-lifecycle.js';
import { TaskManager } from './task-manager.js';
import { EventBus } from './event-bus.js';
import { CORE_SCHEMA_SQL, CORE_INDEX_SQL } from '../memory/schema.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(CORE_SCHEMA_SQL);
  db.exec(CORE_INDEX_SQL);
  return db;
}

describe('TaskLifecycle', () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let taskManager: TaskManager;
  let lifecycle: TaskLifecycle;

  beforeEach(() => {
    db = createTestDb();
    eventBus = new EventBus();
    taskManager = new TaskManager(db, eventBus, { defaultTimeoutMs: 60000 });
    lifecycle = new TaskLifecycle(db, eventBus);
  });

  afterEach(() => {
    taskManager.dispose();
    db.close();
  });

  function createTask(): string {
    return taskManager.create({
      sessionId: 'ses_1',
      correlationId: 'cor_1',
      taskType: 'code_task',
      requester: 'user',
      targetAgent: 'code',
      foreground: true,
      inputPayload: { instruction: 'test' },
    });
  }

  it('初始状态为 foreground', () => {
    const taskId = createTask();
    const state = lifecycle.getState(taskId);
    expect(state).not.toBeNull();
    expect(state!.visibility).toBe('foreground');
    expect(state!.notifyState).toBe('none');
  });

  it('后台化任务', () => {
    const taskId = createTask();
    lifecycle.background(taskId);

    const state = lifecycle.getState(taskId);
    expect(state!.visibility).toBe('backgrounded');
    expect(state!.backgroundedAt).toBeGreaterThan(0);
  });

  it('恢复前台', () => {
    const taskId = createTask();
    lifecycle.background(taskId);
    lifecycle.resume(taskId);

    const state = lifecycle.getState(taskId);
    expect(state!.visibility).toBe('foreground');
  });

  it('检索后台任务', () => {
    const taskId = createTask();
    lifecycle.background(taskId);
    const state = lifecycle.retrieve(taskId);

    expect(state.visibility).toBe('retrieved');
    expect(state.notifyState).toBe('notified');
    expect(state.retrievedAt).toBeGreaterThan(0);
  });

  it('后台任务完成时设置 pending 通知', () => {
    const taskId = createTask();
    taskManager.dispatch(taskId);
    taskManager.acknowledge(taskId);
    taskManager.start(taskId);
    lifecycle.background(taskId);

    taskManager.complete(taskId, { summary: '完成' });

    const state = lifecycle.getState(taskId);
    expect(state!.notifyState).toBe('pending');
  });

  it('前台任务完成时不设置通知', () => {
    const taskId = createTask();
    taskManager.dispatch(taskId);
    taskManager.acknowledge(taskId);
    taskManager.start(taskId);
    taskManager.complete(taskId, { summary: '完成' });

    const state = lifecycle.getState(taskId);
    expect(state!.notifyState).toBe('none');
  });

  it('停止任务', () => {
    const taskId = createTask();
    taskManager.dispatch(taskId);
    taskManager.acknowledge(taskId);
    taskManager.start(taskId);

    lifecycle.stop(taskId, '不再需要');

    const task = taskManager.getTask(taskId);
    expect(task!.status).toBe('cancelled');
  });

  it('列出后台任务', () => {
    const t1 = createTask();
    const t2 = createTask();
    lifecycle.background(t1);

    const list = lifecycle.listBackground('ses_1');
    expect(list).toHaveLength(1);
    expect(list[0].taskId).toBe(t1);
    expect(list[0].visibility).toBe('backgrounded');
  });

  it('获取待处理通知', () => {
    const taskId = createTask();
    taskManager.dispatch(taskId);
    taskManager.acknowledge(taskId);
    taskManager.start(taskId);
    lifecycle.background(taskId);
    taskManager.complete(taskId, { summary: '已完成' });

    const pending = lifecycle.getPendingNotifications('ses_1');
    expect(pending).toHaveLength(1);
    expect(pending[0].notifyState).toBe('pending');
  });

  it('dismiss 通知', () => {
    const taskId = createTask();
    taskManager.dispatch(taskId);
    taskManager.acknowledge(taskId);
    taskManager.start(taskId);
    lifecycle.background(taskId);
    taskManager.complete(taskId, { summary: 'done' });

    lifecycle.dismissNotification(taskId);
    const state = lifecycle.getState(taskId);
    expect(state!.notifyState).toBe('dismissed');
  });

  it('触发 task.backgrounded 事件', () => {
    const events: unknown[] = [];
    eventBus.on('task.backgrounded', (p) => events.push(p));

    const taskId = createTask();
    lifecycle.background(taskId);

    expect(events).toHaveLength(1);
    expect((events[0] as any).taskId).toBe(taskId);
  });
});

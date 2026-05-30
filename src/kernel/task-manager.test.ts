import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
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

describe('TaskManager', () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let tm: TaskManager;

  beforeEach(() => {
    db = createTestDb();
    eventBus = new EventBus();
    tm = new TaskManager(db, eventBus, { defaultTimeoutMs: 500 });
  });

  afterEach(() => {
    tm.dispose();
    db.close();
  });

  it('创建任务并落库', () => {
    const taskId = tm.create({
      sessionId: 'ses_1',
      correlationId: 'cor_1',
      taskType: 'conversation_turn',
      requester: 'user',
      targetAgent: 'conversation',
      inputPayload: { message: 'hello' },
    });

    expect(taskId).toMatch(/^tsk_/);
    const task = tm.getTask(taskId)!;
    expect(task.status).toBe('created');
    expect(task.session_id).toBe('ses_1');
    expect(JSON.parse(task.input_payload)).toEqual({ message: 'hello' });
  });

  it('完整生命周期: created → dispatched → acknowledged → running → completed', () => {
    const events: string[] = [];
    eventBus.on('task.created', () => events.push('created'));
    eventBus.on('task.dispatched', () => events.push('dispatched'));
    eventBus.on('task.acknowledged', () => events.push('acknowledged'));
    eventBus.on('task.started', () => events.push('started'));
    eventBus.on('task.completed', () => events.push('completed'));

    const taskId = tm.create({
      sessionId: 'ses_1',
      correlationId: 'cor_1',
      taskType: 'brain_review',
      requester: 'conversation',
      targetAgent: 'brain',
      inputPayload: { draft: 'hi' },
    });

    tm.dispatch(taskId);
    expect(tm.getTask(taskId)!.status).toBe('dispatched');

    tm.acknowledge(taskId);
    expect(tm.getTask(taskId)!.status).toBe('acknowledged');

    tm.start(taskId);
    expect(tm.getTask(taskId)!.status).toBe('running');

    tm.complete(taskId, { verdict: 'approve' });
    const final = tm.getTask(taskId)!;
    expect(final.status).toBe('completed');
    expect(JSON.parse(final.output_payload!)).toEqual({ verdict: 'approve' });
    expect(final.finished_at).toBeGreaterThan(0);

    expect(events).toEqual(['created', 'dispatched', 'acknowledged', 'started', 'completed']);
  });

  it('失败路径: created → dispatched → running → failed', () => {
    let failEvent: { taskId: string; error: string } | null = null;
    eventBus.on('task.failed', (e) => { failEvent = e; });

    const taskId = tm.create({
      sessionId: 'ses_2',
      correlationId: 'cor_2',
      taskType: 'conversation_turn',
      requester: 'user',
      targetAgent: 'conversation',
      inputPayload: {},
    });

    tm.dispatch(taskId);
    tm.start(taskId);
    tm.fail(taskId, 'LLM 调用超时');

    const task = tm.getTask(taskId)!;
    expect(task.status).toBe('failed');
    expect(task.error).toBe('LLM 调用超时');
    expect(failEvent).not.toBeNull();
    expect(failEvent!.error).toBe('LLM 调用超时');
  });

  it('取消任务', () => {
    let cancelEvent: { taskId: string; reason?: string } | null = null;
    eventBus.on('task.cancelled', (e) => { cancelEvent = e; });

    const taskId = tm.create({
      sessionId: 'ses_3',
      correlationId: 'cor_3',
      taskType: 'conversation_turn',
      requester: 'user',
      targetAgent: 'conversation',
      inputPayload: {},
    });

    tm.dispatch(taskId);
    tm.cancel(taskId, '用户取消');

    expect(tm.getTask(taskId)!.status).toBe('cancelled');
    expect(cancelEvent!.reason).toBe('用户取消');
  });

  it('取消已完成的任务是空操作', () => {
    const taskId = tm.create({
      sessionId: 'ses_4',
      correlationId: 'cor_4',
      taskType: 'conversation_turn',
      requester: 'user',
      targetAgent: 'conversation',
      inputPayload: {},
    });

    tm.dispatch(taskId);
    tm.start(taskId);
    tm.complete(taskId, {});
    tm.cancel(taskId);

    expect(tm.getTask(taskId)!.status).toBe('completed');
  });

  it('非法状态转换抛出错误', () => {
    const taskId = tm.create({
      sessionId: 'ses_5',
      correlationId: 'cor_5',
      taskType: 'conversation_turn',
      requester: 'user',
      targetAgent: 'conversation',
      inputPayload: {},
    });

    expect(() => tm.acknowledge(taskId)).toThrow('不允许确认');
    expect(() => tm.start(taskId)).toThrow('不允许启动');

    tm.dispatch(taskId);
    expect(() => tm.dispatch(taskId)).toThrow('不允许派发');
  });

  it('超时自动标记', async () => {
    let timeoutEvent: { taskId: string } | null = null;
    eventBus.on('task.timeout', (e) => { timeoutEvent = e; });

    const taskId = tm.create({
      sessionId: 'ses_6',
      correlationId: 'cor_6',
      taskType: 'conversation_turn',
      requester: 'user',
      targetAgent: 'conversation',
      inputPayload: {},
    });

    tm.dispatch(taskId);

    await new Promise((r) => setTimeout(r, 600));

    expect(tm.getTask(taskId)!.status).toBe('timeout');
    expect(timeoutEvent).not.toBeNull();
  });

  it('完成任务清除超时计时器', async () => {
    const taskId = tm.create({
      sessionId: 'ses_7',
      correlationId: 'cor_7',
      taskType: 'conversation_turn',
      requester: 'user',
      targetAgent: 'conversation',
      inputPayload: {},
    });

    tm.dispatch(taskId);
    tm.start(taskId);
    tm.complete(taskId, { result: 'ok' });

    await new Promise((r) => setTimeout(r, 600));
    expect(tm.getTask(taskId)!.status).toBe('completed');
  });

  it('task_events 记录完整事件链', () => {
    const taskId = tm.create({
      sessionId: 'ses_8',
      correlationId: 'cor_8',
      taskType: 'brain_review',
      requester: 'conversation',
      targetAgent: 'brain',
      inputPayload: {},
    });

    tm.dispatch(taskId);
    tm.acknowledge(taskId);
    tm.start(taskId);
    tm.complete(taskId, {});

    const events = db.prepare('SELECT event_type FROM task_events WHERE task_id = ? ORDER BY created_at').all(taskId) as { event_type: string }[];
    expect(events.map((e) => e.event_type)).toEqual(['created', 'dispatched', 'acknowledged', 'started', 'completed']);
  });

  it('getTasksByStatus 和 getPendingCount', () => {
    const id1 = tm.create({ sessionId: 's', correlationId: 'c1', taskType: 'conversation_turn', requester: 'u', targetAgent: 'conversation', inputPayload: {} });
    const id2 = tm.create({ sessionId: 's', correlationId: 'c2', taskType: 'conversation_turn', requester: 'u', targetAgent: 'conversation', inputPayload: {} });

    expect(tm.getPendingCount()).toBe(2);
    expect(tm.getTasksByStatus('created')).toHaveLength(2);

    tm.dispatch(id1);
    tm.start(id1);
    tm.complete(id1, {});

    expect(tm.getPendingCount()).toBe(1);
    expect(tm.getTasksByStatus('completed')).toHaveLength(1);
  });
});

describe('EventBus', () => {
  it('强类型事件发送和接收', () => {
    const bus = new EventBus();
    let received: { taskId: string; taskType: string } | null = null;

    bus.on('task.created', (payload) => { received = payload; });
    bus.emit('task.created', { taskId: 'tsk_1', taskType: 'conversation_turn', targetAgent: 'conversation' });

    expect(received).not.toBeNull();
    expect(received!.taskId).toBe('tsk_1');
  });

  it('once 只触发一次', () => {
    const bus = new EventBus();
    let count = 0;

    bus.once('task.started', () => { count++; });
    bus.emit('task.started', { taskId: 'tsk_1', targetAgent: 'brain' });
    bus.emit('task.started', { taskId: 'tsk_2', targetAgent: 'brain' });

    expect(count).toBe(1);
  });

  it('off 取消监听', () => {
    const bus = new EventBus();
    let count = 0;
    const listener = () => { count++; };

    bus.on('task.failed', listener);
    bus.emit('task.failed', { taskId: 'x', targetAgent: 'brain', error: 'e' });
    bus.off('task.failed', listener);
    bus.emit('task.failed', { taskId: 'y', targetAgent: 'brain', error: 'e' });

    expect(count).toBe(1);
  });

  it('listener 异常不影响其他 listener', () => {
    const bus = new EventBus();
    let called = false;

    bus.on('task.completed', () => { throw new Error('boom'); });
    bus.on('task.completed', () => { called = true; });
    bus.emit('task.completed', { taskId: 'x', targetAgent: 'brain', outputPayload: {} });

    expect(called).toBe(true);
  });

  it('on 返回的函数可取消订阅', () => {
    const bus = new EventBus();
    let count = 0;

    const unsub = bus.on('task.cancelled', () => { count++; });
    bus.emit('task.cancelled', { taskId: 'x' });
    unsub();
    bus.emit('task.cancelled', { taskId: 'y' });

    expect(count).toBe(1);
  });
});

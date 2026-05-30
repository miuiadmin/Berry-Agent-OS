import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TaskScheduler } from './task-scheduler.js';
import { TaskManager } from './task-manager.js';
import { EventBus } from './event-bus.js';
import { CORE_SCHEMA_SQL, CORE_INDEX_SQL } from '../memory/schema.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(CORE_SCHEMA_SQL);
  db.exec(CORE_INDEX_SQL);
  return db;
}

describe('TaskScheduler', () => {
  let db: ReturnType<typeof Database>;
  let eventBus: EventBus;
  let tm: TaskManager;
  let scheduler: TaskScheduler;

  beforeEach(() => {
    db = createTestDb();
    eventBus = new EventBus();
    tm = new TaskManager(db, eventBus, { defaultTimeoutMs: 60000 });
    scheduler = new TaskScheduler(tm, eventBus, {
      maxConcurrencyPerAgent: 2,
      starvationBoostIntervalMs: 5000,
      starvationBoostAmount: 1,
    });
  });

  afterEach(() => {
    scheduler.dispose();
    tm.dispose();
  });

  function createTask(priority: number, agent = 'code' as const): string {
    return tm.create({
      sessionId: 'sess-1',
      correlationId: 'corr-1',
      taskType: 'test',
      requester: 'user',
      targetAgent: agent,
      inputPayload: {},
      priority,
    });
  }

  it('dispatches tasks up to concurrency limit', () => {
    const t1 = createTask(1);
    const t2 = createTask(1);
    const t3 = createTask(1);

    scheduler.enqueue(t1, 'code', 1);
    scheduler.enqueue(t2, 'code', 1);
    scheduler.enqueue(t3, 'code', 1);

    expect(tm.getTask(t1)!.status).toBe('dispatched');
    expect(tm.getTask(t2)!.status).toBe('dispatched');
    expect(tm.getTask(t3)!.status).toBe('created'); // blocked by concurrency limit
    expect(scheduler.getQueueLength('code')).toBe(1);
    expect(scheduler.getActiveCount('code')).toBe(2);
  });

  it('dispatches next task when one completes', () => {
    const t1 = createTask(1);
    const t2 = createTask(1);
    const t3 = createTask(1);

    scheduler.enqueue(t1, 'code', 1);
    scheduler.enqueue(t2, 'code', 1);
    scheduler.enqueue(t3, 'code', 1);

    // Complete t1
    tm.acknowledge(t1);
    tm.start(t1);
    tm.complete(t1, {});

    // t3 should now be dispatched
    expect(tm.getTask(t3)!.status).toBe('dispatched');
    expect(scheduler.getQueueLength('code')).toBe(0);
  });

  it('dispatches higher priority tasks first', () => {
    const tLow = createTask(0);
    const tHigh = createTask(3);
    const tMid = createTask(1);

    // Fill slots first
    const t1 = createTask(1);
    const t2 = createTask(1);
    scheduler.enqueue(t1, 'code', 1);
    scheduler.enqueue(t2, 'code', 1);

    // Now enqueue the prioritized ones (they'll be queued)
    scheduler.enqueue(tLow, 'code', 0);
    scheduler.enqueue(tHigh, 'code', 3);
    scheduler.enqueue(tMid, 'code', 1);

    // Complete one active task to trigger dispatch
    tm.acknowledge(t1);
    tm.start(t1);
    tm.complete(t1, {});

    // tHigh should be dispatched (highest priority)
    expect(tm.getTask(tHigh)!.status).toBe('dispatched');
    expect(tm.getTask(tMid)!.status).toBe('created');
    expect(tm.getTask(tLow)!.status).toBe('created');
  });

  it('starvation boost increases effective priority over time', () => {
    const item = {
      taskId: 'tsk-1',
      targetAgent: 'code' as const,
      basePriority: 0,
      enqueuedAt: Date.now() - 25000, // 25s ago
    };

    // With 5s interval and +1 boost: 25s / 5s = 5 boosts
    const effective = scheduler.getEffectivePriority(item);
    expect(effective).toBe(5);
  });

  it('handles independent agent queues', () => {
    const tCode = createTask(1, 'code');
    const tLearn = createTask(1, 'learning' as any);

    scheduler.enqueue(tCode, 'code', 1);
    scheduler.enqueue(tLearn, 'learning', 1);

    expect(tm.getTask(tCode)!.status).toBe('dispatched');
    expect(tm.getTask(tLearn)!.status).toBe('dispatched');
    expect(scheduler.getActiveCount('code')).toBe(1);
    expect(scheduler.getActiveCount('learning')).toBe(1);
  });

  it('removes cancelled tasks from queue', () => {
    const t1 = createTask(1);
    const t2 = createTask(1);
    const t3 = createTask(1);

    scheduler.enqueue(t1, 'code', 1);
    scheduler.enqueue(t2, 'code', 1);
    scheduler.enqueue(t3, 'code', 1);

    // t3 is queued, cancel it
    tm.cancel(t3, 'test');
    expect(scheduler.getQueueLength('code')).toBe(0);
  });
});

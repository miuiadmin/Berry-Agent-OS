import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  computeBackoff,
  DeadLetterQueue,
  BackpressureMonitor,
  PrioritySendQueue,
} from './ipc-resilience.js';
import type { IpcMessage } from './types.js';

function makeMsg(overrides: Partial<IpcMessage> = {}): IpcMessage {
  return {
    id: 'msg-1',
    type: 'user.message',
    from: 'agent-a',
    to: 'agent-b',
    payload: { text: 'hello' },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('computeBackoff', () => {
  it('returns increasing delays for higher attempts', () => {
    const d0 = computeBackoff(0, { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 15000 });
    const d1 = computeBackoff(1, { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 15000 });
    const d2 = computeBackoff(2, { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 15000 });
    expect(d0).toBeLessThan(d1);
    expect(d1).toBeLessThan(d2);
  });

  it('respects maxDelayMs cap', () => {
    const d = computeBackoff(10, { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 5000 });
    expect(d).toBeLessThanOrEqual(5000);
  });

  it('applies jitter (not purely deterministic)', () => {
    const results = new Set<number>();
    for (let i = 0; i < 20; i++) {
      results.add(Math.round(computeBackoff(1)));
    }
    expect(results.size).toBeGreaterThan(1);
  });
});

describe('DeadLetterQueue', () => {
  function createDb(): InstanceType<typeof Database> {
    return new Database(':memory:');
  }

  it('enqueues and lists dead letters', () => {
    const db = createDb();
    const dlq = new DeadLetterQueue(db);
    const msg = makeMsg();

    dlq.enqueue(msg, 'timeout', 3);
    const letters = dlq.list();

    expect(letters).toHaveLength(1);
    expect(letters[0].id).toBe('msg-1');
    expect(letters[0].reason).toBe('timeout');
    expect(letters[0].attempts).toBe(3);
    expect(letters[0].message.type).toBe('user.message');
  });

  it('filters by target agent', () => {
    const db = createDb();
    const dlq = new DeadLetterQueue(db);

    dlq.enqueue(makeMsg({ id: 'm1', to: 'agent-x' }), 'timeout', 1);
    dlq.enqueue(makeMsg({ id: 'm2', to: 'agent-y' }), 'timeout', 1);

    expect(dlq.list('agent-x')).toHaveLength(1);
    expect(dlq.list('agent-y')).toHaveLength(1);
    expect(dlq.list('agent-z')).toHaveLength(0);
  });

  it('removes a dead letter by id', () => {
    const db = createDb();
    const dlq = new DeadLetterQueue(db);
    dlq.enqueue(makeMsg(), 'disconnect', 1);

    dlq.remove('msg-1');
    expect(dlq.list()).toHaveLength(0);
  });

  it('purges old entries', () => {
    const db = createDb();
    const dlq = new DeadLetterQueue(db);
    dlq.enqueue(makeMsg({ id: 'old' }), 'timeout', 1);

    // Backdate the created_at
    db.prepare('UPDATE ipc_dead_letters SET created_at = ? WHERE id = ?')
      .run(Date.now() - 100_000, 'old');

    const purged = dlq.purgeOlderThan(50_000);
    expect(purged).toBe(1);
    expect(dlq.list()).toHaveLength(0);
  });
});

describe('BackpressureMonitor', () => {
  it('tracks pending counts per agent', () => {
    const monitor = new BackpressureMonitor({ maxPendingPerAgent: 10, warningThreshold: 8 });
    monitor.increment('a');
    monitor.increment('a');
    monitor.increment('b');

    expect(monitor.getCount('a')).toBe(2);
    expect(monitor.getCount('b')).toBe(1);
  });

  it('returns false when overloaded', () => {
    const monitor = new BackpressureMonitor({ maxPendingPerAgent: 3, warningThreshold: 2 });
    expect(monitor.increment('a')).toBe(true);
    expect(monitor.increment('a')).toBe(true);
    expect(monitor.increment('a')).toBe(false); // count=3, maxPending=3
  });

  it('fires listener at warning threshold', () => {
    const listener = vi.fn();
    const monitor = new BackpressureMonitor({ maxPendingPerAgent: 10, warningThreshold: 2 });
    monitor.onBackpressure(listener);

    monitor.increment('a'); // count=1, below threshold
    expect(listener).not.toHaveBeenCalled();

    monitor.increment('a'); // count=2, at threshold
    expect(listener).toHaveBeenCalledWith('a', 2);
  });

  it('decrements correctly', () => {
    const monitor = new BackpressureMonitor();
    monitor.increment('a');
    monitor.increment('a');
    monitor.decrement('a');
    expect(monitor.getCount('a')).toBe(1);
    monitor.decrement('a');
    expect(monitor.getCount('a')).toBe(0);
    monitor.decrement('a'); // below zero guard
    expect(monitor.getCount('a')).toBe(0);
  });
});

describe('PrioritySendQueue', () => {
  it('sends messages in priority order', () => {
    const sent: string[] = [];
    const queue = new PrioritySendQueue((msg) => {
      sent.push(msg.id);
      return true;
    });

    queue.enqueue(makeMsg({ id: 'low' }), 0);
    queue.enqueue(makeMsg({ id: 'high' }), 2);
    queue.enqueue(makeMsg({ id: 'mid' }), 1);

    expect(sent).toEqual(['low', 'high', 'mid']);
  });

  it('retains messages when send fails', () => {
    let shouldFail = true;
    const queue = new PrioritySendQueue(() => {
      if (shouldFail) return false;
      return true;
    });

    queue.enqueue(makeMsg({ id: 'stuck' }), 0);
    expect(queue.pending).toBe(1);

    shouldFail = false;
    queue.retry();
    expect(queue.pending).toBe(0);
  });
});

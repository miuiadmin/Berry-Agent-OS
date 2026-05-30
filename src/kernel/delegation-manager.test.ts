import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { DelegationManager } from './delegation-manager.js';
import { TaskManager } from './task-manager.js';
import { initEventBus, getEventBus } from './event-bus.js';
import { CORE_SCHEMA_SQL, CORE_INDEX_SQL } from '../memory/schema.js';
import type { TurnOutputPayload, CreateDelegationParams } from '../contracts/delegation.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(CORE_SCHEMA_SQL);
  db.exec(CORE_INDEX_SQL);
  return db;
}

function defaultParams(overrides?: Partial<CreateDelegationParams>): CreateDelegationParams {
  return {
    sessionId: 'sess-1',
    correlationId: 'corr-1',
    targetAgent: 'code',
    targetKind: 'internal',
    userMessage: 'hello',
    taskType: 'code_task',
    requester: 'brain-route',
    inputPayload: { message: 'hello' },
    foreground: true,
    ...overrides,
  };
}

describe('DelegationManager', () => {
  let db: Database.Database;
  let taskManager: TaskManager;
  let dm: DelegationManager;

  beforeEach(() => {
    db = createTestDb();
    const eventBus = initEventBus();
    taskManager = new TaskManager(db, eventBus, { defaultTimeoutMs: 60000 });
    dm = new DelegationManager(taskManager);
  });

  afterEach(() => {
    db.close();
  });

  describe('lifecycle', () => {
    it('create returns a valid task ID and sets state to delegated', () => {
      const id = dm.create(defaultParams());
      expect(id).toMatch(/^tsk[_-]/);

      const entry = dm.get(id);
      expect(entry).toBeDefined();
      expect(entry!.state).toBe('delegated');
      expect(entry!.sessionId).toBe('sess-1');
      expect(entry!.correlationId).toBe('corr-1');
      expect(entry!.targetAgent).toBe('code');
    });

    it('full lifecycle: create → acknowledge → submitForReview → complete', () => {
      const id = dm.create(defaultParams());

      expect(dm.acknowledge(id)).toBe(true);
      expect(dm.get(id)!.state).toBe('active');

      expect(dm.submitForReview(id, { delegationId: id, response: 'done' })).toBe(true);
      expect(dm.get(id)!.state).toBe('reviewing');

      expect(dm.complete(id, 'final result')).toBe(true);
      expect(dm.get(id)!.state).toBe('completed');
      expect(dm.get(id)!.finalResponse).toBe('final result');
    });

    it('fail transitions from any non-terminal state', () => {
      const id = dm.create(defaultParams());
      expect(dm.fail(id, 'some error')).toBe(true);
      expect(dm.get(id)!.state).toBe('failed');
    });

    it('fail from active state', () => {
      const id = dm.create(defaultParams());
      dm.acknowledge(id);
      expect(dm.fail(id, 'error')).toBe(true);
      expect(dm.get(id)!.state).toBe('failed');
    });

    it('cannot fail a terminal entry', () => {
      const id = dm.create(defaultParams());
      dm.acknowledge(id);
      dm.submitForReview(id, { delegationId: id, response: 'x' });
      dm.complete(id, 'done');
      expect(dm.fail(id, 'late error')).toBe(false);
    });

    it('cannot complete a terminal entry', () => {
      const id = dm.create(defaultParams());
      dm.fail(id, 'early fail');
      expect(dm.complete(id, 'too late')).toBe(false);
    });

    it('markAskingUser and resumeFromUserReply', () => {
      const id = dm.create(defaultParams());
      dm.acknowledge(id);

      expect(dm.markAskingUser(id, 'which file?')).toBe(true);
      expect(dm.get(id)!.state).toBe('awaiting_user');

      expect(dm.resumeFromUserReply(id)).toBe(true);
      expect(dm.get(id)!.state).toBe('active');
    });

    it('interrupt sets state to failed', () => {
      const id = dm.create(defaultParams());
      dm.acknowledge(id);
      expect(dm.interrupt(id, 'user stopped')).toBe(true);
      expect(dm.get(id)!.state).toBe('failed');
    });
  });

  describe('invalid transitions', () => {
    it('acknowledge from non-delegated state returns false', () => {
      const id = dm.create(defaultParams());
      dm.acknowledge(id);
      expect(dm.acknowledge(id)).toBe(false);
    });

    it('submitForReview from delegated state succeeds (graceful for late acknowledge)', () => {
      const id = dm.create(defaultParams());
      expect(dm.submitForReview(id, { delegationId: id, response: 'x' })).toBe(true);
      expect(dm.get(id)!.state).toBe('reviewing');
    });

    it('markAskingUser from non-active state returns false', () => {
      const id = dm.create(defaultParams());
      expect(dm.markAskingUser(id, 'q')).toBe(false);
    });

    it('resumeFromUserReply from non-awaiting state returns false', () => {
      const id = dm.create(defaultParams());
      dm.acknowledge(id);
      expect(dm.resumeFromUserReply(id)).toBe(false);
    });
  });

  describe('query methods', () => {
    it('getByCorrelation returns correct entry', () => {
      const id = dm.create(defaultParams({ correlationId: 'my-corr' }));
      const entry = dm.getByCorrelation('my-corr');
      expect(entry).toBeDefined();
      expect(entry!.id).toBe(id);
    });

    it('getByCorrelation returns undefined for unknown', () => {
      expect(dm.getByCorrelation('unknown')).toBeUndefined();
    });

    it('getActiveForSession returns non-terminal entries', () => {
      const id1 = dm.create(defaultParams({ correlationId: 'c1' }));
      const id2 = dm.create(defaultParams({ correlationId: 'c2' }));
      dm.fail(id2, 'failed');

      const active = dm.getActiveForSession('sess-1');
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(id1);
    });
  });

  describe('metrics and ring buffer', () => {
    it('recordOutput accumulates usage tokens', () => {
      const id = dm.create(defaultParams());
      dm.acknowledge(id);

      dm.recordOutput(id, { delegationId: id, kind: 'usage', data: { inputTokens: 100, outputTokens: 50 } });
      dm.recordOutput(id, { delegationId: id, kind: 'usage', data: { inputTokens: 200, outputTokens: 80 } });

      const entry = dm.get(id)!;
      expect(entry.metrics.tokenUsed.input).toBe(300);
      expect(entry.metrics.tokenUsed.output).toBe(130);
    });

    it('recordOutput tracks tool calls and failures', () => {
      const id = dm.create(defaultParams());
      dm.acknowledge(id);

      dm.recordOutput(id, { delegationId: id, kind: 'tool_result', data: { toolName: 'shell' } });
      dm.recordOutput(id, { delegationId: id, kind: 'tool_error', data: { toolName: 'shell' } });
      dm.recordOutput(id, { delegationId: id, kind: 'tool_error', data: { toolName: 'shell' } });

      const m = dm.get(id)!.metrics;
      expect(m.toolCallCount).toBe(3);
      expect(m.consecutiveToolFailures).toBe(2);
      expect(m.sameToolRepeatCount).toBe(3);
    });

    it('tool_result resets consecutiveToolFailures', () => {
      const id = dm.create(defaultParams());
      dm.acknowledge(id);

      dm.recordOutput(id, { delegationId: id, kind: 'tool_error', data: { toolName: 'a' } });
      dm.recordOutput(id, { delegationId: id, kind: 'tool_error', data: { toolName: 'a' } });
      dm.recordOutput(id, { delegationId: id, kind: 'tool_result', data: { toolName: 'a' } });

      expect(dm.get(id)!.metrics.consecutiveToolFailures).toBe(0);
    });

    it('ring buffer caps at 10 outputs', () => {
      const id = dm.create(defaultParams());
      dm.acknowledge(id);

      for (let i = 0; i < 15; i++) {
        dm.recordOutput(id, { delegationId: id, kind: 'usage', data: { inputTokens: 1, outputTokens: 1 } });
      }

      expect(dm.get(id)!.outputs).toHaveLength(10);
    });
  });

  describe('Layer 1 guards', () => {
    it('terminates on output token budget exceeded', () => {
      const id = dm.create(defaultParams({ budget: { maxOutputTokens: 100, maxToolCalls: 30, maxDurationMs: 300000, maxReRouteDepth: 2 } }));
      dm.acknowledge(id);

      dm.recordOutput(id, { delegationId: id, kind: 'usage', data: { inputTokens: 0, outputTokens: 101 } });
      expect(dm.get(id)!.state).toBe('failed');
    });

    it('terminates on tool call limit', () => {
      const id = dm.create(defaultParams({ budget: { maxOutputTokens: 50000, maxToolCalls: 3, maxDurationMs: 300000, maxReRouteDepth: 2 } }));
      dm.acknowledge(id);

      dm.recordOutput(id, { delegationId: id, kind: 'tool_result', data: { toolName: 'a' } });
      dm.recordOutput(id, { delegationId: id, kind: 'tool_result', data: { toolName: 'b' } });
      dm.recordOutput(id, { delegationId: id, kind: 'tool_result', data: { toolName: 'c' } });

      expect(dm.get(id)!.state).toBe('failed');
    });

    it('emits checkpoint on consecutive failures', () => {
      const events: { delegationId: string; trigger: string }[] = [];
      getEventBus().on('delegation.checkpoint_needed', (e) => events.push(e));

      const id = dm.create(defaultParams());
      dm.acknowledge(id);

      dm.recordOutput(id, { delegationId: id, kind: 'tool_error', data: { toolName: 'x' } });
      dm.recordOutput(id, { delegationId: id, kind: 'tool_error', data: { toolName: 'x' } });
      dm.recordOutput(id, { delegationId: id, kind: 'tool_error', data: { toolName: 'x' } });

      expect(events).toHaveLength(1);
      expect(events[0].trigger).toBe('consecutive_tool_failures');
      expect(dm.get(id)!.state).toBe('active');
    });

    it('emits checkpoint on budget warning at 70%', () => {
      const events: { delegationId: string; trigger: string }[] = [];
      getEventBus().on('delegation.checkpoint_needed', (e) => events.push(e));

      const id = dm.create(defaultParams({ budget: { maxOutputTokens: 100, maxToolCalls: 30, maxDurationMs: 300000, maxReRouteDepth: 2 } }));
      dm.acknowledge(id);

      dm.recordOutput(id, { delegationId: id, kind: 'usage', data: { inputTokens: 0, outputTokens: 71 } });

      expect(events).toHaveLength(1);
      expect(events[0].trigger).toBe('budget_warning');
    });

    it('budget warning only fires once', () => {
      const events: { delegationId: string; trigger: string }[] = [];
      getEventBus().on('delegation.checkpoint_needed', (e) => events.push(e));

      const id = dm.create(defaultParams({ budget: { maxOutputTokens: 200, maxToolCalls: 30, maxDurationMs: 300000, maxReRouteDepth: 2 } }));
      dm.acknowledge(id);

      dm.recordOutput(id, { delegationId: id, kind: 'usage', data: { inputTokens: 0, outputTokens: 141 } });
      dm.recordOutput(id, { delegationId: id, kind: 'usage', data: { inputTokens: 0, outputTokens: 10 } });

      const budgetWarnings = events.filter(e => e.trigger === 'budget_warning');
      expect(budgetWarnings).toHaveLength(1);
    });

    it('emits checkpoint on same tool repeat >= 5', () => {
      const events: { delegationId: string; trigger: string }[] = [];
      getEventBus().on('delegation.checkpoint_needed', (e) => events.push(e));

      const id = dm.create(defaultParams());
      dm.acknowledge(id);

      for (let i = 0; i < 5; i++) {
        dm.recordOutput(id, { delegationId: id, kind: 'tool_result', data: { toolName: 'shell' } });
      }

      const repeats = events.filter(e => e.trigger === 'same_tool_repeat');
      expect(repeats.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('reportUncertainty', () => {
    it('emits checkpoint with agent_uncertainty trigger', () => {
      const events: { delegationId: string; trigger: string }[] = [];
      getEventBus().on('delegation.checkpoint_needed', (e) => events.push(e));

      const id = dm.create(defaultParams());
      dm.acknowledge(id);

      dm.reportUncertainty(id, 'consecutive permission denials');

      expect(events).toHaveLength(1);
      expect(events[0].delegationId).toBe(id);
      expect(events[0].trigger).toBe('agent_uncertainty');
    });

    it('respects checkpoint count limit', () => {
      const events: { delegationId: string; trigger: string }[] = [];
      getEventBus().on('delegation.checkpoint_needed', (e) => events.push(e));

      const id = dm.create(defaultParams());
      dm.acknowledge(id);

      // Force past the min interval by manipulating lastCheckpointAt
      for (let i = 0; i < 5; i++) {
        const entry = dm.get(id)!;
        entry.lastCheckpointAt = undefined;
        dm.reportUncertainty(id, `attempt ${i}`);
      }

      // CORRECTION_LIMITS.maxCheckpointsPerDelegation = 3
      expect(events).toHaveLength(3);
    });

    it('throttles by min interval', () => {
      const events: { delegationId: string; trigger: string }[] = [];
      getEventBus().on('delegation.checkpoint_needed', (e) => events.push(e));

      const id = dm.create(defaultParams());
      dm.acknowledge(id);

      dm.reportUncertainty(id, 'first');
      dm.reportUncertainty(id, 'second (too soon)');

      expect(events).toHaveLength(1);
    });

    it('ignores non-active delegations', () => {
      const events: { delegationId: string; trigger: string }[] = [];
      getEventBus().on('delegation.checkpoint_needed', (e) => events.push(e));

      const id = dm.create(defaultParams());
      // state is 'delegated', not 'active'

      dm.reportUncertainty(id, 'should be ignored');
      expect(events).toHaveLength(0);
    });
  });

  describe('multi-route groups', () => {
    it('createGroup and completeChild tracks progress', () => {
      dm.createGroup('parent-1', 'group-corr', 'sess-1');

      const child1 = dm.create(defaultParams({ correlationId: 'c1' }));
      const child2 = dm.create(defaultParams({ correlationId: 'c2' }));

      dm.addChildToGroup('group-corr', child1);
      dm.addChildToGroup('group-corr', child2);

      expect(dm.completeChild('group-corr', child1, 'code', 'result1')).toBe(false);
      expect(dm.completeChild('group-corr', child2, 'skills', 'result2')).toBe(true);

      const group = dm.getGroup('group-corr');
      expect(group!.completedResults.size).toBe(2);
    });

    it('removeGroup cleans up', () => {
      dm.createGroup('p', 'g-corr', 'sess-1');
      expect(dm.getGroup('g-corr')).toBeDefined();
      dm.removeGroup('g-corr');
      expect(dm.getGroup('g-corr')).toBeUndefined();
    });
  });

  describe('sweepStale', () => {
    it('fails non-terminal entries older than maxAge', () => {
      const id = dm.create(defaultParams());
      dm.acknowledge(id);

      const entry = dm.get(id)!;
      (entry as any).createdAt = Date.now() - 700_000;

      const swept = dm.sweepStale(600_000);
      expect(swept).toBeGreaterThanOrEqual(1);
      expect(dm.get(id)!.state).toBe('failed');
    });

    it('does not fail terminal entries', () => {
      const id = dm.create(defaultParams());
      dm.acknowledge(id);
      dm.submitForReview(id, { delegationId: id, response: 'x' });
      dm.complete(id, 'done');

      const entry = dm.get(id)!;
      (entry as any).createdAt = Date.now() - 700_000;

      dm.sweepStale(600_000);
      expect(dm.get(id)!.state).toBe('completed');
    });
  });

  describe('failByAgent', () => {
    it('fails all active delegations for a given agent', () => {
      const id1 = dm.create(defaultParams({ correlationId: 'c1', targetAgent: 'code' }));
      const id2 = dm.create(defaultParams({ correlationId: 'c2', targetAgent: 'code' }));
      const id3 = dm.create(defaultParams({ correlationId: 'c3', targetAgent: 'skills' }));
      dm.acknowledge(id1);
      dm.acknowledge(id2);

      const count = dm.failByAgent('code', 'agent crashed');
      expect(count).toBe(2);
      expect(dm.get(id1)!.state).toBe('failed');
      expect(dm.get(id2)!.state).toBe('failed');
      expect(dm.get(id3)!.state).toBe('delegated');
    });
  });

  describe('events', () => {
    it('emits delegation.created on create', () => {
      const events: any[] = [];
      getEventBus().on('delegation.created', (e) => events.push(e));

      dm.create(defaultParams());
      expect(events).toHaveLength(1);
      expect(events[0].targetAgent).toBe('code');
    });

    it('emits delegation.completed on complete', () => {
      const events: any[] = [];
      getEventBus().on('delegation.completed', (e) => events.push(e));

      const id = dm.create(defaultParams());
      dm.acknowledge(id);
      dm.submitForReview(id, { delegationId: id, response: 'r' });
      dm.complete(id, 'done');

      expect(events).toHaveLength(1);
      expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('emits delegation.failed on fail', () => {
      const events: any[] = [];
      getEventBus().on('delegation.failed', (e) => events.push(e));

      const id = dm.create(defaultParams());
      dm.fail(id, 'oops');

      expect(events).toHaveLength(1);
      expect(events[0].error).toBe('oops');
    });
  });
});

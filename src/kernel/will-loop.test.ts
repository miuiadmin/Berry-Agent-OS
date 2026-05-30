import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { WillLoop, type WillLoopConfig } from './will-loop.js';
import { WorldModelRuntime } from './world-model.js';
import { CapabilityBus } from '../bus/capability-bus.js';

function createMockLlm(response: string) {
  return {
    chat: vi.fn().mockResolvedValue({ content: response }),
  } as any;
}

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE world_model (id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE brain_decisions (id TEXT PRIMARY KEY, session_id TEXT, decision_type TEXT, input_summary TEXT, output_json TEXT, confidence REAL, outcome TEXT, feedback_source TEXT, created_at INTEGER);
  `);
  return db;
}

describe('WillLoop', () => {
  let db: Database.Database;
  let worldModel: WorldModelRuntime;
  let bus: CapabilityBus;

  beforeEach(() => {
    db = setupDb();
    worldModel = new WorldModelRuntime(db);
    bus = new CapabilityBus();
  });

  afterEach(() => {
    db.close();
  });

  it('skips tick when world model has no notable state', async () => {
    const llm = createMockLlm('{}');
    const loop = new WillLoop(llm, worldModel, bus, db, { enabled: true, intervalMs: 999999, maxActionsPerHour: 5, maxAutoDangerLevel: 'moderate' });

    const result = await loop.tick();
    expect(result).toBeNull();
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('deliberates when world model has state', async () => {
    worldModel.updateFromEvent({ type: 'ci', source: 'github', summary: 'Build failed', severity: 'warning' });

    const llm = createMockLlm(JSON.stringify({
      action: 'observe',
      description: 'CI failure noted',
      reason: 'not actionable yet',
      dangerLevel: 'safe',
      confidence: 0.3,
    }));
    const loop = new WillLoop(llm, worldModel, bus, db, { enabled: true, intervalMs: 999999, maxActionsPerHour: 5, maxAutoDangerLevel: 'moderate' });

    const result = await loop.tick();
    expect(result?.action).toBe('observe');
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it('enforces rate limiting', async () => {
    worldModel.updateFromEvent({ type: 'x', source: 'y', summary: 'z', severity: 'info' });

    let callCount = 0;
    const llm = {
      chat: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({ content: JSON.stringify({
          action: 'execute',
          description: `action-${callCount}`,
          capability: 'test_cap',
          reason: 'testing',
          dangerLevel: 'safe',
          confidence: 0.9,
        }) });
      }),
    } as any;

    bus.register(
      { name: 'test_cap', description: 'test', dangerLevel: 'safe', provider: { type: 'builtin', name: 'test' } },
      async () => 'done',
    );

    const loop = new WillLoop(llm, worldModel, bus, db, { enabled: true, intervalMs: 999999, maxActionsPerHour: 2, maxAutoDangerLevel: 'moderate' });

    await loop.tick();
    await loop.tick();
    const blocked = await loop.tick();

    expect(blocked).toBeNull(); // rate limited
  });

  it('blocks actions exceeding danger level', async () => {
    worldModel.updateFromEvent({ type: 'x', source: 'y', summary: 'z', severity: 'info' });

    const llm = createMockLlm(JSON.stringify({
      action: 'execute',
      description: 'dangerous thing',
      capability: 'danger_cap',
      reason: 'seems important',
      dangerLevel: 'dangerous',
      confidence: 0.9,
    }));

    const loop = new WillLoop(llm, worldModel, bus, db, { enabled: true, intervalMs: 999999, maxActionsPerHour: 5, maxAutoDangerLevel: 'safe' });

    const result = await loop.tick();
    expect(result?.action).toBe('observe'); // downgraded
  });

  it('blocks low-confidence execution', async () => {
    worldModel.updateFromEvent({ type: 'x', source: 'y', summary: 'z', severity: 'info' });

    const llm = createMockLlm(JSON.stringify({
      action: 'execute',
      description: 'uncertain action',
      capability: 'some_cap',
      reason: 'maybe',
      dangerLevel: 'safe',
      confidence: 0.5, // below 0.8 threshold
    }));

    const loop = new WillLoop(llm, worldModel, bus, db, { enabled: true, intervalMs: 999999, maxActionsPerHour: 5, maxAutoDangerLevel: 'moderate' });

    const result = await loop.tick();
    expect(result?.action).toBe('observe');
  });

  it('deduplicates identical recent decisions', async () => {
    worldModel.updateFromEvent({ type: 'x', source: 'y', summary: 'z', severity: 'info' });

    const llm = createMockLlm(JSON.stringify({
      action: 'suggest',
      description: 'same suggestion',
      reason: 'repeating',
      dangerLevel: 'safe',
      confidence: 0.7,
    }));
    bus.register(
      { name: 'noop', description: 'test', dangerLevel: 'safe', provider: { type: 'builtin', name: 'test' } },
      async () => 'ok',
    );

    const loop = new WillLoop(llm, worldModel, bus, db, { enabled: true, intervalMs: 999999, maxActionsPerHour: 10, maxAutoDangerLevel: 'moderate' });

    // First time: proceeds (suggest is always allowed)
    const r1 = await loop.tick();
    expect(r1?.action).toBe('suggest');

    // Second time with same description: execute would be blocked, but suggest passes dedup
    // Let's test with execute to show dedup works
    llm.chat.mockResolvedValue({ content: JSON.stringify({
      action: 'execute',
      description: 'same suggestion',
      capability: 'noop',
      reason: 'again',
      dangerLevel: 'safe',
      confidence: 0.9,
    }) });

    const r2 = await loop.tick();
    expect(r2?.action).toBe('observe'); // deduped
  });

  it('executes capability via Bus on approved action', async () => {
    worldModel.updateFromEvent({ type: 'x', source: 'y', summary: 'z', severity: 'info' });

    const executor = vi.fn().mockResolvedValue('executed!');
    bus.register(
      { name: 'auto_action', description: 'auto', dangerLevel: 'safe', provider: { type: 'builtin', name: 'test' } },
      executor,
    );

    const llm = createMockLlm(JSON.stringify({
      action: 'execute',
      description: 'auto execute test',
      capability: 'auto_action',
      input: { key: 'value' },
      reason: 'needed',
      dangerLevel: 'safe',
      confidence: 0.95,
    }));

    const loop = new WillLoop(llm, worldModel, bus, db, { enabled: true, intervalMs: 999999, maxActionsPerHour: 5, maxAutoDangerLevel: 'moderate' });

    const result = await loop.tick();
    expect(result?.action).toBe('execute');
    expect(executor).toHaveBeenCalledWith({ key: 'value' }, expect.anything());
  });

  it('records actions to brain_decisions audit', async () => {
    worldModel.updateFromEvent({ type: 'x', source: 'y', summary: 'z', severity: 'info' });

    bus.register(
      { name: 'audit_test', description: 'test', dangerLevel: 'safe', provider: { type: 'builtin', name: 'test' } },
      async () => 'ok',
    );

    const llm = createMockLlm(JSON.stringify({
      action: 'execute',
      description: 'auditable action',
      capability: 'audit_test',
      reason: 'testing audit',
      dangerLevel: 'safe',
      confidence: 0.9,
    }));

    const loop = new WillLoop(llm, worldModel, bus, db, { enabled: true, intervalMs: 999999, maxActionsPerHour: 5, maxAutoDangerLevel: 'moderate' });
    await loop.tick();

    const row = db.prepare(`SELECT * FROM brain_decisions WHERE session_id = 'will-loop'`).get() as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.input_summary).toContain('auditable action');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { WorldModelRuntime } from './world-model.js';

describe('WorldModelRuntime', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE world_model (
        id TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('initializes with default snapshot', () => {
    const wm = new WorldModelRuntime(db);
    const snapshot = wm.getSnapshot();

    expect(snapshot.user.currentActivity).toBeNull();
    expect(snapshot.user.energyLevel).toBe('unknown');
    expect(snapshot.temporal.turnsInSession).toBe(0);
    expect(snapshot.environment.platform).toBe(process.platform);
  });

  it('updates from conversation', () => {
    const wm = new WorldModelRuntime(db);

    wm.updateFromConversation({
      userMessage: '帮我重构这个模块的测试',
      assistantResponse: '好的，我来看看测试文件',
      sessionId: 'sess-1',
    });

    const snapshot = wm.getSnapshot();
    expect(snapshot.temporal.turnsInSession).toBe(1);
    expect(snapshot.user.lastInteractionAt).not.toBeNull();
    expect(snapshot.user.recentTopics.length).toBeGreaterThan(0);
  });

  it('detects frustration signals', () => {
    const wm = new WorldModelRuntime(db);

    wm.updateFromConversation({
      userMessage: '不对，这个又错了',
      assistantResponse: '抱歉',
      sessionId: 'sess-1',
    });
    wm.updateFromConversation({
      userMessage: '还是不行，为什么总出问题',
      assistantResponse: '让我重新检查',
      sessionId: 'sess-1',
    });

    expect(wm.getSnapshot().user.frustrationSignals).toBeGreaterThanOrEqual(2);
  });

  it('persists and reloads snapshot', () => {
    const wm1 = new WorldModelRuntime(db);
    wm1.updateFromConversation({ userMessage: 'hello', assistantResponse: 'hi', sessionId: 's' });

    const wm2 = new WorldModelRuntime(db);
    expect(wm2.getSnapshot().temporal.turnsInSession).toBe(1);
  });

  it('generates summary from state', () => {
    const wm = new WorldModelRuntime(db);

    // Inject some state for summary
    const snapshot = wm.getSnapshot();
    snapshot.user.frustrationSignals = 5;
    snapshot.user.currentActivity = '调试 API 问题';
    snapshot.temporal.upcomingDeadlines = [{ description: '发布 v2.0', dueAt: Date.now() + 3600_000 }];
    // Force persist
    (wm as any).snapshot = snapshot;
    (wm as any).persist();

    const wm2 = new WorldModelRuntime(db);
    const summary = wm2.getSummary();
    expect(summary).toContain('调试 API 问题');
    expect(summary).toContain('挫败感');
    expect(summary).toContain('发布 v2.0');
  });

  it('handles external events', () => {
    const wm = new WorldModelRuntime(db);

    wm.updateFromEvent({
      type: 'ci_failure',
      source: 'github',
      summary: 'Build failed on main',
      severity: 'warning',
    });

    const events = wm.getSnapshot().environment.externalEvents;
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('github');
    expect(events[0].handled).toBe(false);
  });

  it('resets session state', () => {
    const wm = new WorldModelRuntime(db);
    wm.updateFromConversation({ userMessage: '错了', assistantResponse: 'ok', sessionId: 's' });
    wm.updateFromConversation({ userMessage: '又错了', assistantResponse: 'ok', sessionId: 's' });

    wm.resetSession();

    const snapshot = wm.getSnapshot();
    expect(snapshot.temporal.turnsInSession).toBe(0);
    expect(snapshot.user.frustrationSignals).toBe(0);
  });
});

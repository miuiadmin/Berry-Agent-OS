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

  /**
   * 13.0 §3.1 修复：sessionDurationMs 计算逻辑 bug。
   * 旧版先设 lastInteractionAt=now 再用它算 duration，导致恒为 0。
   */
  it('sessionDurationMs 正确累计（非零）— 修复旧版恒为 0 的 bug', async () => {
    const wm = new WorldModelRuntime(db);
    wm.updateFromConversation({ userMessage: '第一条', assistantResponse: 'ok', sessionId: 's' });

    // 模拟时间流逝
    const start = wm.getSnapshot().temporal.sessionStartedAt!;
    expect(start).not.toBeNull();

    await new Promise((r) => setTimeout(r, 50));
    wm.updateFromConversation({ userMessage: '第二条', assistantResponse: 'ok', sessionId: 's' });

    const duration = wm.getSnapshot().temporal.sessionDurationMs;
    // duration 应 > 0（修复前恒为 0）
    expect(duration).toBeGreaterThan(0);
    // sessionStartedAt 在首轮锚定后保持不变
    expect(wm.getSnapshot().temporal.sessionStartedAt).toBe(start);
  });

  /**
   * 13.0 §3.1 新增：energyLevel 推断（旧版恒为 unknown）。
   */
  it('energyLevel 推断：挫败信号多 → frustrated，正常交互 → focused', () => {
    const wm = new WorldModelRuntime(db);

    // 正常交互 → focused
    wm.updateFromConversation({ userMessage: '帮我看看这个功能', assistantResponse: '好的', sessionId: 's' });
    expect(wm.getSnapshot().user.energyLevel).toBe('focused');

    // 累积挫败信号 → frustrated
    wm.updateFromConversation({ userMessage: '不对', assistantResponse: 'ok', sessionId: 's' });
    wm.updateFromConversation({ userMessage: '又错了', assistantResponse: 'ok', sessionId: 's' });
    wm.updateFromConversation({ userMessage: '还是不行', assistantResponse: 'ok', sessionId: 's' });

    expect(wm.getSnapshot().user.frustrationSignals).toBeGreaterThanOrEqual(3);
    expect(wm.getSnapshot().user.energyLevel).toBe('frustrated');
  });

  /**
   * 13.0 §3.1 新增：activeGoals 从工具调用推断（旧版恒为空）。
   */
  it('activeGoals 从工具调用推断', () => {
    const wm = new WorldModelRuntime(db);
    wm.updateFromConversation({
      userMessage: '帮我改代码',
      assistantResponse: 'ok',
      sessionId: 's',
      toolCalls: [{ name: 'edit_code' }, { name: 'run_command' }, { name: 'inspect_code' }],
    });

    const goals = wm.getSnapshot().user.activeGoals;
    expect(goals).toContain('代码修改');
    expect(goals).toContain('命令执行');
    expect(goals).toContain('代码分析');
  });

  /**
   * 13.0 §3.1 新增：currentActivity 取最近 topic（旧版恒为 null）。
   */
  it('currentActivity 取最近有意义 topic', () => {
    const wm = new WorldModelRuntime(db);
    wm.updateFromConversation({
      userMessage: '帮我重构认证模块',
      assistantResponse: 'ok',
      sessionId: 's',
    });

    expect(wm.getSnapshot().user.currentActivity).not.toBeNull();
    expect(wm.getSnapshot().user.currentActivity).toContain('重构认证');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TokenBudgetController } from './token-budget.js';
import { EventBus } from '../kernel/event-bus.js';
import { CORE_SCHEMA_SQL, CORE_INDEX_SQL } from '../memory/schema.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(CORE_SCHEMA_SQL);
  db.exec(CORE_INDEX_SQL);
  return db;
}

describe('TokenBudgetController', () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let ctrl: TokenBudgetController;

  beforeEach(() => {
    db = createTestDb();
    eventBus = new EventBus();
    ctrl = new TokenBudgetController(db, eventBus, {
      sessionLimit: 1000,
      agentLimit: 500,
      taskLimit: 300,
      dailyLimit: 5000,
      alertThresholds: { info: 0.5, warning: 0.75, critical: 0.9 },
    });
  });

  afterEach(() => {
    db.close();
  });

  it('记录用量并查询', () => {
    ctrl.recordUsage({
      sessionId: 'ses_1',
      agentName: 'conversation',
      inputTokens: 100,
      outputTokens: 50,
      model: 'test-model',
    });

    const usage = ctrl.getSessionUsage('ses_1');
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.totalTokens).toBe(150);
    expect(usage.budgetLimit).toBe(1000);
    expect(usage.budgetUsedPercent).toBeCloseTo(0.15);
  });

  it('累计计算多次用量', () => {
    ctrl.recordUsage({ sessionId: 'ses_1', agentName: 'conversation', inputTokens: 200, outputTokens: 100, model: 'm' });
    ctrl.recordUsage({ sessionId: 'ses_1', agentName: 'brain', inputTokens: 150, outputTokens: 50, model: 'm' });

    const session = ctrl.getSessionUsage('ses_1');
    expect(session.totalTokens).toBe(500);

    const agent = ctrl.getAgentUsage('ses_1', 'conversation');
    expect(agent.totalTokens).toBe(300);
  });

  it('跨 tier 时触发告警', () => {
    const alerts: unknown[] = [];
    eventBus.on('budget.alert' as any, (payload: unknown) => alerts.push(payload));

    // 300+200=500 tokens, session is at 50% (info), agent is at 100% (exceeded)
    ctrl.recordUsage({ sessionId: 'ses_1', agentName: 'conversation', inputTokens: 300, outputTokens: 200, model: 'm' });
    const sessionAlerts = alerts.filter((a: any) => a.scope === 'session');
    expect(sessionAlerts.length).toBe(1);
    expect((sessionAlerts[0] as any).tier).toBe('info');

    // Adding more: session goes to 80% (warning)
    alerts.length = 0;
    ctrl.recordUsage({ sessionId: 'ses_1', agentName: 'brain', inputTokens: 200, outputTokens: 100, model: 'm' });
    const sessionAlerts2 = alerts.filter((a: any) => a.scope === 'session');
    expect(sessionAlerts2.length).toBe(1);
    expect((sessionAlerts2[0] as any).tier).toBe('warning');
  });

  it('同 tier 不重复告警', () => {
    const alerts: unknown[] = [];
    eventBus.on('budget.alert' as any, (payload: unknown) => alerts.push(payload));

    ctrl.recordUsage({ sessionId: 'ses_1', agentName: 'conversation', inputTokens: 300, outputTokens: 200, model: 'm' });
    ctrl.recordUsage({ sessionId: 'ses_1', agentName: 'conversation', inputTokens: 10, outputTokens: 5, model: 'm' });

    const sessionAlerts = alerts.filter((a: any) => a.scope === 'session');
    expect(sessionAlerts.length).toBe(1);
  });

  it('exceeded 时 checkBudget 返回 allowed=false', () => {
    ctrl.recordUsage({ sessionId: 'ses_1', agentName: 'conversation', inputTokens: 600, outputTokens: 500, model: 'm' });

    const check = ctrl.checkBudget('session', 'ses_1');
    expect(check.allowed).toBe(false);
    expect(check.alert?.tier).toBe('exceeded');
  });

  it('不同 session 隔离', () => {
    ctrl.recordUsage({ sessionId: 'ses_1', agentName: 'conversation', inputTokens: 400, outputTokens: 100, model: 'm' });
    ctrl.recordUsage({ sessionId: 'ses_2', agentName: 'conversation', inputTokens: 50, outputTokens: 10, model: 'm' });

    expect(ctrl.getSessionUsage('ses_1').totalTokens).toBe(500);
    expect(ctrl.getSessionUsage('ses_2').totalTokens).toBe(60);
  });

  it('task scope 独立追踪', () => {
    ctrl.recordUsage({ sessionId: 'ses_1', agentName: 'code', taskId: 'task_1', inputTokens: 200, outputTokens: 80, model: 'm' });
    ctrl.recordUsage({ sessionId: 'ses_1', agentName: 'code', taskId: 'task_2', inputTokens: 50, outputTokens: 20, model: 'm' });

    expect(ctrl.getTaskUsage('task_1').totalTokens).toBe(280);
    expect(ctrl.getTaskUsage('task_2').totalTokens).toBe(70);
  });

  it('estimateCost 计算正确', () => {
    const cost = ctrl.estimateCost(1000, 500);
    expect(cost).toBeCloseTo(1000 * 0.000003 + 500 * 0.000015);
  });
});

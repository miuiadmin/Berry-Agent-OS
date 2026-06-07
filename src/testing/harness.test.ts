import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestHarness } from './harness.js';

describe('TestHarness E2E', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = new TestHarness({ timeoutMs: 30000 });
    await harness.start();
  }, 60000);

  afterAll(async () => {
    await harness.stop();
  }, 30000);

  it('服务前台启动成功（mock 模式）', async () => {
    const status = await harness.getStatus();
    expect(status.brain).toBeDefined();
    expect(status.brain.status).toBe('ready');
    expect(status.conversation).toBeDefined();
    expect(status.conversation.status).toBe('ready');
  });

  it('发送消息后收到响应', async () => {
    const result = await harness.sendMessage('你好');
    expect(result).toBeDefined();
    expect(result.sessionId).toBeTruthy();
    expect(result.taskId).toBeTruthy();
    expect(typeof result.response).toBe('string');
  });

  it('agent_tasks 表有 conversation_turn 记录', async () => {
    const db = harness.getDb();
    const rows = db.prepare(
      `SELECT * FROM agent_tasks WHERE task_type = 'conversation_turn'`,
    ).all() as Array<{ id: string; status: string; target_agent: string }>;

    expect(rows.length).toBeGreaterThan(0);
    const completed = rows.filter((r) => r.status === 'completed');
    expect(completed.length).toBeGreaterThan(0);
    expect(completed[0].target_agent).toBe('conversation');
  });

  it('review_requests 表有审核记录', async () => {
    const db = harness.getDb();
    const rows = db.prepare(`SELECT * FROM review_requests`).all() as Array<{
      id: string;
      verdict: string;
      session_id: string;
    }>;

    // 至少存在一条审核记录：合法 verdict 包括真实 Brain 审核 'approve'/'reject'/
    // 'modify'/'require_user_confirm'。R14-4 撤回了 12.0 加的 auto_approve_* verdict。
    const ALLOWED_VERDICTS = new Set([
      'approve',
      'reject',
      'modify',
      'require_user_confirm',
    ]);
    expect(rows.length).toBeGreaterThan(0);
    expect(ALLOWED_VERDICTS.has(rows[0].verdict)).toBe(true);
    expect(rows[0].session_id).toBeTruthy();
  });

  it('waitIdle 所有任务完成后返回', async () => {
    await expect(harness.waitIdle(5000)).resolves.toBeUndefined();
  });

  it('临时目录存在且隔离', () => {
    const home = harness.getAppHome();
    expect(home).toContain('agent-test-');
  });
});

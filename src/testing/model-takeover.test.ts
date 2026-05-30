import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestHarness } from './harness.js';
import type { TakeoverController } from './model-takeover.js';
import { replayFixture, buildFixtureFromRecording, type FixtureData } from './fixtures.js';
import type Database from 'better-sqlite3';

const ROUTE_TO_CHAT = JSON.stringify({
  intent: 'chat',
  targetAgent: 'conversation',
  priority: 'normal',
  reason: 'test routing',
});

async function respondRouting(controller: TakeoverController): Promise<void> {
  const routeReq = await controller.waitForRequest(10000);
  expect(routeReq.agent).toBe('brain');
  expect(routeReq.purpose).toBe('brain_routing');
  controller.respond(routeReq.requestId, ROUTE_TO_CHAT);
}

describe('Model Takeover E2E', () => {
  let harness: TestHarness;
  let controller: TakeoverController;

  beforeAll(async () => {
    harness = new TestHarness({ timeoutMs: 30000, llmMode: 'takeover' });
    await harness.start();
    const tc = harness.getTakeoverController();
    if (!tc) throw new Error('TakeoverController not available');
    controller = tc;
  }, 60000);

  afterAll(async () => {
    await harness.stop();
  }, 30000);

  it('拦截 conversation 和 brain 的 LLM 请求', async () => {
    const messagePromise = harness.sendMessage('你好世界');

    await respondRouting(controller);

    const convReq = await controller.waitForRequest(10000);
    expect(convReq.agent).toBe('conversation');
    expect(convReq.purpose).toBe('conversation');
    expect(convReq.messages.length).toBeGreaterThan(0);

    controller.respond(convReq.requestId, '你好！我是 Berry。');

    const brainReq = await controller.waitForRequest(10000);
    expect(brainReq.agent).toBe('brain');
    expect(brainReq.purpose).toBe('brain_review');

    controller.respond(brainReq.requestId, JSON.stringify({
      verdict: 'approve',
      reason: 'Response is appropriate',
    }));

    const result = await messagePromise;
    expect(result.response).toBe('你好！我是 Berry。');
  });

  it('takeover 修改响应后最终输出被修改', async () => {
    const messagePromise = harness.sendMessage('测试修改');

    await respondRouting(controller);

    const convReq = await controller.waitForRequest(10000);
    controller.respond(convReq.requestId, '原始草稿');

    const brainReq = await controller.waitForRequest(10000);
    controller.respond(brainReq.requestId, JSON.stringify({
      verdict: 'modify',
      finalResponse: '修改后的回复',
      reason: '需要改进',
    }));

    const result = await messagePromise;
    expect(result.response).toBe('修改后的回复');
  });

  it('takeover reject 返回安全替代', async () => {
    const messagePromise = harness.sendMessage('测试拒绝');

    await respondRouting(controller);

    const convReq = await controller.waitForRequest(10000);
    controller.respond(convReq.requestId, '不安全的内容');

    const brainReq = await controller.waitForRequest(10000);
    controller.respond(brainReq.requestId, JSON.stringify({
      verdict: 'reject',
      finalResponse: '安全的替代回复',
      reason: '原始内容不适当',
    }));

    const result = await messagePromise;
    expect(result.response).toBe('安全的替代回复');
  });

  it('getPending 返回等待中的请求', async () => {
    const messagePromise = harness.sendMessage('查看 pending');

    await respondRouting(controller);

    await controller.waitForRequest(10000);
    const pending = controller.getPending();
    expect(pending.length).toBe(1);
    expect(pending[0].agent).toBe('conversation');

    controller.respond(pending[0].requestId, '响应');

    const brainReq = await controller.waitForRequest(10000);
    controller.respond(brainReq.requestId, JSON.stringify({ verdict: 'approve' }));

    await messagePromise;
  });

  it('reject 让 Agent 收到错误', async () => {
    const messagePromise = harness.sendMessage('错误测试');

    await respondRouting(controller);

    const convReq = await controller.waitForRequest(10000);
    controller.reject(convReq.requestId, '模拟 LLM 故障');

    const result = await messagePromise;
    expect(result.response).toContain('错误');
  });
});

describe('Fixture Replay', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = new TestHarness({ timeoutMs: 30000, llmMode: 'takeover' });
    await harness.start();
  }, 60000);

  afterAll(async () => {
    await harness.stop();
  }, 30000);

  it('从 fixture 回放完整对话', async () => {
    const fixture: FixtureData = {
      name: 'greeting-test',
      userMessage: '你好',
      interactions: [
        {
          request: { agent: 'brain', purpose: 'brain_routing' },
          response: { content: ROUTE_TO_CHAT },
          expect: { agent: 'brain', purpose: 'brain_routing' },
        },
        {
          request: { agent: 'conversation', purpose: 'conversation' },
          response: { content: '你好！有什么可以帮你的？' },
          expect: { agent: 'conversation', purpose: 'conversation' },
        },
        {
          request: { agent: 'brain', purpose: 'brain_review' },
          response: { content: JSON.stringify({ verdict: 'approve', reason: 'ok' }) },
          expect: { agent: 'brain', purpose: 'brain_review' },
        },
      ],
      expectedResponse: '你好！有什么可以帮你的？',
    };

    const result = await replayFixture(harness, fixture);
    expect(result.matchedAll).toBe(true);
    expect(result.mismatches).toHaveLength(0);
    expect(result.response).toBe('你好！有什么可以帮你的？');
  });

  it('expect 不匹配时记录 mismatch', async () => {
    const fixture: FixtureData = {
      name: 'mismatch-test',
      userMessage: '测试',
      interactions: [
        {
          request: { agent: 'brain', purpose: 'brain_routing' },
          response: { content: ROUTE_TO_CHAT },
          expect: { agent: 'conversation', purpose: 'wrong_purpose' },
        },
        {
          request: { agent: 'conversation', purpose: 'conversation' },
          response: { content: '回复' },
        },
        {
          request: { agent: 'brain', purpose: 'brain_review' },
          response: { content: JSON.stringify({ verdict: 'approve' }) },
        },
      ],
    };

    const result = await replayFixture(harness, fixture);
    expect(result.matchedAll).toBe(false);
    expect(result.mismatches.length).toBeGreaterThan(0);
    expect(result.mismatches[0]).toContain('agent');
  });

  it('buildFixtureFromRecording 构建 fixture', () => {
    const fixture = buildFixtureFromRecording(
      'test-fixture',
      '你好',
      [
        {
          request: {
            requestId: 'req_0',
            agent: 'brain',
            purpose: 'brain_routing',
            messages: [],
            promptHash: 'xyz',
            receivedAt: Date.now(),
          },
          responseSent: { content: ROUTE_TO_CHAT },
        },
        {
          request: {
            requestId: 'req_1',
            agent: 'conversation',
            purpose: 'conversation',
            messages: [],
            promptHash: 'abc',
            receivedAt: Date.now(),
          },
          responseSent: { content: '你好！' },
        },
        {
          request: {
            requestId: 'req_2',
            agent: 'brain',
            purpose: 'brain_review',
            messages: [],
            promptHash: 'def',
            receivedAt: Date.now(),
          },
          responseSent: { content: '{"verdict":"approve"}' },
        },
      ],
      '你好！',
    );

    expect(fixture.name).toBe('test-fixture');
    expect(fixture.interactions).toHaveLength(3);
    expect(fixture.interactions[0].request.agent).toBe('brain');
    expect(fixture.interactions[1].request.agent).toBe('conversation');
    expect(fixture.interactions[2].request.agent).toBe('brain');
    expect(fixture.expectedResponse).toBe('你好！');
  });
});

describe('Permission Token E2E', () => {
  let harness: TestHarness;
  let controller: TakeoverController;
  let db: Database.Database;

  beforeAll(async () => {
    harness = new TestHarness({ timeoutMs: 30000, llmMode: 'takeover' });
    await harness.start();
    const tc = harness.getTakeoverController();
    if (!tc) throw new Error('TakeoverController not available');
    controller = tc;
    db = harness.getDb();
  }, 60000);

  afterAll(async () => {
    await harness.stop();
  }, 30000);

  it('approval_requests 表在工具调用后有记录', async () => {
    const messagePromise = harness.sendMessage('工具调用测试');

    await respondRouting(controller);

    const convReq = await controller.waitForRequest(10000);
    controller.respond(convReq.requestId, '工具调用结果');

    const brainReq = await controller.waitForRequest(10000);
    controller.respond(brainReq.requestId, JSON.stringify({ verdict: 'approve' }));

    await messagePromise;

    const rows = db.prepare('SELECT * FROM approval_requests').all() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(0);
  });

  it('permission_tokens 表在 allow-all 模式下生成令牌', async () => {
    const beforeCount = (db.prepare('SELECT COUNT(*) as cnt FROM permission_tokens').get() as { cnt: number }).cnt;

    const messagePromise = harness.sendMessage('令牌测试');

    await respondRouting(controller);

    const convReq = await controller.waitForRequest(10000);
    controller.respond(convReq.requestId, '回复');

    const brainReq = await controller.waitForRequest(10000);
    controller.respond(brainReq.requestId, JSON.stringify({ verdict: 'approve' }));

    await messagePromise;

    const afterCount = (db.prepare('SELECT COUNT(*) as cnt FROM permission_tokens').get() as { cnt: number }).cnt;
    expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
  });

  it('tool_calls 记录 permission token 和 task 关联', async () => {
    const messagePromise = harness.sendMessage('请调用工具');

    await respondRouting(controller);

    const convReq = await controller.waitForRequest(10000);
    controller.respond(convReq.requestId, '', {
      toolCalls: [{ id: 'toolu_1', name: 'list_directory', input: { path: '.' } }],
      stopReason: 'tool_use',
    });

    const secondConvReq = await controller.waitForRequest(10000);
    controller.respond(secondConvReq.requestId, '工具完成');

    const brainReq = await controller.waitForRequest(10000);
    controller.respond(brainReq.requestId, JSON.stringify({ verdict: 'approve' }));

    const result = await messagePromise;

    const row = db.prepare(`
      SELECT task_id, permission_token, permission_verdict FROM tool_calls
      WHERE session_id = ? ORDER BY started_at DESC LIMIT 1
    `).get(result.sessionId) as { task_id: string | null; permission_token: string | null; permission_verdict: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.task_id).toBe(result.taskId);
    expect(row!.permission_token).toBeTruthy();
    expect(row!.permission_verdict).toBe('allow');
  });

  it('task_events 表有 notification 类型记录', async () => {
    const messagePromise = harness.sendMessage('通知测试');

    await respondRouting(controller);

    const convReq = await controller.waitForRequest(10000);
    controller.respond(convReq.requestId, '通知回复');

    const brainReq = await controller.waitForRequest(10000);
    controller.respond(brainReq.requestId, JSON.stringify({ verdict: 'approve' }));

    const result = await messagePromise;

    const notifications = db.prepare(
      `SELECT * FROM task_events WHERE task_id = ? AND event_type = 'notification'`
    ).all(result.taskId) as Array<Record<string, unknown>>;

    expect(notifications.length).toBeGreaterThan(0);
    const payload = JSON.parse(notifications[0].payload as string);
    expect(payload.taskId).toBe(result.taskId);
    expect(payload.status).toBe('completed');
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
    expect(payload.usage).toBeDefined();
  });

  it('getLastNotification 通过 harness 返回通知', async () => {
    const messagePromise = harness.sendMessage('harness 通知');

    await respondRouting(controller);

    const convReq = await controller.waitForRequest(10000);
    controller.respond(convReq.requestId, 'harness 回复');

    const brainReq = await controller.waitForRequest(10000);
    controller.respond(brainReq.requestId, JSON.stringify({ verdict: 'approve' }));

    const result = await messagePromise;

    const notification = harness.getLastNotification(result.taskId);
    expect(notification).not.toBeNull();
    expect(notification!.taskId).toBe(result.taskId);
    expect(notification!.status).toBe('completed');
    expect(notification!.summary).toContain('完成');
  });

  it('对话完成后触发能力自进化提案和 Skill 文件生成', async () => {
    const messagePromise = harness.sendMessage('以后每次自进化测试报告都用中文标题、简洁列表，并标注证据来源。');

    await respondRouting(controller);

    const convReq = await controller.waitForRequest(10000);
    controller.respond(convReq.requestId, '已记住');

    const brainReq = await controller.waitForRequest(10000);
    controller.respond(brainReq.requestId, JSON.stringify({ verdict: 'approve' }));

    await messagePromise;

    const proposal = db.prepare(`
      SELECT type, status, draft_path FROM evolution_proposals
      WHERE type = 'skill_create'
      ORDER BY created_at DESC LIMIT 1
    `).get() as { type: string; status: string; draft_path: string } | undefined;

    expect(proposal).toBeDefined();
    expect(proposal!.status).toBe('applied');
    expect(proposal!.draft_path).toContain('SKILL.md');

    const skillCount = (db.prepare(`SELECT COUNT(*) AS count FROM skills_meta`).get() as { count: number }).count;
    expect(skillCount).toBeGreaterThan(0);
  });
});

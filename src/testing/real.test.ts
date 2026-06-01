/**
 * 第 3 层：真实测试 — 通过 HTTP CRUD API + WebSocket 做真实对话测试
 *
 * 像前端一样调用后端 API，验证从 HTTP 请求到响应的完整链路。
 * 依赖环境变量 APP_TEST_LIVE_API_KEY 或 LLM_API_KEY。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RealTestClient } from './real-test-client.js';

const HAS_KEY = !!(
  process.env.APP_TEST_LIVE_API_KEY ||
  process.env.LLM_API_KEY
);

describe.skipIf(!HAS_KEY)('真实测试 — HTTP API 对话', () => {
  let client: RealTestClient;

  beforeAll(async () => {
    client = new RealTestClient({ timeoutMs: 120_000 });
    await client.start();
  }, 120_000);

  afterAll(async () => {
    if (client) await client.stop();
  }, 30_000);

  // --- HTTP API: Health ---

  it('GET /api/health 返回 ok', async () => {
    const health = await client.getHealth();

    expect(health.ok).toBe(true);
    expect(health.agents).toBeGreaterThanOrEqual(2);
    expect(typeof health.uptime).toBe('number');
  }, 30_000);

  // --- WebSocket: 发送消息 ---

  it('通过 WebSocket 发送消息获得非空回复', async () => {
    const result = await client.sendMessage('', '你好，请用一句话回答：1+1等于几？');

    expect(result.response).toBeDefined();
    expect(typeof result.response).toBe('string');
    expect(result.response.length).toBeGreaterThan(0);
    expect(result.sessionId).toBeTruthy();
  }, 90_000);

  // --- WebSocket: 多轮对话 ---

  it('多轮对话保持 session 上下文', async () => {
    const sid = '';
    const r1 = await client.sendMessage(sid, '请记住这个数字：42');
    const sessionId = r1.sessionId;

    expect(r1.response.length).toBeGreaterThan(0);

    const r2 = await client.sendMessage(sessionId, '我刚才让你记住的数字是什么？');
    expect(r2.response.length).toBeGreaterThan(0);
    expect(r2.sessionId).toBe(sessionId);
  }, 120_000);

  // --- HTTP API: Conversations CRUD ---

  it('GET /api/conversations 列出对话', async () => {
    // 先发一条消息确保至少有一个对话
    await client.sendMessage('', 'test for listing');

    const conversations = await client.listConversations();
    expect(Array.isArray(conversations)).toBe(true);
    expect(conversations.length).toBeGreaterThan(0);

    const conv = conversations[0];
    expect(conv.sessionId).toBeTruthy();
    expect(typeof conv.messageCount).toBe('number');
  }, 90_000);

  it('GET /api/conversations/:sid 获取消息历史', async () => {
    const r = await client.sendMessage('', '测试消息历史');
    const messages = await client.getConversationMessages(r.sessionId);

    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThanOrEqual(2); // user + assistant
  }, 90_000);

  it('DELETE /api/conversations/:sid 删除对话', async () => {
    const r = await client.sendMessage('', '即将被删除的对话');

    // 确认对话存在
    const before = await client.listConversations();
    expect(before.some(c => c.sessionId === r.sessionId)).toBe(true);

    // 删除
    await client.deleteConversation(r.sessionId);

    // 确认已删除
    const after = await client.listConversations();
    expect(after.some(c => c.sessionId === r.sessionId)).toBe(false);
  }, 90_000);

  // --- HTTP API: Agents ---

  it('GET /api/agents 列出 Agent', async () => {
    const agents = await client.listAgents();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThan(0);

    const agent = agents[0];
    expect(agent.name).toBeTruthy();
    expect(typeof agent.status).toBe('string');
  }, 30_000);

  // --- HTTP API: Tasks ---

  it('GET /api/tasks 列出任务', async () => {
    const result = await client.listTasks({ limit: 10 });
    expect(result.items).toBeDefined();
    expect(typeof result.total).toBe('number');
    expect(Array.isArray(result.items)).toBe(true);
  }, 30_000);
});

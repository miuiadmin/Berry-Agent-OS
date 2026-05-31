import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveRealTestConfig, applyRealTestEnv, type AppliedRealTestEnv } from '../cli/real-test-profile.js';
import { TestHarness } from './harness.js';
import { LiveTestContext } from './live-test-context.js';
import {
  createLiveContext,
  sendWithRetry,
  assertModelCallCount,
  assertNoErrors,
  assertTokenBudget,
} from './live-test-helpers.js';

const HAS_LIVE_KEY = !!(
  process.env.APP_TEST_LIVE_API_KEY ||
  process.env.LLM_API_KEY
);

describe.skipIf(!HAS_LIVE_KEY)('Smoke — 真实模型对话', () => {
  let harness: TestHarness;
  let ctx: LiveTestContext;
  let applied: AppliedRealTestEnv;

  beforeAll(async () => {
    const config = resolveRealTestConfig({ profile: 'override' });
    applied = applyRealTestEnv(config);

    harness = new TestHarness({ llmMode: 'live', timeoutMs: 120000 });
    await harness.start();
    ctx = createLiveContext(harness, { debugOnFailure: true });
  }, 120_000);

  afterEach((testCtx) => {
    if (testCtx.task.result?.state === 'fail') {
      ctx.dumpOnFailure(testCtx.task.name);
    }
    ctx.reset();
  });

  afterAll(async () => {
    if (harness) await harness.stop();
    if (applied) applied.cleanup();
  }, 30_000);

  it('发送简单消息，模型返回非空回复', async () => {
    const result = await sendWithRetry(harness, ctx, '你好，请用一句话回答：1+1等于几？');

    expect(result.response).toBeDefined();
    expect(typeof result.response).toBe('string');
    expect(result.response.length).toBeGreaterThan(0);
    expect(result.sessionId).toBeDefined();

    assertModelCallCount(ctx, { min: 1, max: 5 });
    assertNoErrors(ctx);
  }, 60_000);

  it('连续两轮对话保持 session', async () => {
    const r1 = await sendWithRetry(harness, ctx, '请记住这个数字：42');
    const sid = r1.sessionId;

    const r2 = await sendWithRetry(harness, ctx, '我刚才让你记住的数字是什么？', { sessionId: sid });
    expect(r2.response).toContain('42');

    assertTokenBudget(ctx, { maxTotal: 60000 });
  }, 120_000);

  it('捕获路由 span', async () => {
    await sendWithRetry(harness, ctx, 'hello');

    const spans = ctx.getSpans();
    const routingSpans = spans.filter(s => s.name === 'routing.decision');
    expect(routingSpans.length).toBeGreaterThan(0);
    expect(routingSpans[0].attributes.intent).toBeDefined();
  }, 60_000);

  it('model_requests 表记录 LLM 调用', async () => {
    await sendWithRetry(harness, ctx, '你好');

    const requests = ctx.getModelRequests({ status: 'responded' });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0].agent).toBeDefined();
    expect(requests[0].latencyMs).toBeGreaterThan(0);
  }, 60_000);

  it('I/O transcript 录制完整', async () => {
    await sendWithRetry(harness, ctx, 'test');

    const transcript = ctx.getIOTranscript();
    const inEntries = transcript.filter(e => e.direction === 'in');
    const outEntries = transcript.filter(e => e.direction === 'out');
    expect(inEntries.length).toBeGreaterThan(0);
    expect(outEntries.length).toBeGreaterThan(0);
  }, 60_000);
});

/**
 * ②reviewer produceReviewResult 冒烟测试（①② 翻转前验证审核核心）。
 *
 * mock chat 返固定 verdict JSON → 验证 produceReviewResult 正确解析 + 返回 + 调 recordReviewDecision。
 * 不调真实 LLM（CLAUDE.md 禁）——只验 wiring（buildReviewSystemPrompt + evaluateReview + record 串联）。
 * 翻转后②reviewer 是 review 链路唯一审核者，本测试钉死其 verdict 生产行为。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../../../memory/db.js';
import { produceReviewResult, type ReviewerReviewContext, type ReviewerChatFn } from './produce-review.js';

describe('reviewer produceReviewResult（①② 审核核心）', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'berry-reviewer-produce-'));
    initDb(join(dir, 'test.db'));
  });

  afterEach(() => {
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** mock chat：返固定 approve verdict JSON（模拟 LLM 审核通过） */
  const mockChatApprove: ReviewerChatFn = async () => ({
    content: JSON.stringify({
      verdict: 'approve',
      finalResponse: '这是最终回复',
      reason: '回复恰当',
    }),
  });

  /** 最小 mock ctx：slot 空操作 + fallback 不触发（chat 不抛）+ record 捕获 */
  function buildMockCtx() {
    const recorded: unknown[] = [];
    const ctx: ReviewerReviewContext = {
      db: undefined as never, // produceReviewResult 不直接读 db（buildReviewSystemPrompt 读，但 level A 空库降级）
      observationRecorder: { queryByType: () => [], isTruncated: () => false } as never,
      missionManager: { readPlan: () => undefined } as never,
      getBasePrompt: (level) => `BASE_${level}`,
      recallDecisionsBlock: () => '\n## DECISIONS',
      acquireReviewSlot: async () => {},
      releaseReviewSlot: () => {},
      buildFallbackReviewResult: () => ({ verdict: 'approve', finalResponse: '', reason: 'fallback' }) as never,
      recordReviewDecision: (sessionId, draft, review, planTaskId) => recorded.push({ sessionId, draft, review, planTaskId }),
      // 不传 dispatchCheckerReview / updatePlan（无 mission 上下文时不触发）
    };
    return { ctx, recorded };
  }

  it('mock approve chat → 返回 verdict=approve + 调 recordReviewDecision', async () => {
    const { ctx, recorded } = buildMockCtx();
    const result = await produceReviewResult(
      { sessionId: 's1', userMessage: 'hi', draftResponse: 'draft', toolCalls: [], level: 'A' },
      'track-1',
      mockChatApprove,
      ctx,
      'reviewer',
    );
    expect(result.verdict).toBe('approve');
    expect(result.finalResponse).toBe('这是最终回复');
    expect(result.reason).toBe('回复恰当');
    // 审核决策已记录（供进化反馈）
    expect(recorded).toHaveLength(1);
    expect((recorded[0] as { sessionId: string }).sessionId).toBe('s1');
  });

  it('chat 抛错 → 走 fallback（不"批准一切"外的降级，行为等价 brain）', async () => {
    const { ctx, recorded } = buildMockCtx();
    const failingChat: ReviewerChatFn = async () => { throw new Error('LLM down'); };
    const result = await produceReviewResult(
      { sessionId: 's2', userMessage: 'hi', draftResponse: 'draft', toolCalls: [], level: 'B' },
      'track-2',
      failingChat,
      ctx,
      'reviewer',
    );
    // fallback verdict（buildFallbackReviewResult mock 返 approve）
    expect(result.verdict).toBe('approve');
    expect(result.reason).toBe('fallback');
    // 降级审核也记录决策
    expect(recorded).toHaveLength(1);
  });
});

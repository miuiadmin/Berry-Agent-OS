/**
 * L3 safety 测试 — ApprovalService（骨架篇 §8.3/§8.4）。
 * 走真 Context waterfall（answerer 短路三值 / 无人应答 fail-closed）；
 * 审批对（asked + decided）经 sink 落点验证 turn-enclosed 载荷形态。
 */

import { describe, expect, it } from 'vitest';
import { createContext } from '../context/index.js';
import { APPROVAL_ANSWER_EVENT, createApprovalService, type ApprovalDecisionSink } from './approval.js';
import type { ApprovalAnswer } from './types.js';

/** 审批对收集器（模拟 app 装配层接 session.append 的 durable 落点） */
function pairSink() {
  const asked: { approvalId: string; summary: string }[] = [];
  const decided: { approvalId: string; decision: string }[] = [];
  const sink: ApprovalDecisionSink = {
    asked: (p) => asked.push(p),
    decided: (p) => decided.push(p),
  };
  return { sink, asked, decided };
}

/** 注册一个固定答案的 answerer（通道插件形态：短路返回三值） */
function answerer(ctx: ReturnType<typeof createContext>, answer: ApprovalAnswer) {
  return ctx.on(APPROVAL_ANSWER_EVENT, (req: unknown, next: () => unknown) => {
    // 只接本测试发的请求（防跨用例串扰）；其余交棒下游
    if ((req as { summary?: string }).summary?.startsWith('测试')) return answer;
    return next();
  });
}

describe('createApprovalService — ask 策略（默认）', () => {
  it('无人应答 → fail-closed unavailable（不放行）', async () => {
    const ctx = createContext({ name: 'test' });
    const { sink, asked, decided } = pairSink();
    const approval = createApprovalService(ctx, { sink });
    const outcome = await approval.ask({ summary: '测试：写敏感文件' });
    expect(outcome).toBe('unavailable');
    // 审批对两腿齐全：asked 在前、decided(unavailable) 在后，id 一致
    expect(asked).toHaveLength(1);
    expect(decided).toEqual([{ approvalId: asked[0]!.approvalId, decision: 'unavailable' }]);
  });

  it.each([
    ['approve', 'allowed-once', 'approve'],
    ['reject', 'rejected', 'reject'],
    ['cancel', 'cancelled', 'cancel'],
  ] as const)('answerer %s → outcome %s（durable 记 %s）', async (answer, outcome, durable) => {
    const ctx = createContext({ name: 'test' });
    const { sink, asked, decided } = pairSink();
    const approval = createApprovalService(ctx, { sink });
    const dispose = answerer(ctx, answer);
    const result = await approval.ask({ summary: '测试：升权', reason: '目标档 workspace-write' });
    dispose();
    expect(result).toBe(outcome);
    expect(decided).toEqual([{ approvalId: asked[0]!.approvalId, decision: durable }]);
  });

  it('多 answerer：先注册者短路（不调 next 即最终值）', async () => {
    const ctx = createContext({ name: 'test' });
    const approval = createApprovalService(ctx);
    let secondCalled = false;
    ctx.on(APPROVAL_ANSWER_EVENT, (req: unknown, next: () => unknown) => {
      if ((req as { summary?: string }).summary?.startsWith('测试')) return 'reject' as const;
      return next();
    });
    ctx.on(APPROVAL_ANSWER_EVENT, (req: unknown, next: () => unknown) => {
      if ((req as { summary?: string }).summary?.startsWith('测试')) {
        secondCalled = true;
        return 'approve' as const;
      }
      return next();
    });
    const outcome = await approval.ask({ summary: '测试：谁先短路' });
    expect(outcome).toBe('rejected');
    expect(secondCalled).toBe(false); // 第一个短路后第二个不被咨询
  });

  it('answerer 交棒下游（调 next）：由后注册者决策', async () => {
    const ctx = createContext({ name: 'test' });
    const approval = createApprovalService(ctx);
    // 先注册者只对非测试请求感兴趣 → 测试请求交棒
    ctx.on(APPROVAL_ANSWER_EVENT, (_req: unknown, next: () => unknown) => next());
    answerer(ctx, 'approve');
    const outcome = await approval.ask({ summary: '测试：交棒' });
    expect(outcome).toBe('allowed-once');
  });
});

describe('createApprovalService — never 策略', () => {
  it('确定性拒绝：不派发 answerer，直接 rejected', async () => {
    const ctx = createContext({ name: 'test' });
    const { sink, asked, decided } = pairSink();
    const approval = createApprovalService(ctx, { policy: 'never', sink });
    let dispatched = false;
    ctx.on(APPROVAL_ANSWER_EVENT, () => {
      dispatched = true;
    });
    const outcome = await approval.ask({ summary: '测试：无人值守' });
    expect(outcome).toBe('rejected');
    expect(dispatched).toBe(false); // never 不问人
    expect(approval.policyMode).toBe('never');
    expect(decided).toEqual([{ approvalId: asked[0]!.approvalId, decision: 'reject' }]);
  });
});

describe('审批对与审批 id', () => {
  it('每次 ask 独立 approvalId（审计关联键不重复）', async () => {
    const ctx = createContext({ name: 'test' });
    const { sink, asked } = pairSink();
    const approval = createApprovalService(ctx, { sink });
    answerer(ctx, 'approve');
    await approval.ask({ summary: '测试：一号' });
    await approval.ask({ summary: '测试：二号' });
    expect(asked).toHaveLength(2);
    expect(asked[0]!.approvalId).not.toBe(asked[1]!.approvalId);
  });

  it('服务经 ctx.provide 挂载（ctx.get 可取）', () => {
    const ctx = createContext({ name: 'test' });
    const approval = createApprovalService(ctx);
    expect(ctx.get('approval')).toBe(approval);
  });
});

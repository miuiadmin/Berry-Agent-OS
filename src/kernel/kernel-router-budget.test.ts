/**
 * 13.0 §4.4.2: inter_agent_budget.totalBudget 初始化与软上限检查测试。
 *
 * 修复旧版死代码：totalBudget 恒为 0 导致 gate ⑥b 的 30% 占比检查永不触发。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { KernelRouter, type KernelRouterDeps } from './kernel-router.js';
import { StateCache } from './state-cache.js';
import { initEventBus } from './event-bus.js';

beforeEach(() => {
  initEventBus();
});

// 最小桩：KernelRouter 只用到这些方法
function makeDeps(stateCache: StateCache, sessionBudgetLimit?: number): KernelRouterDeps {
  return {
    dialogueRouter: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agentManager: { getAgent: () => null, listAliveAgents: () => [], isAlive: () => false } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessionManager: { getPending: () => undefined } as any,
    stateCache,
    sessionBudgetLimit,
  };
}

describe('KernelRouter §4.4.2 inter_agent_budget.totalBudget 初始化', () => {
  it('recordInterAgentRequest 用注入的 sessionBudgetLimit 初始化 totalBudget（非零）', () => {
    const stateCache = new StateCache();
    const router = new KernelRouter(makeDeps(stateCache, 100_000));

    router.recordInterAgentRequest('sess-1');

    const budget = stateCache.get('inter_agent_budget', 'sess-1') as { totalBudget: number; requestCount: number; tokensUsed: number };
    // 修复前：totalBudget === 0（死代码）；修复后：来自注入值
    expect(budget.totalBudget).toBe(100_000);
    expect(budget.requestCount).toBe(1);
  });

  it('未注入 sessionBudgetLimit 时回退到默认 500_000', () => {
    const stateCache = new StateCache();
    const router = new KernelRouter(makeDeps(stateCache));

    router.recordInterAgentRequest('sess-2');

    const budget = stateCache.get('inter_agent_budget', 'sess-2') as { totalBudget: number };
    expect(budget.totalBudget).toBe(500_000);
  });

  it('gate() 在 tokensUsed 达到 30% totalBudget 时拒绝（软上限生效）', () => {
    const stateCache = new StateCache();
    const router = new KernelRouter(makeDeps(stateCache, 100_000));

    // 预置预算：已用 35k（超过 30% = 30k）
    stateCache.set('inter_agent_budget', 'sess-3', { tokensUsed: 35_000, requestCount: 5, totalBudget: 100_000 });

    // gate 应返回拒绝原因（软上限触发）
    const reason = router.gate('code', 'memory', 'sess-3', 'agent.question');
    expect(reason).toContain('预算占比超限');

    // 未超限时通过
    stateCache.set('inter_agent_budget', 'sess-4', { tokensUsed: 10_000, requestCount: 5, totalBudget: 100_000 });
    const reason2 = router.gate('code', 'memory', 'sess-4', 'agent.question');
    // 可能因其他检查拒绝（如频率/循环），但不应是预算占比超限
    expect(reason2 ?? '').not.toContain('预算占比超限');
  });
});

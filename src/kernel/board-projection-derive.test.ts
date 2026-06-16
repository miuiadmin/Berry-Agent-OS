/**
 * deriveDelegationEventFromBoardMessage 纯函数测试（P5 enabler）。
 *
 * 钉死 board report 信封 → delegation 生命周期事件的映射（§3.3 收敛 + §6.5 状态机）：
 * agent report(done)→completed；blocked/cant_split→failed；partial/system/非 report→null。
 * 纯函数无 DB 依赖。P5 权威切换后 board 据此派生 delegation.*（替代 delegation-manager 直 emit）。
 */
import { describe, it, expect } from 'vitest';
import { deriveDelegationEventFromBoardMessage } from './board-projection.js';
import type { BoardMessage } from '../contracts/board-message.js';

/** 构造 report 信封（省略信封公共字段，补 type-specific） */
function report(opts: { from?: string; status: 'done' | 'partial' | 'blocked' | 'cant_split'; summary?: string; taskId?: string }): BoardMessage {
  return {
    id: 'bmsg-1',
    type: 'report',
    from: opts.from ?? 'code',
    to: 'leader',
    taskId: opts.taskId ?? 'task-1',
    ts: 1000,
    summary: opts.summary ?? '完成',
    status: opts.status,
    artifactRefs: [],
  } as BoardMessage;
}

describe('deriveDelegationEventFromBoardMessage（P5 enabler）', () => {
  it('agent report(done) → delegation.completed', () => {
    const e = deriveDelegationEventFromBoardMessage(report({ from: 'code', status: 'done', summary: '改完了' }));
    expect(e).toEqual({ type: 'delegation.completed', delegationId: 'task-1', targetAgent: 'code' });
  });

  it('agent report(blocked) → delegation.failed（error=summary）', () => {
    const e = deriveDelegationEventFromBoardMessage(report({ from: 'code', status: 'blocked', summary: '依赖缺失' }));
    expect(e).toEqual({ type: 'delegation.failed', delegationId: 'task-1', targetAgent: 'code', error: '依赖缺失' });
  });

  it('agent report(cant_split) → delegation.failed（拆不动降级上报）', () => {
    const e = deriveDelegationEventFromBoardMessage(report({ from: 'code', status: 'cant_split', summary: '拆不动' }));
    expect(e?.type).toBe('delegation.failed');
  });

  it('report(partial) → null（非终态，不派生生命周期）', () => {
    expect(deriveDelegationEventFromBoardMessage(report({ status: 'partial' }))).toBeNull();
  });

  it('system report(from:system) → null（targetAgent 不在消息内，留 P5 板上下文派生）', () => {
    expect(deriveDelegationEventFromBoardMessage(report({ from: 'system', status: 'blocked' }))).toBeNull();
  });

  it('非 report 信封（delegate/ask/command/tell/tool_*）→ null', () => {
    const delegate = { id: 'b', type: 'delegate', from: 'brain', to: 'code', taskId: 't', ts: 1, subTaskGoal: 'g' } as BoardMessage;
    const ask = { id: 'b', type: 'ask', from: 'code', to: 'brain', taskId: 't', ts: 1, question: 'q', blocking: true } as BoardMessage;
    expect(deriveDelegationEventFromBoardMessage(delegate)).toBeNull();
    expect(deriveDelegationEventFromBoardMessage(ask)).toBeNull();
  });
});

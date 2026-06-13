import { describe, it, expect } from 'vitest';
import { C_LEVEL_OBSERVATION_TYPES, renderObservationContext } from './observation-context.js';
import type { ObservationRow } from '../../../kernel/observation-recorder.js';

/**
 * C 级审核观察上下文单测 —— 钉死 15.0 C3 闭合的两个不变量（防回归）：
 *   1. 白名单含 agent_event（审计报告 + plan_stalled 不再只写不读）
 *   2. agent_event 给 600 内容预算（普通观察 200），预浓缩内容不被截成残片
 */

/** 构造一行观察的最小 helper（避免每个用例重复 11 个字段） */
function row(over: Partial<ObservationRow>): ObservationRow {
  return {
    id: 'o',
    sessionId: 's1',
    taskId: 't1',
    seq: 1,
    observationType: 'tool_call',
    fromAgent: 'code',
    toAgent: null,
    content: '',
    priority: 1,
    metadata: null,
    createdAt: 0,
    ...over,
  };
}

describe('C_LEVEL_OBSERVATION_TYPES（C3 白名单不变量）', () => {
  it('含 agent_event —— 审计报告 + plan_stalled 不再只写不读', () => {
    // 这是 C3 的核心断言：移除 agent_event 会让机制 C §4.6 闭环再次断裂。
    expect(C_LEVEL_OBSERVATION_TYPES).toContain('agent_event');
  });

  it('保留 5 个原有行为类型（未因加 agent_event 而丢类型）', () => {
    const behavioral = ['dialogue_send', 'dialogue_reply', 'tool_call', 'tool_result', 'drift_signal'] as const;
    for (const t of behavioral) {
      expect(C_LEVEL_OBSERVATION_TYPES).toContain(t);
    }
  });
});

describe('renderObservationContext（C3 渲染）', () => {
  it('agent_event 审计报告被渲染进上下文（Brain C 级看得到 → §4.6 闭环）', () => {
    const ctx = renderObservationContext([
      row({
        observationType: 'agent_event',
        fromAgent: 'auditor',
        toAgent: 'brain',
        content:
          '{"kind":"audit_report","riskScore":0.7,"taskCount":42,"recommendations":{"forbiddenTools":["shell"]}}',
      }),
    ]);
    expect(ctx).toContain('[agent_event]');
    expect(ctx).toContain('auditor→brain');
    expect(ctx).toContain('audit_report');
    expect(ctx).toContain('riskScore');
    expect(ctx).toContain('forbiddenTools'); // 600 预算下完整保留，未被截断
  });

  it('agent_event 给 600 预算、普通观察给 200（预浓缩内容不截成残片）', () => {
    const longContent = 'x'.repeat(500);
    const ctx = renderObservationContext([
      row({ observationType: 'agent_event', content: longContent }),
      row({ observationType: 'tool_call', content: longContent }),
    ]);
    const [agentLine, toolLine] = ctx.split('\n');
    // agent_event 500 字符 < 600 预算 → 完整保留
    expect(agentLine).toContain(longContent);
    // tool_call 500 字符 > 200 预算 → 被截断（不再含完整长串）
    expect(toolLine).not.toContain(longContent);
  });

  it('普通行为观察沿用原渲染格式（fromAgent + 箭头 + 内容）', () => {
    const ctx = renderObservationContext([
      row({ observationType: 'tool_call', fromAgent: 'code', toAgent: null, content: 'ls -la' }),
    ]);
    expect(ctx).toBe('[tool_call] code: ls -la');
  });

  it('空列表返回空串（无观察时不污染 prompt）', () => {
    expect(renderObservationContext([])).toBe('');
  });
});

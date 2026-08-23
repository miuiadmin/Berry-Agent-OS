/**
 * L5 app — convertToLlm 默认实现测试（骨架篇 §2.3 关口三策略）。
 */

import { describe, expect, it } from 'vitest';
import { registerMessageRole } from '../agent/messages.js';
import type { AgentMessage } from '../agent/messages.js';
import { defaultConvertToLlm } from './convert.js';

const now = 1_750_000_000_000;

describe('defaultConvertToLlm', () => {
  it('标准三角色零转换透传（引用直通无拷贝）', () => {
    const user: AgentMessage = { role: 'user', content: '你好', timestamp: now };
    const assistant: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: '在' }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason: 'stop',
      timestamp: now,
    };
    const out = defaultConvertToLlm([user, assistant]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(user); // 同一引用——透传非复制
    expect(out[1]).toBe(assistant);
  });

  it('自定义角色走注册的 toLlm 定义（单条与多条映射）', () => {
    const disposeA = registerMessageRole('t-conv-a', {
      toLlm: (m) => ({ role: 'user', content: `[a] ${String(m.content)}`, timestamp: now }),
    });
    const disposeB = registerMessageRole('t-conv-b', {
      toLlm: (m) => [
        { role: 'user', content: `[b1] ${String(m.content)}`, timestamp: now },
        { role: 'user', content: '[b2] 附注', timestamp: now },
      ],
    });
    try {
      const out = defaultConvertToLlm([
        { role: 't-conv-a', content: '提醒', timestamp: now },
        { role: 't-conv-b', content: '两段', timestamp: now },
      ]);
      expect(out.map((m) => (m as { content: string }).content)).toEqual(['[a] 提醒', '[b1] 两段', '[b2] 附注']);
    } finally {
      disposeA();
      disposeB();
    }
  });

  it('未注册转换 / toLlm 返回 null 的角色过滤丢弃', () => {
    const disposeHidden = registerMessageRole('t-conv-hidden', { toLlm: () => null });
    try {
      const out = defaultConvertToLlm([
        { role: 'user', content: '保留', timestamp: now },
        { role: 't-conv-hidden', content: '丢弃', timestamp: now },
        { role: 't-conv-未注册', content: '也丢弃', timestamp: now },
      ]);
      expect(out).toHaveLength(1);
      expect((out[0] as { content: string }).content).toBe('保留');
    } finally {
      disposeHidden();
    }
  });

  it('空输入与全过滤输入均返回空数组', () => {
    expect(defaultConvertToLlm([])).toEqual([]);
    expect(defaultConvertToLlm([{ role: 't-conv-none', content: 1, timestamp: now }])).toEqual([]);
  });
});

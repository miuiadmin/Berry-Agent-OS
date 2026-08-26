/**
 * L5 app — convertToLlm 默认实现测试（骨架篇 §2.3 关口三策略）。
 */

import { describe, expect, it } from 'vitest';
import { registerHostMessageRole } from '../contracts/messages.js';
import type { AgentMessage } from '../contracts/messages.js';
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
    const disposeA = registerHostMessageRole('t-conv-a', {
      toLlm: (m) => ({ role: 'user', content: `[a] ${String(m.content)}`, timestamp: now }),
    });
    const disposeB = registerHostMessageRole('t-conv-b', {
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
    const disposeHidden = registerHostMessageRole('t-conv-hidden', { toLlm: () => null });
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

  it('#16 回归锁：未注册角色丢弃触发 onDrop（携带角色名——蒸发陷阱有痕迹）', () => {
    const dropped: string[] = [];
    const out = defaultConvertToLlm([{ role: 't-conv-evaporate', content: 'x', timestamp: now }], (role) => {
      dropped.push(role);
    });
    expect(out).toEqual([]);
    expect(dropped).toEqual(['t-conv-evaporate']); // 角色名上报——不再全静默
  });

  it('#16 回归锁：注册角色的 toLlm:null 是设计内过滤——不触发 onDrop', () => {
    const dropped: string[] = [];
    const dispose = registerHostMessageRole('t-conv-bydesign', { toLlm: () => null });
    try {
      const out = defaultConvertToLlm([{ role: 't-conv-bydesign', content: 'y', timestamp: now }], (role) => {
        dropped.push(role);
      });
      expect(out).toEqual([]);
      expect(dropped).toEqual([]); // bash 执行记录类显式丢弃免刷日志
    } finally {
      dispose();
    }
  });

  it('隔离案一第一刀 #2 回归锁：toLlm 抛错 → 按丢弃收尾 + onDrop 携原因上报（run 不被穿透杀掉）', () => {
    const dropped: { role: string; reason?: string }[] = [];
    const boom = new Error('转换器炸了');
    const dispose = registerHostMessageRole('t-conv-broken', {
      toLlm: () => {
        throw boom;
      },
    });
    try {
      // 修复前：异常穿透 defaultConvertToLlm 抛出（P14 run 级穿透——「永不
      // throw」自述违约）；修复后：坏转换器只蒸发自己的消息，其余透传不受影响
      const out = defaultConvertToLlm(
        [
          { role: 'user', content: '前一条', timestamp: now },
          { role: 't-conv-broken', content: '坏消息', timestamp: now },
          { role: 'user', content: '后一条', timestamp: now },
        ],
        (role, reason) => dropped.push({ role, reason }),
      );
      expect(out).toHaveLength(2); // 前后两条 user 均透传——只有坏条目被丢
      expect((out[0] as { content: string }).content).toBe('前一条');
      expect((out[1] as { content: string }).content).toBe('后一条');
      // 上报分界：角色名 + 「toLlm 抛错」原因（区别于未注册角色的裸角色名）
      expect(dropped).toHaveLength(1);
      expect(dropped[0]!.role).toBe('t-conv-broken');
      expect(dropped[0]!.reason).toContain('toLlm 抛错');
    } finally {
      dispose();
    }
  });
});

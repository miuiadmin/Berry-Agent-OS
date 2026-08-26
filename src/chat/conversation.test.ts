/**
 * L4 chat — 会话驱动收窄投影测试（第二十四批题3a：纯 backgroundWake 批的
 * run 级工具白名单）。两层覆盖：纯函数判定（混合批/交集/无 filter）+ 驱动
 * 全栈（deliver 带 toolFilter 的 wake 消息实际开起的 run 工具面被收窄、
 * 用户消息 run 全量、基础上下文不被改动）。
 */

import { describe, expect, it } from 'vitest';
import type { AssistantMessage, LlmContext, StreamFn, StreamFnOptions } from '../contracts/llm.js';
import type { AgentTool } from '../contracts/tools.js';
import { ConversationDriver, resolveWakeToolAllowList } from './conversation.js';

/* ---------------- 纯函数：批白名单判定 ---------------- */

describe('resolveWakeToolAllowList（纯函数——批规则四条）', () => {
  it('任一非 backgroundWake（用户在场）→ 不收窄', () => {
    expect(
      resolveWakeToolAllowList([{ backgroundWake: true, toolFilter: ['a'] }, { backgroundWake: false }]),
    ).toBeUndefined();
    // 元数据缺失（submit 直入等）视同用户消息
    expect(resolveWakeToolAllowList([{ backgroundWake: true, toolFilter: ['a'] }, undefined])).toBeUndefined();
  });

  it('全 wake 无 filter → 不收窄；空批 → 不收窄', () => {
    expect(resolveWakeToolAllowList([{ backgroundWake: true }, { backgroundWake: true }])).toBeUndefined();
    expect(resolveWakeToolAllowList([])).toBeUndefined();
  });

  it('单 filter 直取；多 filter 取交集（窄者赢；无 filter 的 wake 不否决）', () => {
    expect(resolveWakeToolAllowList([{ backgroundWake: true, toolFilter: ['a', 'b'] }])).toEqual(new Set(['a', 'b']));
    const both = resolveWakeToolAllowList([
      { backgroundWake: true, toolFilter: ['a', 'b'] },
      { backgroundWake: true, toolFilter: ['b', 'c'] },
      { backgroundWake: true }, // 不携带 filter 的 wake 消息不构成否决
    ]);
    expect(both).toEqual(new Set(['b']));
  });
});

/* ---------------- 驱动全栈：实际开起的 run 工具面 ---------------- */

/** 最小工具（模型面不执行——只过 name 过滤与 toLlmTool 投影） */
function tool(name: string): AgentTool {
  return {
    name,
    description: `${name} 描述`,
    parameters: { type: 'object' },
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  };
}

const TOOLS = [tool('read_file'), tool('write_file'), tool('bash'), tool('goal_get'), tool('goal_update')];

/** 终值文本流（记录每次 LLM 调用上下文——工具面断言依据） */
function recordingStream(contexts: LlmContext[]): StreamFn {
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: '答' }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: 'stop',
    timestamp: 1,
  };
  return (context: LlmContext, _options: StreamFnOptions) => {
    contexts.push(context);
    const events = [
      { type: 'start' as const, partial: { ...message, content: [] } },
      { type: 'done' as const, reason: 'stop' as const, message },
    ];
    const iterator = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next: () =>
            index < events.length
              ? Promise.resolve({ value: events[index++]!, done: false as const })
              : Promise.resolve({ value: undefined, done: true as const }),
        };
      },
    };
    return { ...iterator, result: async () => message };
  };
}

/** 装配最小驱动（真 loop + 脚本模型层——工具面投影走真实 startRun 路径） */
function makeDriver() {
  const contexts: LlmContext[] = [];
  const baseTools = [...TOOLS];
  const driver = new ConversationDriver({
    sessionId: 'test-session',
    context: { messages: [], tools: baseTools },
    loopConfig: {
      streamFn: recordingStream(contexts),
      model: 'test/model',
      convertToLlm: (messages) =>
        // 最小合法转换：用户消息原样、其余合成空 assistant（模型层是脚本，不真消费）
        messages.map((m) =>
          m.role === 'user'
            ? { role: 'user' as const, content: '', timestamp: 1 }
            : {
                role: 'assistant' as const,
                content: [{ type: 'text' as const, text: '' }],
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
                stopReason: 'stop' as const,
                timestamp: 1,
              },
        ),
    },
  });
  return { driver, contexts, baseTools };
}

describe('ConversationDriver 收窄投影（第二十四批题3a）', () => {
  it('纯 wake 批（带 toolFilter）→ 开起的 run 工具面收窄为白名单；基础工具数组不变', async () => {
    const { driver, contexts, baseTools } = makeDriver();
    driver.deliver(
      { role: 'user', content: 'goal 续跑', timestamp: 1 },
      {
        backgroundWake: true,
        toolFilter: ['goal_get', 'goal_update', 'read_file'],
      },
    );
    await driver.settle();
    expect(contexts).toHaveLength(1);
    expect((contexts[0]!.tools ?? []).map((t) => t.name).sort()).toEqual(['goal_get', 'goal_update', 'read_file']);
    // 基础上下文不被动过（后续 run 恢复全量）
    expect(baseTools.map((t) => t.name)).toHaveLength(5);
  });

  it('用户消息 run → 全量工具面（不收窄）；wake 不带 filter → 同样全量', async () => {
    const { driver, contexts } = makeDriver();
    driver.submit('用户手写');
    await driver.settle();
    expect(contexts[0]!.tools ?? []).toHaveLength(5);

    driver.deliver({ role: 'user', content: '无 filter 唤醒', timestamp: 2 }, { backgroundWake: true });
    await driver.settle();
    expect(contexts[1]!.tools ?? []).toHaveLength(5);
    expect(contexts).toHaveLength(2);
  });
});

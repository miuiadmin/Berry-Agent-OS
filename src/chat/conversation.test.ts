/**
 * L4 chat — 会话驱动收窄投影测试（第二十四批题3a：纯 backgroundWake 批的
 * run 级工具白名单）。两层覆盖：纯函数判定（混合批/交集/无 filter）+ 驱动
 * 全栈（deliver 带 toolFilter 的 wake 消息实际开起的 run 工具面被收窄、
 * 用户消息 run 全量、基础上下文不被改动）。
 */

import { describe, expect, it } from 'vitest';
import type { AssistantMessage, LlmContext, StreamFn, StreamFnOptions } from '../contracts/llm.js';
import type { AgentTool } from '../contracts/tools.js';
import { Session } from '../session/session.js';
import type { LlmRetryData } from '../session/event-types.js';
import { createDurableSinks, projectedToAgentMessages } from './durable.js';
import {
  ConversationDriver,
  resolveWakeToolAllowList,
  retryBackoffDelay,
  type ConversationDriverDeps,
} from './conversation.js';

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
function makeDriver(overrides: Partial<ConversationDriverDeps> = {}) {
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
    ...overrides,
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

describe('ConversationDriver 回调异常隔离（隔离案一第一刀 #4 回归锁）', () => {
  it('onRunSettled 订阅方抛错 → 后续订阅照常收 + run 正常结算 + onCallbackError 携来源上报', async () => {
    const seen: { err: unknown; source: string }[] = [];
    const boom = new Error('订阅方 1 坏了');
    const { driver } = makeDriver({
      onCallbackError: (err, source) => seen.push({ err, source }),
    });
    const received: string[] = [];
    driver.onRunSettled(() => {
      throw boom; // 先注册的坏订阅——修复前会穿透 fireRunSettled 毒掉 run 收尾
    });
    driver.onRunSettled((settled) => received.push(settled.status));

    // 修复后：坏订阅只蒸发自己这一次通知，run 照常完成、好订阅照常收
    driver.submit('你好');
    await driver.settle();
    expect(received).toEqual(['completed']); // 后续订阅不被截断
    expect(seen).toEqual([{ err: boom, source: 'onRunSettled' }]); // 诊断归因不静默
    // 驱动存活：第二次 run 照常起（隔离不留暗伤）
    const received2: string[] = [];
    driver.onRunSettled((s) => received2.push(s.status));
    driver.submit('再来');
    await driver.settle();
    expect(received2).toEqual(['completed']); // 第二次 run 的结算
  });

  it('无 onCallbackError 注入时隔离照常（缺省静默隔离不炸 run 收尾）', async () => {
    const { driver } = makeDriver();
    const received: string[] = [];
    driver.onRunSettled(() => {
      throw new Error('无人接管的坏订阅');
    });
    driver.onRunSettled((s) => received.push(s.status));
    driver.submit('x');
    await driver.settle(); // 修复前：坏订阅抛错穿透 run 收尾（settle 拒绝）；修复后正常落定
    expect(received).toEqual(['completed']);
  });
});

/* ---------------- S4 前置债①：会话层 turn 级 auto-retry ---------------- */

/**
 * 脚本模型层：每次调用弹出一个脚本终值（error 终态 → 触发重试检查点）。
 * 事件面最小合法：单 start + 单 done（error 终态收口走 result()，loop 382 行
 * 先判终止事件即 finalize——与真实 StreamFn 行为同构）。
 */
function scriptedStream(scripts: AssistantMessage[], calls?: LlmContext[]): StreamFn {
  let index = 0;
  return (context: LlmContext, _options: StreamFnOptions) => {
    calls?.push(context);
    const message = scripts[Math.min(index, scripts.length - 1)]!;
    index += 1;
    const events = [
      { type: 'start' as const, partial: { ...message, content: [] } },
      { type: 'done' as const, reason: 'stop' as const, message },
    ];
    const iterator = {
      [Symbol.asyncIterator]() {
        let at = 0;
        return {
          next: () =>
            at < events.length
              ? Promise.resolve({ value: events[at++]!, done: false as const })
              : Promise.resolve({ value: undefined, done: true as const }),
        };
      },
    };
    return { ...iterator, result: async () => message };
  };
}

/** 错误终态消息工厂（isTransientError 判据：文案含 retryable-mark） */
const errorAssistant = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  stopReason: 'error',
  errorMessage: text,
  timestamp: 1,
});

/** 成功终态消息工厂 */
const okAssistant = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  stopReason: 'stop',
  timestamp: 1,
});

/** 最小转换（与 makeDriver 同款；user 文本保留——followUp 合流断言依据） */
const minimalConvert = (messages: Parameters<ConversationDriverDeps['loopConfig']['convertToLlm']>[0]) =>
  messages.map((m) =>
    m.role === 'user'
      ? { role: 'user' as const, content: String((m as { content?: unknown }).content ?? ''), timestamp: 1 }
      : {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: '' }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: 'stop' as const,
          timestamp: 1,
        },
  );

/**
 * 装配带持久面驱动（真 Session + durable sinks + 脚本模型层）——S4 重试的
 * 三注入（session/isTransientError/retryPolicy）全接线的全栈形态。
 */
function makeRetryDriver(
  scripts: AssistantMessage[],
  overrides: Partial<ConversationDriverDeps> = {},
): { driver: ConversationDriver; session: InstanceType<typeof Session>; calls: LlmContext[] } {
  const session = new Session();
  const calls: LlmContext[] = [];
  const driver = new ConversationDriver({
    sessionId: 'retry-session',
    context: { messages: [], tools: [] },
    loopConfig: { streamFn: scriptedStream(scripts, calls), model: 'test/model', convertToLlm: minimalConvert },
    durable: createDurableSinks(session),
    session,
    isTransientError: (m) => (m.errorMessage ?? '').includes('retryable-mark'),
    retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
    ...overrides,
  });
  return { driver, session, calls };
}

describe('ConversationDriver turn 级 auto-retry（S4 前置债①）', () => {
  it('transient 错误：重试成功——遮蔽区间完整 + llm/retry scheduled 落账 + 投影无错误 assistant', async () => {
    const { driver, session, calls } = makeRetryDriver([
      errorAssistant('retryable-mark: Connection error'),
      okAssistant('恢复'),
    ]);
    const settled: string[] = [];
    driver.onRunSettled((s) => settled.push(s.status));
    driver.submit('你好');
    await driver.settle();

    expect(calls).toHaveLength(2); // 首跑失败 + 重试一次成功
    expect(settled).toEqual(['completed']); // 重试成功后 run 正常结算

    // llm/retry scheduled 落账：信封携带 surfaceOp，遮蔽区间 = 错误 assistant 起、
    // 高水位止（validateSurfaceOp 溯源断言可过——sourceEventSeqs 全列区间）
    const retryEvents = session.events.filter((e) => e.type === 'llm/retry');
    expect(retryEvents).toHaveLength(1);
    const retry = retryEvents[0]!;
    expect((retry.data as LlmRetryData).phase).toBe('scheduled');
    expect((retry.data as LlmRetryData).attempt).toBe(1);
    expect(retry.surfaceOp).toBeDefined();
    // 遮蔽起点 = 失败 assistant/message 的 seq（user 之后）
    const assistantSeqs = session.events.filter((e) => e.type === 'assistant/message').map((e) => e.seq);
    expect(retry.surfaceOp!.start).toBe(assistantSeqs[0]);
    expect(retry.sourceEventSeqs).toEqual(
      Array.from({ length: retry.surfaceOp!.end - retry.surfaceOp!.start + 1 }, (_, i) => retry.surfaceOp!.start + i),
    );

    // 投影：错误 assistant 被遮蔽——重播种读面只剩成功轮（user + 成功 assistant）
    const roles = projectedToAgentMessages(session.deriveMessages())
      .map((m) => ('role' in m ? (m as { role: string }).role : '?'))
      .filter((r) => r !== '?');
    expect(roles).toEqual(['user', 'assistant']); // 无第二个（错误）assistant
  });

  it('重试帽尽：exhausted 落账、错误 assistant 保留可见、run 失败结算', async () => {
    const { driver, session, calls } = makeRetryDriver([errorAssistant('retryable-mark: 持续失败')], {
      retryPolicy: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
    });
    const settled: string[] = [];
    driver.onRunSettled((s) => settled.push(s.status));
    driver.submit('你好');
    await driver.settle();

    expect(calls).toHaveLength(3); // 首跑 + 2 次重试（帽 2）
    expect(settled).toEqual(['failed']);

    const phases = session.events.filter((e) => e.type === 'llm/retry').map((e) => (e.data as LlmRetryData).phase);
    expect(phases).toEqual(['scheduled', 'scheduled', 'exhausted']); // 每次重试 scheduled + 最终 exhausted

    // 最终失败可见：投影仍含一条 assistant（最后失败的终值——中间失败已遮蔽）
    const finalAssistant = projectedToAgentMessages(session.deriveMessages()).filter(
      (m) => 'role' in m && (m as { role: string }).role === 'assistant',
    );
    expect(finalAssistant).toHaveLength(1);
  });

  it('非 transient（quota 桶）：不占重试名额——单次调用直通失败', async () => {
    const { driver, session, calls } = makeRetryDriver([errorAssistant('insufficient_quota: billing')]);
    driver.submit('你好');
    await driver.settle();
    expect(calls).toHaveLength(1); // 桶判定不过——零重试
    expect(session.events.filter((e) => e.type === 'llm/retry')).toHaveLength(0); // 无任何重试事实落账
  });

  it('无 session（无持久层装配）：重试自动关闭——单次调用直通', async () => {
    const session = new Session();
    const calls: LlmContext[] = [];
    const driver = new ConversationDriver({
      sessionId: 'ephemeral',
      context: { messages: [], tools: [] },
      loopConfig: {
        streamFn: scriptedStream([errorAssistant('retryable-mark: x')], calls),
        model: 'test/model',
        convertToLlm: minimalConvert,
      },
      durable: createDurableSinks(session),
      isTransientError: () => true, // 判定器恒 true 也无用——session 缺席即关闭
    });
    driver.submit('你好');
    await driver.settle();
    expect(calls).toHaveLength(1);
  });

  it('退避期 abort：aborted 落账（requestQuit 取消长退避，零新增机制）', async () => {
    const { driver, session } = makeRetryDriver([errorAssistant('retryable-mark: x'), okAssistant('不到了')], {
      retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 60_000 }, // 长退避——退避中被取消
    });
    driver.submit('你好');
    // 等首跑落定进入退避（微任务 + 一拍），再请求退出
    await new Promise((resolve) => setTimeout(resolve, 10));
    driver.requestQuit();
    await driver.settle();

    const aborted = session.events.filter((e) => e.type === 'llm/retry').map((e) => (e.data as LlmRetryData).phase);
    expect(aborted).toContain('aborted');
  });

  it('followUp 合流：退避期入队的消息与续入同批（重试不吞用户插话）', async () => {
    const { driver, session, calls } = makeRetryDriver([errorAssistant('retryable-mark: x'), okAssistant('恢复')], {
      retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 50 },
    });
    driver.submit('第一问');
    await new Promise((resolve) => setTimeout(resolve, 10)); // 首跑失败已落定，退避中
    driver.submit('插话'); // 退避期入队
    await driver.settle();

    expect(calls).toHaveLength(2); // 续入批带上了插话（不另开 run）
    const secondBatchTexts = (calls[1]!.messages as Array<{ role: string; content: unknown }>)
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : ''));
    expect(secondBatchTexts).toContain('插话');
    // 续入批上下文：错误 assistant 已被重播种剔除——user 之后直接是续入新批
    const assistantCount = (calls[1]!.messages as Array<{ role: string }>).filter((m) => m.role === 'assistant').length;
    expect(assistantCount).toBe(0); // 错误 assistant 不进续入上下文（投影重播种生效）
  });

  it('deliverMeta 保留：退避期投递的 backgroundWake 工具收窄在续入批继续生效', async () => {
    const tools = TOOLS;
    const session = new Session();
    const calls: LlmContext[] = [];
    const driver = new ConversationDriver({
      sessionId: 'wake-merge',
      context: { messages: [...[]], tools },
      loopConfig: {
        streamFn: scriptedStream([errorAssistant('retryable-mark: x'), okAssistant('恢复')], calls),
        model: 'test/model',
        convertToLlm: minimalConvert,
      },
      durable: createDurableSinks(session),
      session,
      isTransientError: (m) => (m.errorMessage ?? '').includes('retryable-mark'),
      retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 50 },
    });
    driver.submit('跑后台');
    await new Promise((resolve) => setTimeout(resolve, 10)); // 退避中
    driver.deliver(
      { role: 'user', content: '后台续命', timestamp: 2 },
      { backgroundWake: true, toolFilter: ['read_file'] },
    );
    await driver.settle();

    // 续入批的 run 工具面被收窄为 wake 白名单（deliverMeta 跨重试存活）
    expect((calls[1]!.tools ?? []).map((t) => t.name)).toEqual(['read_file']);
  });
});

describe('retryBackoffDelay（S4 前置债①——指数 + 等比半幅抖动）', () => {
  it('区间断言：attempt n ∈ [base·2^(n-1)·0.5, base·2^(n-1)]（下界 > 0 不零延迟）', () => {
    const base = 1000;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const exponential = base * 2 ** (attempt - 1);
      for (let sample = 0; sample < 50; sample++) {
        const delay = retryBackoffDelay(attempt, base);
        expect(delay).toBeGreaterThanOrEqual(Math.round(exponential * 0.5));
        expect(delay).toBeLessThanOrEqual(Math.round(exponential));
      }
    }
  });
});

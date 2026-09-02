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
// goal 件 durable 词汇注册（模块加载即注册面）——遗漏大扫 20260902-c #1 回归锁需
// append goal/evidence（测试豁免模块 DAG，跨模块导入合法；本导入轻量只触注册面）
import '../goal/events.js';
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

/* ---------------- 刀三：轮身份归因定型 + durability 屏障 + 复验桥 ---------------- */

describe('ConversationDriver 刀三轮身份与 durability 屏障', () => {
  it('归因定型：批内 user 消息 attribution 进 currentAttribution；结算后闲时保留（onRunSettled 消费窗）；无归因批复位 undefined（跨 run 不泄漏）', async () => {
    const { driver, contexts } = makeDriver();
    const attribution = { goalId: 'G1', wakeId: 'w1', wakePath: 'self' };
    // 后台唤醒批携归因——launch 定型（倒扫批内最近 user 归因）
    driver.deliver({ role: 'user', content: 'goal 续跑', timestamp: 1, attribution }, { backgroundWake: true });
    await driver.settle();
    expect(contexts).toHaveLength(1);
    expect(driver.currentAttribution).toEqual(attribution);
    // 下一 run 用户手写（无归因）→ 显式复位 undefined（防上一 run 值泄漏）
    driver.submit('用户手写');
    await driver.settle();
    expect(driver.currentAttribution).toBeUndefined();
  });

  it('durability 屏障只对后台 run：前台模型步前零 flush；后台恰一次（单步 run）；复验桥前后台都过', async () => {
    const flushed: string[] = [];
    let preSteps = 0;
    const { driver, contexts } = makeDriver({
      flushSession: async (sessionId) => {
        flushed.push(sessionId);
      },
      onPreModelStep: async () => {
        preSteps += 1;
        return undefined;
      },
    });
    driver.submit('用户手写');
    await driver.settle();
    expect(contexts).toHaveLength(1);
    expect(flushed).toEqual([]); // 前台不 flush——不给用户手写对话加每轮落盘等待
    driver.deliver({ role: 'user', content: 'goal 续跑', timestamp: 2 }, { backgroundWake: true });
    await driver.settle();
    expect(flushed).toEqual(['test-session']); // 后台 run 每模型步前恰一次（崩溃恢复账实对齐）
    expect(preSteps).toBe(2); // 复验桥与投递来源无关（每模型步一次）
  });

  it('onPreModelStep 复验短路：{stop:true} → run completed 收场零模型调用（「正在跑的轮跑完为止」不破）', async () => {
    const { driver, contexts } = makeDriver({ onPreModelStep: async () => ({ stop: true }) });
    const result = await driver.submitOnce('跑', {
      source: 'app:goal',
      attribution: { goalId: 'G1', wakeId: 'w1', wakePath: 'self' },
    });
    expect(contexts).toHaveLength(0); // 模型调用一次没发
    expect(result?.status).toBe('completed');
    // 归因照常定型（停因处置归回调方——驱动只收场）
    expect(driver.currentAttribution).toEqual({ goalId: 'G1', wakeId: 'w1', wakePath: 'self' });
  });
});

/* ---------------- 刀四：submitOnce 投递面（tick 挂钟投递口） ---------------- */

describe('ConversationDriver 刀四 submitOnce 投递面（挂钟投递口）', () => {
  it('backgroundWake + toolFilter → run 工具面收窄（deliverMeta 与 deliver 同一消费面）', async () => {
    const { driver, contexts, baseTools } = makeDriver();
    await driver.submitOnce('goal 挂钟轮', {
      source: 'app:goal',
      attribution: { goalId: 'G9', wakeId: 'w9', wakePath: 'tick' },
      backgroundWake: true,
      toolFilter: ['goal_get', 'read_file'],
    });
    expect(contexts).toHaveLength(1);
    expect((contexts[0]!.tools ?? []).map((t) => t.name).sort()).toEqual(['goal_get', 'read_file']);
    expect(baseTools).toHaveLength(5); // 基础数组不动（收窄只在开起的 run）
    expect(driver.currentAttribution).toEqual({ goalId: 'G9', wakeId: 'w9', wakePath: 'tick' });
  });

  it('非后台 submitOnce 携 toolFilter → 不收窄（在场信号优先——用户手写语义）', async () => {
    const { driver, contexts } = makeDriver();
    await driver.submitOnce('berry run CLI 用户在场', { toolFilter: ['goal_get'] });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.tools ?? []).toHaveLength(5); // 全量——toolFilter 被忽略
  });

  it('wakeCount 记账：后台 submitOnce 各 +1 → 第 4 次后台投递降级 inject；用户消息恢复预算', async () => {
    const { driver, contexts } = makeDriver();
    // 3 次后台 submitOnce（挂钟轮 + 进程内自激链的账——各 +1）
    for (let i = 0; i < 3; i++) {
      await driver.submitOnce(`挂钟轮 ${i}`, { backgroundWake: true });
    }
    expect(contexts).toHaveLength(3);
    // 第 4 次后台投递（idle deliver 路）：连击帽满 → inject 降级只留记录
    const channel = driver.deliver({ role: 'user', content: '第 4 次唤醒', timestamp: 4 }, { backgroundWake: true });
    expect(channel).toBe('inject');
    expect(contexts).toHaveLength(3); // 未开新 run
    // 用户手写（非后台 submitOnce）：在场信号——计数恢复
    await driver.submitOnce('用户回来了', {});
    // 预算已复：后台投递重新可开 run
    const revived = driver.deliver({ role: 'user', content: '预算恢复后唤醒', timestamp: 5 }, { backgroundWake: true });
    expect(revived).toBe('followUp');
    await driver.settle();
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
    const { driver, calls } = makeRetryDriver([errorAssistant('retryable-mark: x'), okAssistant('恢复')], {
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

describe('ConversationDriver 溢出兜底（第四十五批 compact-and-retry-once）', () => {
  /** 溢出错误终态工厂（isOverflowError 判据：文案含 overflow-mark——非 transient 桶互斥） */
  const overflowError = (text = 'context window exceeded') => errorAssistant(`overflow-mark: ${text}`);

  /** length 零输出终态工厂（isContextOverflow Case 3 形态：input 填满窗 ×0.99 以上 + 零产出——静默截断型溢出的失败终态轮） */
  const lengthOverflow = (): AssistantMessage => ({
    role: 'assistant',
    content: [],
    usage: { input: 99_500, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 99_500 },
    stopReason: 'length',
    timestamp: 1,
  });

  /** 静默溢出成功轮工厂（isContextOverflow Case 2 形态：正常停 + input 严格超窗——成功轮，分诊红线：不进恢复） */
  const silentOverflow = (text: string): AssistantMessage => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { input: 120_000, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 120_005 },
    stopReason: 'stop',
    timestamp: 1,
  });

  /** 压缩面 stub：按序弹结果 + 调用计数（可选 gate 手动放行——abort 窗制造） */
  function compactionStub(results: Array<'compacted' | 'nothing' | 'failed'>) {
    const calls: Array<'compacted' | 'nothing' | 'failed'> = [];
    let index = 0;
    let gate: Promise<void> | undefined;
    const impl: {
      resolveCompaction: () => { compactForOverflow(): Promise<'compacted' | 'nothing' | 'failed'> };
      results: typeof calls;
      release: () => void;
      hold: () => void;
    } = {
      resolveCompaction: () => ({
        compactForOverflow: async () => {
          if (gate !== undefined) await gate; // 在飞窗口（互斥/取消检查点测试用）
          const verdict = results[Math.min(index, results.length - 1)]!;
          index += 1;
          calls.push(verdict);
          return verdict;
        },
      }),
      results: calls,
      release: () => {}, // hold() 后被替换为真实放行（缺省无门直接跑）
      hold: () => {
        let releaseFn!: () => void;
        gate = new Promise<void>((r) => {
          releaseFn = r;
        });
        impl.release = () => releaseFn();
      },
    };
    return impl;
  }

  it('恢复成功：遮蔽 + compactForOverflow + 重播种 + 续入——scheduled reason=overflow 名额 1/1 退避零', async () => {
    const comp = compactionStub(['compacted']);
    const { driver, session, calls } = makeRetryDriver([overflowError(), okAssistant('恢复')], {
      isOverflowError: (m) => (m.errorMessage ?? '').includes('overflow-mark'),
      resolveCompaction: comp.resolveCompaction,
    });
    const settled: string[] = [];
    driver.onRunSettled((s) => settled.push(s.status));
    driver.submit('你好');
    await driver.settle();

    expect(calls).toHaveLength(2); // 首跑溢出 + 续入一次成功
    expect(settled).toEqual(['completed']);
    expect(comp.results).toEqual(['compacted']); // 压缩面恰一次调用

    // llm/retry scheduled 落账：溢出腿自有名额分账（attempt 1 / maxAttempts 1 / 退避零）+ reason 穿透
    const retry = session.events.find((e) => e.type === 'llm/retry')!;
    expect(retry.data).toMatchObject({
      phase: 'scheduled',
      attempt: 1,
      maxAttempts: 1,
      delayMs: 0,
      reason: 'overflow',
    });
    expect(retry.surfaceOp).toBeDefined(); // 遮蔽随行（信封携带）
    // 投影无错误 assistant（步 1 遮蔽 + 步 3 重播种——续入上下文干净）
    const roles = projectedToAgentMessages(session.deriveMessages())
      .map((m) => ('role' in m ? (m as { role: string }).role : '?'))
      .filter((r) => r !== '?');
    expect(roles).toEqual(['user', 'assistant']); // 唯一 assistant 是成功轮
  });

  it('二次溢出：名额已耗诚实收尾——exhausted reason=overflow + 末错误 assistant 保留呈现 + 压缩面不再调', async () => {
    const comp = compactionStub(['compacted', 'compacted']);
    const { driver, session, calls } = makeRetryDriver([overflowError(), overflowError('又溢出')], {
      isOverflowError: (m) => (m.errorMessage ?? '').includes('overflow-mark'),
      resolveCompaction: comp.resolveCompaction,
    });
    const settled: string[] = [];
    driver.onRunSettled((s) => settled.push(s.status));
    driver.submit('你好');
    await driver.settle();

    expect(calls).toHaveLength(2); // 溢出→恢复→再溢出→名额尽（不再续入）
    expect(settled).toEqual(['failed']);
    expect(comp.results).toEqual(['compacted']); // 二次溢出不再压缩（retry-once）

    // exhausted 落账（attempt 1/1 reason overflow——三失败混同读侧辨因：二次溢出有续入轮 usage）
    const facts = session.events.filter((e) => e.type === 'llm/retry').map((e) => e.data as LlmRetryData);
    expect(facts.map((d) => d.phase)).toEqual(['scheduled', 'exhausted']);
    expect(facts[1]).toMatchObject({ attempt: 1, maxAttempts: 1, reason: 'overflow' });
    // 末错误 assistant 未遮蔽（保留呈现——诚实失败可见）
    const roles = projectedToAgentMessages(session.deriveMessages())
      .map((m) => ('role' in m ? (m as { role: string }).role : '?'))
      .filter((r) => r !== '?');
    expect(roles).toEqual(['user', 'assistant']);
  });

  it("'nothing'（压缩救不了）：诚实失败收尾——步 1 遮蔽与步 3 重播种照做（投影无悬空 toolUse）", async () => {
    const comp = compactionStub(['nothing']);
    const { driver, session } = makeRetryDriver([overflowError()], {
      isOverflowError: (m) => (m.errorMessage ?? '').includes('overflow-mark'),
      resolveCompaction: comp.resolveCompaction,
    });
    const settled: string[] = [];
    driver.onRunSettled((s) => settled.push(s.status));
    driver.submit('你好');
    await driver.settle();

    expect(settled).toEqual(['failed']);
    const facts = session.events.filter((e) => e.type === 'llm/retry').map((e) => e.data as LlmRetryData);
    expect(facts.map((d) => d.phase)).toEqual(['scheduled', 'exhausted']);
    // 遮蔽已做（步 1 先行）+ 重播种无条件（步 3——P1-2 顺序约束的对价面）
    expect(facts[0]!.phase === 'scheduled' && facts[0]!.reason).toBe('overflow');
    const roles = projectedToAgentMessages(session.deriveMessages())
      .map((m) => ('role' in m ? (m as { role: string }).role : '?'))
      .filter((r) => r !== '?');
    expect(roles).toEqual(['user']); // 错误 assistant 已遮蔽（已遮蔽路径无条件重播种）
  });

  it("'failed'（摘要抛错）：同 exhausted 收尾——读侧经 compaction/failed 事件辨因（件面另锁）", async () => {
    const comp = compactionStub(['failed']);
    const { driver, session } = makeRetryDriver([overflowError()], {
      isOverflowError: (m) => (m.errorMessage ?? '').includes('overflow-mark'),
      resolveCompaction: comp.resolveCompaction,
    });
    const settled: string[] = [];
    driver.onRunSettled((s) => settled.push(s.status));
    driver.submit('你好');
    await driver.settle();

    expect(settled).toEqual(['failed']);
    const facts = session.events.filter((e) => e.type === 'llm/retry').map((e) => e.data as LlmRetryData);
    expect(facts.map((d) => d.phase)).toEqual(['scheduled', 'exhausted']);
    expect(facts[1]!.reason).toBe('overflow');
  });

  it('length 零输出（触发面分诊 Case 3）：失败终态轮进恢复——五步全走 + 遮蔽零输出 assistant + 续入成功', async () => {
    const comp = compactionStub(['compacted']);
    const { driver, session, calls } = makeRetryDriver([lengthOverflow(), okAssistant('恢复')], {
      // 判定器镜像 deps.isOverflowError 的 Case 3 形（携窗确认 length+零产出）
      isOverflowError: (m) => m.stopReason === 'length' && m.usage.output === 0,
      resolveCompaction: comp.resolveCompaction,
    });
    const settled: string[] = [];
    driver.onRunSettled((s) => settled.push(s.status));
    driver.submit('你好');
    await driver.settle();

    expect(calls).toHaveLength(2); // 首轮零产出 + 压缩后续入一次成功
    expect(settled).toEqual(['completed']); // 恢复成功即正常结算
    expect(comp.results).toEqual(['compacted']); // 压缩面恰一次调用
    const facts = session.events.filter((e) => e.type === 'llm/retry').map((e) => e.data as LlmRetryData);
    expect(facts[0]).toMatchObject({ phase: 'scheduled', attempt: 1, maxAttempts: 1, delayMs: 0, reason: 'overflow' });
    // 零输出 assistant 已遮蔽——投影唯一 assistant 是续入成功轮
    const roles = projectedToAgentMessages(session.deriveMessages())
      .map((m) => ('role' in m ? (m as { role: string }).role : '?'))
      .filter((r) => r !== '?');
    expect(roles).toEqual(['user', 'assistant']);
  });

  it('静默溢出（触发面分诊 Case 2）：成功轮不进恢复——判定器确认也不遮蔽不压缩（阈值路辖区）', async () => {
    const comp = compactionStub(['compacted']);
    const { driver, session, calls } = makeRetryDriver([silentOverflow('满窗回答')], {
      isOverflowError: () => true, // 判定器三路能力面在场且恒确认——分诊闸仍须拒成功轮
      resolveCompaction: comp.resolveCompaction,
    });
    const settled: string[] = [];
    driver.onRunSettled((s) => settled.push(s.status));
    driver.submit('你好');
    await driver.settle();

    expect(calls).toHaveLength(1); // 无续入
    expect(comp.results).toEqual([]); // 压缩面零调用
    expect(session.events.filter((e) => e.type === 'llm/retry')).toHaveLength(0); // 零恢复事实落账
    expect(settled).toEqual(['completed']); // 成功轮原样结算
    // 成功 assistant 原样保留（分诊红线的对价面：遮蔽成功轮 = 把已交付回答从投影抹掉）
    const assistants = projectedToAgentMessages(session.deriveMessages()).filter(
      (m) => 'role' in m && (m as { role: string }).role === 'assistant',
    );
    expect(assistants).toHaveLength(1);
  });

  it('length 恢复失败（nothing）：exhausted 落账 + 终态改写 failed——零产出轮不冒充 completed', async () => {
    const comp = compactionStub(['nothing']);
    const { driver, session } = makeRetryDriver([lengthOverflow()], {
      isOverflowError: (m) => m.stopReason === 'length' && m.usage.output === 0,
      resolveCompaction: comp.resolveCompaction,
    });
    const settled: string[] = [];
    driver.onRunSettled((s) => settled.push(s.status));
    driver.submit('你好');
    await driver.settle();

    // loop 状态推导把 length 归 completed——恢复失败收尾由驱动按 #3 拍板改写 failed
    expect(settled).toEqual(['failed']);
    const facts = session.events.filter((e) => e.type === 'llm/retry').map((e) => e.data as LlmRetryData);
    expect(facts.map((d) => d.phase)).toEqual(['scheduled', 'exhausted']);
    expect(facts[1]).toMatchObject({ attempt: 1, maxAttempts: 1, reason: 'overflow' });
  });

  it('倒扫白名单化（遗漏大扫 20260902-c #1）：goal/evidence 预算越限笔同步落入遮蔽区间——恢复照走不静默放弃', async () => {
    // 报告场景镜像：active goal 剩余预算 < 一条溢出零输出消息的 input usage——
    // goal ④ 预算监听器挂 session/event 活体总线，assistant/message 同步记账且
    // 越限即同步 appendEvent('goal/evidence')（goal/app.ts:551），经 registry
    // 路由回同一条目落在 assistant/message（N）与 llm/usage（N+2）之间。此处用
    // Session emit 钩子同形复刻该同步镜像（监听器只在 delta>0 的 assistant 上落笔）
    const goalSession = new Session({
      sessionId: 'goal-mirror',
      emit: (event) => {
        if (event.type !== 'assistant/message') return;
        const usage = (event.data as { usage?: { input?: number } }).usage;
        if (usage === undefined || usage.input === 0) return; // delta=0 不记账（监听器同判）
        goalSession.append('goal/evidence', { goalId: 'g-overflow', reason: 'budget', willRetry: false });
      },
    });
    const calls: LlmContext[] = [];
    const comp = compactionStub(['nothing']); // 压缩救不了 → 诚实失败（run 终值 failed）
    const driver = new ConversationDriver({
      sessionId: 'goal-mirror',
      context: { messages: [], tools: [] },
      loopConfig: {
        streamFn: scriptedStream([lengthOverflow()], calls),
        model: 'test/model',
        convertToLlm: minimalConvert,
      },
      durable: createDurableSinks(goalSession),
      session: goalSession,
      isOverflowError: (m) => m.stopReason === 'length' && m.usage.output === 0,
      resolveCompaction: comp.resolveCompaction,
    });
    const settled: string[] = [];
    driver.onRunSettled((s) => settled.push(s.status));
    driver.submit('你好');
    await driver.settle();

    // 落账序物证先行：goal/evidence 确实插在 assistant/message 与 llm/usage 之间
    // （否则白名单化后测试退化为普通恢复锁——遮蔽窗口内无污染事件）
    const seqOf = (type: string) => goalSession.events.find((e) => e.type === type)!.seq;
    expect(seqOf('goal/evidence')).toBeGreaterThan(seqOf('assistant/message'));
    expect(seqOf('goal/evidence')).toBeLessThan(seqOf('llm/usage'));
    // 修前红锚：倒扫在 goal/evidence 撞墙 return false——无遮蔽无恢复事实，
    // 零产出轮冒充 completed 收场；修后：恢复全走（scheduled+exhausted + failed）
    const facts = goalSession.events.filter((e) => e.type === 'llm/retry').map((e) => e.data as LlmRetryData);
    expect(facts.map((d) => d.phase)).toEqual(['scheduled', 'exhausted']);
    expect(facts[0]).toMatchObject({ attempt: 1, maxAttempts: 1, reason: 'overflow' });
    expect(settled).toEqual(['failed']);
    expect(comp.results).toEqual(['nothing']);
  });

  it('双缺省直通：无判定器/无压缩面注入——单次调用直通失败零落账（诊断装配形态）', async () => {
    const { driver, session, calls } = makeRetryDriver([overflowError()]); // 两注入均缺省
    const settled: string[] = [];
    driver.onRunSettled((s) => settled.push(s.status));
    driver.submit('你好');
    await driver.settle();

    expect(calls).toHaveLength(1);
    expect(settled).toEqual(['failed']);
    expect(session.events.filter((e) => e.type === 'llm/retry')).toHaveLength(0); // 无遮蔽无落账
    // 错误 assistant 保留呈现（直通）
    const roles = projectedToAgentMessages(session.deriveMessages())
      .map((m) => ('role' in m ? (m as { role: string }).role : '?'))
      .filter((r) => r !== '?');
    expect(roles).toEqual(['user', 'assistant']);
  });

  it('名额分账：溢出恢复后 transient 错误照常占 transient 配额（两腿名额互不侵占）', async () => {
    const comp = compactionStub(['compacted']);
    const { driver, session, calls } = makeRetryDriver(
      [overflowError(), errorAssistant('retryable-mark: 抖动'), okAssistant('好了')],
      {
        isOverflowError: (m) => (m.errorMessage ?? '').includes('overflow-mark'),
        resolveCompaction: comp.resolveCompaction,
      },
    );
    const settled: string[] = [];
    driver.onRunSettled((s) => settled.push(s.status));
    driver.submit('你好');
    await driver.settle();

    // 溢出腿一次（名额 1/1）+ transient 腿一次（attempt 1 / 帽 3——配额独立分账）
    expect(calls).toHaveLength(3);
    expect(settled).toEqual(['completed']);
    const facts = session.events.filter((e) => e.type === 'llm/retry').map((e) => e.data as LlmRetryData);
    expect(facts.map((d) => `${d.phase}:${d.reason ?? 'transient'}`)).toEqual([
      'scheduled:overflow',
      'scheduled:transient',
    ]);
    expect(facts[1]).toMatchObject({ attempt: 1, maxAttempts: 3 }); // transient 名额帽 = 策略帽（非 1）
  });

  it('续入前取消：压缩结算后 signal 已 abort → aborted 落账 + 终值统一 aborted（S6 形态③）', async () => {
    const comp = compactionStub(['compacted']);
    comp.hold(); // 压缩在飞窗口（不可中断——取消检查点在结算后）
    const { driver, session } = makeRetryDriver([overflowError(), okAssistant('到不了')], {
      isOverflowError: (m) => (m.errorMessage ?? '').includes('overflow-mark'),
      resolveCompaction: comp.resolveCompaction,
    });
    const settled: string[] = [];
    driver.onRunSettled((s) => settled.push(s.status));
    driver.submit('你好');
    await new Promise((resolve) => setTimeout(resolve, 10)); // 首跑溢出已进压缩 await
    driver.requestQuit(); // 压缩在飞时取消（等压缩结算——秒级窗口接受面）
    comp.release();
    await driver.settle();

    expect(settled).toEqual(['aborted']);
    const facts = session.events.filter((e) => e.type === 'llm/retry').map((e) => e.data as LlmRetryData);
    expect(facts.map((d) => d.phase)).toEqual(['scheduled', 'aborted']);
    expect(facts[1]!.reason).toBe('overflow');
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

/* ---------------- S6 信号多驱动化：驱动级取消模型 ---------------- */

/**
 * 立即完成的流迭代器（done 终态——续轮/失败脚本用）。
 * 事件面最小合法：单 start + 单 done（start 与 done 之间无增量——loop 消费同构）。
 */
function doneIterator(message: AssistantMessage) {
  const events = [
    { type: 'start' as const, partial: { ...message, content: [] } },
    { type: 'done' as const, reason: 'stop' as const, message },
  ];
  return {
    [Symbol.asyncIterator]() {
      let at = 0;
      return {
        next: () =>
          at < events.length
            ? Promise.resolve({ value: events[at++]!, done: false as const })
            : Promise.resolve({ value: undefined, done: true as const }),
      };
    },
    result: async () => message,
  };
}

/** abort 终止事件（error 流事件编码 reason:'aborted'——loop 终值映射 aborted 的输入形） */
const abortEvent = (message: AssistantMessage) => ({
  value: {
    type: 'error' as const,
    reason: 'aborted' as const,
    error: { ...message, stopReason: 'aborted' as const },
  },
  done: false as const,
});

/**
 * 挂起流（S6 驱动级测试）：首轮挂起直到 abort（abort → error{reason:'aborted'}
 * 终止事件——对齐 loop「StreamFn 编码 aborted」契约）；续轮（打断后捎跑的新
 * run——换新控制器）立即正常完成。同一 streamFn 覆盖「被打断 + 打断后再跑」
 * 两段语义，记录每次模型调用上下文。
 */
function pendingOnceStream(calls: LlmContext[]): StreamFn {
  return (context: LlmContext, _options: StreamFnOptions, signal?: AbortSignal) => {
    calls.push(context);
    if (calls.length > 1) return doneIterator(okAssistant('续答'));
    const message = okAssistant('慢答');
    return {
      [Symbol.asyncIterator]() {
        let at = 0;
        const events = [{ type: 'start' as const, partial: { ...message, content: [] } }];
        return {
          next: async () => {
            if (at < events.length) return { value: events[at++]!, done: false as const };
            // 挂起直到 abort（startRun 把 hooks.signal 透传为第三位参数）——
            // 已 abort 短路先判（signal 事件只发一次，事后挂监听收不到）
            if (signal?.aborted) return abortEvent(message);
            await new Promise((resolve) => {
              signal?.addEventListener('abort', resolve, { once: true });
            });
            return abortEvent(message);
          },
        };
      },
      // result() 契约（loop 收口以它为准）：abort 编码进返回消息的 stopReason
      //——loop 终态短路（stopReason 'aborted' → RunStatus aborted）读的是这里
      result: async () => (signal?.aborted ? { ...message, stopReason: 'aborted' } : message),
    };
  };
}

/** 装配 S6 测试驱动（真 Session durable + 挂起流；记录模型调用上下文） */
function makeS6Driver() {
  const session = new Session();
  const calls: LlmContext[] = [];
  const driver = new ConversationDriver({
    sessionId: 's6-session',
    context: { messages: [], tools: [] },
    loopConfig: { streamFn: pendingOnceStream(calls), model: 'test/model', convertToLlm: minimalConvert },
    durable: createDurableSinks(session),
    session,
  });
  return { driver, session, calls };
}

/** 宏任务一拍（挂起流的在飞窗口需要真实事件循环推进） */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('ConversationDriver 驱动级取消模型（S6 形态①②③）', () => {
  it('run 中 interrupt：aborted 终态 + isRunning 复位 + quit 不 resolve + 后续 submit 开新 run', async () => {
    const { driver, session, calls } = makeS6Driver();
    const settled: string[] = [];
    driver.onRunSettled((s) => settled.push(s.status));
    const pending = driver.submitOnce('慢问');
    await tick(); // 等 run 真在飞（挂起流已开）
    expect(driver.isRunning).toBe(true);

    // interrupt：abort 在飞轮 + 清余量 + 不停摆
    const quitDone: boolean[] = [];
    void driver.quit.then(() => quitDone.push(true));
    await driver.interrupt(); // 等被打断 run 结算（interrupt 返回 runPromise）
    const result = await pending;
    expect(result?.status).toBe('aborted'); // 形态③：主动取消终值统一 aborted
    expect(result?.stopReason).toBe('aborted');
    expect(driver.isRunning).toBe(false);
    expect(settled).toEqual(['aborted']);
    await tick();
    expect(quitDone).toHaveLength(0); // 「不退 OS」的机制兑现：quit promise 不 resolve
    expect(session.events.some((e) => e.type === 'user/message')).toBe(true); // 打断不吞账——开场问句已 durable

    // 后续 submit 正常开新 run（换新控制器——被打断不传染，形态②）
    driver.submit('打断后再问');
    await driver.settle();
    expect(calls.length).toBe(2);
    expect(settled).toEqual(['aborted', 'completed']); // 新 run 正常完成
  });

  it('打断前 steering 余量：interrupt 时点清空 → inject 落审计（可见、不跑）', async () => {
    const { driver, session, calls } = makeS6Driver();
    const pending = driver.submitOnce('慢问');
    await tick(); // run 在飞
    driver.submit('排队中的插话'); // running → steer 入队（打断前余量）
    await driver.interrupt();
    await pending;

    expect(calls.length).toBe(1); // 余量不捎跑（interrupt 已清空——「弃当前批次」）
    // 余量走 inject：只落日志保审计（message_start/end → durable user/message）
    const userEvents = session.events.filter((e) => e.type === 'user/message');
    expect(userEvents).toHaveLength(2); // 开场问句 + 被弃置的插话（审计不断流）
    // 队列确已清空：驱动闲时——后续无幽灵续跑
    await tick();
    expect(driver.isRunning).toBe(false);
    expect(calls.length).toBe(1);
  });

  it('打断后窗口期新输入：followUp 循环捎跑（循环判据只看停摆——形态②）', async () => {
    const { driver, calls } = makeS6Driver();
    const settled: string[] = [];
    driver.onRunSettled((s) => settled.push(s.status));
    driver.submit('慢问');
    await tick(); // run 在飞（挂起流）
    const interruptSettled = driver.interrupt(); // 不等结算——窗口期紧接新输入
    driver.submit('打断后的新输入'); // running 仍真 → steer 入队
    await interruptSettled; // runPromise 涵盖捎跑批（同一 launch 的 followUp 循环）

    expect(calls.length).toBe(2); // 捎跑批真开了（换新控制器——被打断不传染）
    const secondBatch = (calls[1]!.messages as Array<{ role: string; content: unknown }>)
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : ''));
    expect(secondBatch).toContain('打断后的新输入');
    expect(settled).toEqual(['completed']); // 终值如实 = 最后批完整（形态③：间隙窗不改判）
  });

  it('工具执行中 interrupt × 窗口期新输入：垂死 run 不偷队（turn 边界拒抽闸）——followUp 换新控制器捎跑（20260901-c #6，Path B）', async () => {
    // Path B（与上例 Path A 分立）：interrupt 落在工具执行中——工具批 abort
    // break 后流程仍走 turn_end → steering 轮询（与流中断路的终态短路不同）。
    // 修前轮询不查 run 信号 aborted，把收尾窗内新入队消息偷进垂死 run：落账
    // 回显后永无应答（下一轮 aborted 终态收场、followUp 见空队列不捎跑）。
    // 修后拒抽闸空手而归，消息留给 followUp 循环换新控制器捎跑（形态② 承诺）。
    const toolStarted: boolean[] = [];
    // 合作形挂起工具：执行即报告在飞，挂住直到 run 信号 abort（对齐 signal 取消）
    const slowTool: AgentTool = {
      name: 'slow',
      description: '挂起直到 run 取消（Path B 编排用）',
      parameters: { type: 'object', properties: {} },
      execute: (_id, _args, signal) =>
        new Promise((resolve) => {
          toolStarted.push(true);
          const finish = () => resolve({ content: [{ type: 'text', text: '工具被取消' }], isError: true });
          if (signal?.aborted) {
            finish();
            return;
          }
          signal?.addEventListener('abort', finish, { once: true });
        }),
    };
    const session = new Session();
    const calls: LlmContext[] = [];
    const abortedFlags: boolean[] = []; // 每次模型调用时刻的 run 信号态（换新控制器证明）
    const streamFn: StreamFn = (context, _options, signal) => {
      calls.push(context);
      abortedFlags.push(signal?.aborted ?? false);
      // abort 诚实编码（loop 终态短路的输入形）：垂死 run 的下一轮立即 aborted
      if (signal?.aborted) return doneIterator({ ...okAssistant('垂死'), stopReason: 'aborted' });
      if (calls.length === 1) {
        return doneIterator({
          ...okAssistant('调工具'),
          content: [{ type: 'toolCall', id: 'call-slow-1', name: 'slow', arguments: {} }],
          stopReason: 'toolUse',
        });
      }
      return doneIterator(okAssistant('窗口期答'));
    };
    const driver = new ConversationDriver({
      sessionId: 's6-pathb',
      context: { messages: [], tools: [slowTool] },
      loopConfig: { streamFn, model: 'test/model', convertToLlm: minimalConvert },
      durable: createDurableSinks(session),
      session,
    });
    const settled: string[] = [];
    driver.onRunSettled((s) => settled.push(s.status));
    const pending = driver.submitOnce('慢活');
    // 等工具真在执行（宏任务自旋有界——挂起点在工具 promise，非流迭代）
    for (let i = 0; i < 200 && toolStarted.length === 0; i += 1) await tick();
    expect(toolStarted).toHaveLength(1);
    expect(driver.isRunning).toBe(true);

    // interrupt 落在工具执行中（abort 同步达工具监听器）；不等结算紧接窗口期新输入
    const interruptSettled = driver.interrupt();
    driver.submit('窗口期新输入'); // running 仍真 → steer 入队（收尾窗内——缺陷现场）
    await interruptSettled; // runPromise 涵盖 followUp 捎跑批（同一 launch）
    const result = await pending;

    // 调用序三段（工具路垂死形态）：[0] 工具轮 / [1] 垂死轮（工具批 abort break
    // 后内层仍迭代一次模型步——aborted 终态短路收场，Path B 与流中断路的分野）/
    // [2] followUp 换新控制器轮（信号未取消——修前队列被 [1] 前的轮询偷走，
    // 此轮不发生，calls 止于 2）
    expect(calls.length).toBe(3);
    expect(abortedFlags[1]).toBe(true); // 垂死轮如实 aborted（打断当轮弃置）
    expect(abortedFlags[2]).toBe(false); // 换新控制器——被打断不传染
    const secondBatch = (calls[2]!.messages as Array<{ role: string; content: unknown }>)
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : ''));
    expect(secondBatch).toContain('窗口期新输入'); // 窗口期消息真被答到
    expect(result?.status).toBe('completed'); // 修前 run 整体 aborted（消息无应答）
    expect(settled).toEqual(['completed']);
    // 应答真落账（修前只有消息落账没有应答——「看得到、永远不答」的反面）
    const answer = session.events.find(
      (e) => e.type === 'assistant/message' && JSON.stringify(e.data).includes('窗口期答'),
    );
    expect(answer).toBeDefined();
  });

  it('退避窗 interrupt：aborted 落账 + 终值统一 aborted + 不停摆（S6 形态③验证）', async () => {
    // 首跑 transient 失败 → 长退避中 interrupt：requestQuit 同款 abort 路，但驱动不停摆
    const session = new Session();
    let call = 0;
    const driver = new ConversationDriver({
      sessionId: 's6-backoff',
      context: { messages: [], tools: [] },
      loopConfig: {
        // 首轮立即失败（transient）触发退避；续轮（打断后新 run）正常完成
        streamFn: () => {
          call += 1;
          return doneIterator(call === 1 ? errorAssistant('retryable-mark: x') : okAssistant('续答'));
        },
        model: 'test/model',
        convertToLlm: minimalConvert,
      },
      durable: createDurableSinks(session),
      session,
      isTransientError: (m) => (m.errorMessage ?? '').includes('retryable-mark'),
      retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 60_000 }, // 长退避——退避中被打断
    });
    const settled: string[] = [];
    driver.onRunSettled((s) => settled.push(s.status));
    const pending = driver.submitOnce('问');
    await tick(); // 首跑已失败、退避中
    await driver.interrupt();
    const result = await pending;

    expect(result?.status).toBe('aborted'); // 形态③：退避窗被打断 → aborted（非 failed）
    expect(settled).toEqual(['aborted']);
    expect(session.events.filter((e) => e.type === 'llm/retry').map((e) => (e.data as LlmRetryData).phase)).toContain(
      'aborted',
    );
    // 不停摆：quit 不 resolve + 后续 submit 开新 run
    let quitResolved = false;
    void driver.quit.then(() => {
      quitResolved = true;
    });
    driver.submit('打断后再问');
    await driver.settle();
    expect(quitResolved).toBe(false);
    expect(settled).toEqual(['aborted', 'completed']);
  });
});

/* ---------------- P1-2 事件目录兑现批：user_input / turn_stopping（驱动半边） ---------------- */

describe('ConversationDriver user_input 批消费位变换（P1-2 增补 7②）', () => {
  it('run 入口路：transformInput 变换体进模型请求、原文本被替换（非追加）', async () => {
    const calls: LlmContext[] = [];
    const driver = new ConversationDriver({
      sessionId: 'transform-session',
      context: { messages: [], tools: [] },
      loopConfig: {
        streamFn: scriptedStream([okAssistant('答')], calls),
        model: 'test/model',
        convertToLlm: minimalConvert,
      },
      // 变换返回新引用 + 新文本（引用替换 + 内容替换双重路径同锁）
      transformInput: async (m) =>
        m.role === 'user' ? { ...m, content: '【已变换】' + String((m as { content: unknown }).content) } : m,
    });
    driver.submit('原始问题');
    await driver.settle();

    const userTexts = (calls[0]!.messages as Array<{ role: string; content: unknown }>)
      .filter((m) => m.role === 'user')
      .map((m) => String(m.content));
    expect(userTexts).toContain('【已变换】原始问题'); // 变换体进请求
    expect(userTexts).not.toContain('原始问题'); // 原文本不进（替换语义，非追加）
  });

  it('引用替换 → deliverMeta 迁移：退避期 wake 的工具收窄在续入批继续生效（修前必红）', async () => {
    const session = new Session();
    const calls: LlmContext[] = [];
    const driver = new ConversationDriver({
      sessionId: 'wake-rekey',
      context: { messages: [], tools: TOOLS },
      loopConfig: {
        streamFn: scriptedStream([errorAssistant('retryable-mark: x'), okAssistant('恢复')], calls),
        model: 'test/model',
        convertToLlm: minimalConvert,
      },
      durable: createDurableSinks(session),
      session,
      isTransientError: (m) => (m.errorMessage ?? '').includes('retryable-mark'),
      retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 50 },
      // 恒返回新引用（浅拷贝）：deliverMeta 键迁移路径的唯一形态——引用不变时
      // 原键天然有效，本用例锁的就是替换后 re-key
      transformInput: async (m) => ({ ...m }),
    });
    driver.submit('跑后台');
    await new Promise((resolve) => setTimeout(resolve, 10)); // 首跑失败落定、退避中
    driver.deliver(
      { role: 'user', content: '后台续命', timestamp: 2 },
      { backgroundWake: true, toolFilter: ['read_file'] },
    );
    await driver.settle();

    // 修前必红：transformBatch 无 re-key → deliverMeta.get(新引用) 缺失 → 收窄
    // 元数据丢失 → 续入批工具面回全量（本断言取到 TOOLS 五件即红）
    expect((calls[1]!.tools ?? []).map((t) => t.name)).toEqual(['read_file']);
  });

  it('失败语义（响亮不吞）：transformInput 抛错 → run 按失败收尾、错误进 errorMessage', async () => {
    const boom = new Error('user_input 变换炸了');
    const { driver } = makeRetryDriver([okAssistant('到不了的回答')], {
      transformInput: async () => {
        throw boom;
      },
    });
    const result = await driver.submitOnce('会失败的问题');

    expect(result?.status).toBe('failed'); // 钩子失败 = run 无法进行——上抛走 runTurns 统一 catch
    expect(result?.errorMessage).toContain('user_input 变换炸了');
  });
});

describe('ConversationDriver turn_stopping 派发（P1-2 增补 7①）', () => {
  it('runWithRetry 结算后恰好一次（S4 重试中间态不派发）+ sessionId/stopReason 透传', async () => {
    const payloads: Array<{ sessionId: string; stopReason: string }> = [];
    const { driver } = makeRetryDriver([errorAssistant('retryable-mark: x'), okAssistant('恢复')], {
      onTurnStopping: async (p) => {
        payloads.push({ ...p });
      },
    });
    driver.submit('你好');
    await driver.settle();

    // 首跑失败 + 重试成功 = 同一个 runWithRetry：结算后派发一次；中间 error
    // 态不派发（派发点在结算后不在每次模型调用后）
    expect(payloads).toEqual([{ sessionId: 'retry-session', stopReason: 'stop' }]);
  });

  it('失败语义（吞不拖死）：handler 抛错 → onCallbackError 携来源上报，run 结果不被改写', async () => {
    const seen: { err: unknown; source: string }[] = [];
    const boom = new Error('征询器坏了');
    const settled: string[] = [];
    const { driver } = makeRetryDriver([okAssistant('答')], {
      onTurnStopping: async () => {
        throw boom;
      },
      onCallbackError: (err, source) => seen.push({ err, source }),
    });
    driver.onRunSettled((s) => settled.push(s.status));
    driver.submit('你好');
    await driver.settle(); // 驱动侧吞：征询器故障不拖死 run 收尾

    expect(seen).toEqual([{ err: boom, source: 'turn_stopping' }]); // 诊断归因不静默
    expect(settled).toEqual(['completed']); // run 已结算——故障不改写历史结果
  });

  it('catch 合成终值路：runTurns 兜底 error 结算同样派发（stopReason=error 诚实可见）', async () => {
    const payloads: Array<{ sessionId: string; stopReason: string }> = [];
    const { driver } = makeRetryDriver([okAssistant('到不了的回答')], {
      // runTurns catch 触发器：批消费位变换上抛 → 合成 error 终值 → turn_stopping 照派
      transformInput: async () => {
        throw new Error('user_input 钩子上抛');
      },
      onTurnStopping: async (p) => {
        payloads.push({ ...p });
      },
    });
    driver.submit('你好');
    await driver.settle();

    expect(payloads).toEqual([{ sessionId: 'retry-session', stopReason: 'error' }]);
  });
});

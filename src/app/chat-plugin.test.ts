/**
 * L5 app — `builtin:chat` 对话应用件全栈测试（应用面第一纵切，2026-08-24）。
 *
 * mock 只停在模型层（scripted streamFn），其余全真：真装载（默认层首行 chat →
 * 件内会话选择/驱动构造/ctx.agent provide）、真驱动（launch/三通道路由/自激
 * 预算）、真 durable（user/message source 归因落账）。sendUserMessage 返回
 * void——路由结果经行为断言（模型请求上下文与会话日志），不增设测试专用回门。
 *
 * 纵切回归面：① 服务行为（自 agent-service.test 随迁——attach 退役后服务与
 * 驱动同件同生命周期）；② **可卸语义**：overlay 禁用 chat 行 = 首启无对话循环、
 * 宿主照启（goal 经 optionalInject 降级激活、命令面在）；③ Kahn 行序：默认
 * 装载下 goal（后行）结构性取得 ctx.agent；④ persist:false 诊断装配：件空转
 * 不炸启动断言（dump-config 面）。
 */

import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, LlmContext, StreamFn, StreamFnOptions, Usage } from '../contracts/llm.js';
import { AppError, AGENT_DELIVER_AS_UNSUPPORTED } from '../contracts/errors.js';
import { createBerryRuntime } from './assembly.js';
import type { BerryRuntime } from './assembly.js';
import type { AgentServiceFace, RunSettled } from './chat-plugin.js';

/* ---------------- 测试基建（与 subagent-plugin.test 同款） ---------------- */

/** 零用量 */
const NO_USAGE: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };

const textMessage = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  usage: NO_USAGE,
  stopReason: 'stop',
  timestamp: 1,
});

/** 合成流（start → done） */
function syntheticStream(message: AssistantMessage) {
  const events = [
    { type: 'start' as const, partial: { ...message, content: [] } },
    { type: 'done' as const, reason: 'stop' as const, message },
  ];
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: () =>
          index < events.length
            ? Promise.resolve({ value: events[index++]!, done: false as const })
            : Promise.resolve({ value: undefined, done: true as const }),
      };
    },
    result: async () => message,
  };
}

/** 脚本化 StreamFn（按调用序取响应，末条兜底；记录请求上下文） */
function scriptedStream(responses: AssistantMessage[]) {
  const contexts: LlmContext[] = [];
  const streamFn: StreamFn = (context: LlmContext, _options: StreamFnOptions) => {
    contexts.push(context);
    const message = responses[Math.min(contexts.length - 1, responses.length - 1)]!;
    return syntheticStream(message);
  };
  return { streamFn, contexts };
}

/** 临时目录（realpath 归一） */
const makeTempDir = (prefix: string): string => realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));

/** 本用例运行时登记（afterEach 统一关停防句柄泄漏） */
const runtimes: BerryRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop()!;
    await runtime.shutdown().catch(() => undefined);
  }
});

/** 装配 + 登记 + 取 agent 服务（件内 provide——默认层首行装载即就绪） */
async function assemble(overrides: Parameters<typeof createBerryRuntime>[0] = {}): Promise<{
  runtime: BerryRuntime;
  agent: AgentServiceFace;
}> {
  const runtime = await createBerryRuntime({
    dbPath: ':memory:',
    workspace: makeTempDir('app-chat-'),
    ...overrides,
  });
  runtimes.push(runtime);
  return { runtime, agent: runtime.ctx.get('agent') };
}

/** 自旋等待（微任务级——同步 scripted 流即触即达） */
async function spinUntil(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  expect.unreachable(`等待超时：${what}`);
}

/* ---------------- 用例：ctx.agent 服务行为（随迁面） ---------------- */

describe('ctx.agent 具名服务（件内构造，attach 退役）', () => {
  it('闲时注入：followUp 开轮 + source 归因落 durable user/message', async () => {
    const { streamFn, contexts } = scriptedStream([textMessage('收到')]);
    const { runtime, agent } = await assemble({ streamFn });
    agent.sendUserMessage('插件注入的一句话', { source: 'plugin:goal' });
    await spinUntil(() => contexts.length >= 1, 'followUp 开轮');
    await runtime.conversation!.settle();
    // 归因落账：user/message data 带 source（缺省不落字段——plugin:goal 必须显式在）
    const userEvents = runtime.session!.events.filter((e) => e.type === 'user/message');
    expect(userEvents).toHaveLength(1);
    expect((userEvents[0]!.data as { source?: string }).source).toBe('plugin:goal');
  });

  it('忙时注入（启动窗口）：插话折入首轮请求（loop 启动即查 steering——pi 蓝本等待期语义）', async () => {
    const { streamFn, contexts } = scriptedStream([textMessage('第一答'), textMessage('第二答')]);
    const { runtime, agent } = await assemble({ streamFn });
    // submitOnce 同步链的首悬点在 loop 启动查询处（§2.2「启动即查 steering」）——
    // 此刻注入必走 steer 入队，随即被启动查询捞出与开场同批折入
    const pending = runtime.conversation!.submitOnce('开场');
    agent.sendUserMessage('中途插话', { source: 'plugin:test' });
    await pending;
    await runtime.conversation!.settle();
    // 不开第二个模型调用：插话与开场同请求可见（等待期插话不打断当前生成）
    expect(contexts.length).toBe(1);
    const seen = contexts[0]!.messages.map((m) => (m.role === 'user' ? m.content : null));
    expect(seen).toContain('开场');
    expect(seen).toContain('中途插话');
  });

  it('忙时注入（生成中）：turn 边界续跑消费——次轮请求可见插话', async () => {
    const contexts: LlmContext[] = [];
    /** 首轮流放行闸（生成中窗口的确定性控制） */
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    const streamFn: StreamFn = (context: LlmContext) => {
      call += 1;
      contexts.push(context);
      const message = textMessage(call === 1 ? '第一答' : '第二答');
      if (call > 1) return syntheticStream(message);
      // 首轮：门控异步生成器——迭代前先等闸，制造「模型生成中」窗口
      const events = [
        { type: 'start' as const, partial: { ...message, content: [] } },
        { type: 'done' as const, reason: 'stop' as const, message },
      ];
      return {
        async *[Symbol.asyncIterator]() {
          await gate;
          for (const event of events) yield event;
        },
        result: async () => {
          await gate;
          return message;
        },
      };
    };
    const { runtime, agent } = await assemble({ streamFn });
    const pending = runtime.conversation!.submitOnce('开场');
    // 首轮请求确已开跑（闸未放行——生成中）再注入：steer 入队，落点只能是
    // 首轮后的 turn 边界查询（loop §2.2 内层循环尾）
    for (let i = 0; i < 200 && contexts.length < 1; i += 1) await Promise.resolve();
    expect(contexts.length).toBe(1);
    agent.sendUserMessage('中途插话', { source: 'plugin:test' });
    release();
    await pending;
    await runtime.conversation!.settle();
    // 两次模型调用：首轮独立 + 边界续跑轮（消费插话）
    expect(contexts.length).toBe(2);
    expect(contexts[1]!.messages.some((m) => m.role === 'user' && m.content === '中途插话')).toBe(true);
  });

  it('onRunSettled：每 run 终结派发一次 status；订阅者违约被隔离不炸结算链', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const { runtime, agent } = await assemble({ streamFn });
    const settled: RunSettled[] = [];
    void settled;
    agent.onRunSettled(() => {
      throw new Error('订阅者违约');
    });
    const second: RunSettled[] = [];
    const unwatch = agent.onRunSettled((s) => second.push(s));
    const result = await runtime.conversation!.submitOnce('问');
    expect(result?.status).toBe('completed');
    // 违约订阅者不炸链：第二个订阅者照常收到 completed
    expect(second.map((s) => s.status)).toEqual(['completed']);
    unwatch();
    // 注销后不再派发
    await runtime.conversation!.submitOnce('再问');
    expect(second).toHaveLength(1);
  });

  it('自激预算：backgroundWake 连续唤醒第 4 次降级 inject（不开新 run）', async () => {
    const { streamFn, contexts } = scriptedStream([textMessage('答')]);
    const { runtime, agent } = await assemble({ streamFn });
    for (let i = 1; i <= 4; i += 1) {
      agent.sendUserMessage(`自激 ${i} 号`, { source: 'plugin:goal', backgroundWake: true });
      await runtime.conversation!.settle();
    }
    // 前 3 次各开一 run（3 次模型调用），第 4 次超帽 inject 只落日志
    expect(contexts.length).toBe(3);
    // 4 条注入全落账（第 4 条 inject 也过 durable——审计不断流）
    expect(runtime.session!.events.filter((e) => e.type === 'user/message')).toHaveLength(4);
  });

  it('deliverAs 预留位执法：显式携带即 AGENT_DELIVER_AS_UNSUPPORTED', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const { agent } = await assemble({ streamFn });
    expect(() => agent.sendUserMessage('x', { deliverAs: 'steer' })).toThrowError(AppError);
    try {
      agent.sendUserMessage('x', { deliverAs: 'inject' });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as AppError).code).toBe(AGENT_DELIVER_AS_UNSUPPORTED);
    }
  });
});

/* ---------------- 用例：纵切回归面 ---------------- */

describe('应用面第一纵切（可卸语义 + 行序 + 空转）', () => {
  it('默认装载：件构造驱动并 provide agent——goal（后行）结构性取得（Kahn 行序）', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const { runtime, agent } = await assemble({ streamFn });
    // 驱动就绪（件装载即构造——组合根只持活句柄）
    expect(runtime.conversation).toBeDefined();
    // goal 件经 optionalInject 'agent' 结构性取得同一面（chat 首行先装 → 后行可见）
    expect(runtime.ctx.get<AgentServiceFace>('agent')).toBe(agent);
    // 件行状态：默认层首行 activated
    const chatRow = runtime.plugins.list().find((row) => row.id === 'chat');
    expect(chatRow?.status).toBe('activated');
  });

  it('overlay 禁用 chat 行：首启无对话循环、宿主照启（goal 降级激活、命令面在）', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const compositionDir = makeTempDir('app-chat-off-');
    writeFileSync(join(compositionDir, 'overlay.yaml'), 'rows:\n  - id: chat\n    disabled: true\n');
    const runtime = await createBerryRuntime({
      dbPath: ':memory:',
      workspace: makeTempDir('app-chat-off-ws-'),
      compositionDir,
      streamFn,
    });
    runtimes.push(runtime);
    // 无对话循环：驱动/会话皆缺（对话是应用——卸掉它只剩宿主）
    expect(runtime.conversation).toBeUndefined();
    expect(runtime.session).toBeUndefined();
    // 宿主照启：装载零失败行（启动断言不响）
    expect(runtime.plugins.list().filter((row) => row.status === 'failed')).toHaveLength(0);
    const chatRow = runtime.plugins.list().find((row) => row.id === 'chat');
    expect(chatRow?.status).toBe('skipped');
    // goal 行经 optionalInject 降级激活（agent 缺供不阻 Kahn——warn 止步日志）
    const goalRow = runtime.plugins.list().find((row) => row.id === 'goal');
    expect(goalRow?.status).toBe('activated');
    expect(runtime.ctx.tryGet('agent')).toBeUndefined();
    // 命令面在（/plugins /reload 等宿主壳命令已注册）
    expect(runtime.channels.commands.lookup('plugins')).toBeDefined();
  });

  it('persist:false 诊断装配：件空转不炸启动断言（dump-config 面）', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const runtime = await createBerryRuntime({
      persist: false,
      workspace: makeTempDir('app-chat-nodb-'),
      streamFn,
    });
    runtimes.push(runtime);
    // 件自降级空转：不建会话、不起驱动、不供 agent
    expect(runtime.conversation).toBeUndefined();
    expect(runtime.session).toBeUndefined();
    expect(runtime.ctx.tryGet('agent')).toBeUndefined();
    // 装载面完好：chat 行 activated（空转也是成功装载——诊断树不断链）
    const chatRow = runtime.plugins.list().find((row) => row.id === 'chat');
    expect(chatRow?.status).toBe('activated');
    expect(runtime.plugins.list().filter((row) => row.status === 'failed')).toHaveLength(0);
  });
});

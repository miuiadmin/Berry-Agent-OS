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
import {
  AppError,
  AGENT_DELIVER_AS_UNSUPPORTED,
  AGENT_SESSION_INACTIVE,
  AGENT_SESSION_KEY_REQUIRED,
} from '../contracts/errors.js';
import { createBerryRuntime } from './assembly.js';
import type { BerryRuntime } from './assembly.js';
import type { AgentServiceFace, RunSettled } from '../chat/index.js';

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

  it('自激预算：backgroundWake 连续唤醒第 4 次降级 inject（不开新 run；缺显式键即 AGENT_SESSION_KEY_REQUIRED）', async () => {
    const { streamFn, contexts } = scriptedStream([textMessage('答')]);
    const { runtime, agent } = await assemble({ streamFn });
    // S1 执法：backgroundWake 不依赖调用链语境——缺显式键即拒（三级解析序不适用于无人值守路）
    try {
      agent.sendUserMessage('无键唤醒', { source: 'plugin:goal', backgroundWake: true });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as AppError).code).toBe(AGENT_SESSION_KEY_REQUIRED);
    }
    const sessionId = runtime.session!.header.sessionId;
    for (let i = 1; i <= 4; i += 1) {
      agent.sendUserMessage(`自激 ${i} 号`, { source: 'plugin:goal', backgroundWake: true, session: sessionId });
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

/* ---------------- 用例：S1 多驱动注册表（durable 键控总根因刀验收） ---------------- */

describe('S1 多驱动注册表（registry/front 键控路由）', () => {
  it('open 第二驱动：双会话并存各归各——事件/账/seq 互不串，open 即切前台聚焦', async () => {
    const { streamFn, contexts } = scriptedStream([textMessage('答甲'), textMessage('答乙')]);
    const { runtime } = await assemble({ streamFn });
    const registry = runtime.drivers;
    const first = registry.focused()!;
    expect(first).toBeDefined();
    const second = registry.open()!;
    expect(second).not.toBe(first);
    expect(registry.entries.size).toBe(2);
    // open 即切前台聚焦（新会话拿走输入与展示）
    expect(registry.focus.sessionId).toBe(second.session.header.sessionId);
    expect(runtime.session!.header.sessionId).toBe(second.session.header.sessionId);

    // 双驱动先后各跑一 run（旧驱动引用仍活——多会话并存不是换防）
    await first.driver.submitOnce('问甲');
    await second.driver.submitOnce('问乙');
    expect(contexts.length).toBe(2);
    // 各归各：user/assistant/llm/usage 落各自会话（调用链路由不串账）
    for (const entry of [first, second]) {
      const types = entry.session.events.map((e) => e.type);
      expect(types).toContain('user/message');
      expect(types).toContain('assistant/message');
      expect(types).toContain('llm/usage');
      // seq 连续：0..n 无撞号（会话事件日志单写者不变式——S1 的存在理由）
      expect(entry.session.events.map((e) => e.seq)).toEqual(entry.session.events.map((_, i) => i));
    }
    // 互不串：first 会话不含乙的问句、second 会话不含甲的问句
    expect(JSON.stringify(first.session.events)).not.toContain('问乙');
    expect(JSON.stringify(second.session.events)).not.toContain('问甲');
  });

  it('/new 语义（open + retire）：退役条目保留——显式键 INACTIVE、投递降 inject、quit 不 resolve', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const { runtime, agent } = await assemble({ streamFn });
    const registry = runtime.drivers;
    const previous = registry.focused()!;
    const previousId = previous.session.header.sessionId;
    const opened = registry.open()!;
    expect(registry.retire(previousId)).toBe(true);

    // 条目保留（durable 会话不删——防 seq 撞号），retire 幂等（再退 false）
    expect(registry.entries.size).toBe(2);
    expect(registry.retire(previousId)).toBe(false);
    // 显式键投递退役会话：AGENT_SESSION_INACTIVE（「退役即停摆」——调用方按码容错）
    try {
      agent.sendUserMessage('迟到唤醒', { backgroundWake: true, session: previousId });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as AppError).code).toBe(AGENT_SESSION_INACTIVE);
    }
    // 驱动层直投：降 inject（只落日志保审计不开 run）
    const channel = previous.driver.deliver({ role: 'user', content: '迟到投递', timestamp: 1 });
    expect(channel).toBe('inject');
    expect(previous.session.events.filter((e) => e.type === 'user/message')).toHaveLength(1);
    // 退役 ≠ 退出：quit promise 不 resolve（防 /new 误触发 TUI 退出），前台转接新驱动
    let quitResolved = false;
    void previous.driver.quit.then(() => {
      quitResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(quitResolved).toBe(false);
    expect(runtime.conversation).toBe(opened.driver);
  });

  it('open 幂等防御：resume 已在表会话返回同条目（不建第二 Session 双写者）', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const { runtime } = await assemble({ streamFn });
    const registry = runtime.drivers;
    const first = registry.focused()!;
    const second = registry.open()!;
    // 聚焦已切走，显式 resume 首会话：同条目返回 + 聚焦切回，不新建
    const again = registry.open({ resume: first.session.header.sessionId })!;
    expect(again).toBe(first);
    expect(registry.entries.size).toBe(2);
    expect(registry.focus.sessionId).toBe(first.session.header.sessionId);
    expect(runtime.conversation).toBe(first.driver);
    void second;
  });

  it('front 转接：addDisplay 先于 open 注册——新驱动事件可达、submit 路由前台聚焦', async () => {
    const { streamFn } = scriptedStream([textMessage('答一'), textMessage('答二')]);
    const { runtime } = await assemble({ streamFn });
    const front = runtime.front;
    const seen: string[] = [];
    // S3 信封化：front 展示消费者收 {sessionId, event} 信封（转接层补本会话键）
    front.addDisplay((envelope) => {
      seen.push(envelope.event.type);
    });
    const first = runtime.drivers.focused()!;

    // 前台聚焦首驱动：front.submit 路由到位 + 事件经转接表回流
    front.submit('问一');
    await first.driver.settle();
    expect(seen).toContain('message_end');
    expect(first.session.events.filter((e) => e.type === 'user/message').map((e) => e.data)).toHaveLength(1);

    // open 新驱动：同一 display 消费者自动转接（TUI 零重接不断流），submit 随聚焦走
    seen.length = 0;
    const second = runtime.drivers.open()!;
    front.submit('问二');
    await second.driver.settle();
    expect(seen).toContain('message_end');
    expect(second.session.events.filter((e) => e.type === 'user/message')).toHaveLength(1);
    expect(first.session.events.filter((e) => e.type === 'user/message')).toHaveLength(1);
  });
});

/* ---------------- 用例：S3 前台切换与退出扇出（契约篇 §5.4 S3 射面） ---------------- */

/** 挂起流（start 后挂起直到 release/abort——run 中切换与退出扇出的在飞形态） */
function pendingStream() {
  let release!: () => void;
  /** 完成门闩（显式 release 才放行 done） */
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const message = textMessage('慢答');
  // signal 是第三个位置参数（contracts/llm.ts StreamFn 签名），不在 options 里
  const streamFn: StreamFn = (_context: LlmContext, _options: StreamFnOptions, signal?: AbortSignal) => ({
    [Symbol.asyncIterator]() {
      let index = 0;
      const events = [{ type: 'start' as const, partial: { ...message, content: [] } }];
      return {
        next: async () => {
          if (index < events.length) return { value: events[index++]!, done: false as const };
          // 挂起直到显式 release 或 abort（abort → error 终止事件编码 aborted——
          // 对齐 pi StreamFn「永不抛错、abort 编码进流内 error 事件」契约；真
          // provider 同语义）。已 abort 的 signal 事件只发一次、事后挂监听收不到
          // ——先短路再进 race。
          if (signal?.aborted) {
            return {
              value: {
                type: 'error' as const,
                reason: 'aborted' as const,
                error: { ...message, stopReason: 'aborted' },
              },
              done: false as const,
            };
          }
          await Promise.race([
            gate,
            ...(signal !== undefined
              ? [
                  new Promise<never>((_, reject) =>
                    signal.addEventListener('abort', () => reject(new Error('aborted'))),
                  ),
                ]
              : []),
          ]).catch(() => undefined);
          if (signal?.aborted) {
            // race 后再核一次（事件触发的 abort 也在这一侧收口——统一 error 终止形）
            return {
              value: {
                type: 'error' as const,
                reason: 'aborted' as const,
                error: { ...message, stopReason: 'aborted' },
              },
              done: false as const,
            };
          }
          return { value: { type: 'done' as const, reason: 'stop', message }, done: false as const };
        },
      };
    },
    result: async () => message,
  });
  return { streamFn, release };
}

describe('S3 前台切换程序面（switchTo / onFocusChange 三写点 / 同值零通知）', () => {
  it('三写点各通知恰一次、同值写零通知；退役/查无 false', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const { runtime } = await assemble({ streamFn });
    const registry = runtime.drivers;
    const first = registry.focused()!;
    const aId = first.session.header.sessionId;
    const notifications: string[] = [];
    const dispose = registry.onFocusChange((id) => notifications.push(id));

    // 同值写零通知（switchTo 到已聚焦会话 = 无变化，防无谓清屏重画）
    expect(registry.switchTo(aId)).toBe(true);
    expect(notifications).toHaveLength(0);

    // 写点一：open 新开
    const second = registry.open()!;
    const bId = second.session.header.sessionId;
    expect(notifications).toEqual([bId]);

    // 写点三：switchTo 活条目即切
    expect(registry.switchTo(aId)).toBe(true);
    expect(notifications).toEqual([bId, aId]);

    // 写点二：open 幂等命中既有条目（同 id 再 open 也切 focus，也是写点）
    const again = registry.open({ resume: bId });
    expect(again).toBe(second);
    expect(notifications).toEqual([bId, aId, bId]);

    // 退役/查无 false（switchTo 守同一活条目判据——/app 清单只列活条目）
    expect(registry.switchTo('查无的会话键')).toBe(false);
    registry.retire(aId);
    expect(registry.switchTo(aId)).toBe(false);
    dispose();
  });
});

describe('S3 信封转接（双驱动事件各带归属键——互不绞屏的数据前提）', () => {
  it('双驱动先后 run：事件信封 sessionId 各归各、无键漂移', async () => {
    const { streamFn } = scriptedStream([textMessage('答甲'), textMessage('答乙')]);
    const { runtime } = await assemble({ streamFn });
    const front = runtime.front;
    const envelopes: { sessionId: string; type: string }[] = [];
    front.addDisplay((envelope) => envelopes.push({ sessionId: envelope.sessionId, type: envelope.event.type }));
    const first = runtime.drivers.focused()!;
    const aId = first.session.header.sessionId;

    // A（聚焦）先跑一轮：事件即时转接路（信封带 A 键）
    front.submit('问甲');
    await first.driver.settle();
    const second = runtime.drivers.open()!; // focus 切 B（open 语义含聚焦）
    const bId = second.session.header.sessionId;
    front.submit('问乙');
    await second.driver.settle();

    // B 跑时 A 的迟到事件也照达（后台信封仍带 A 键——审计面）；此处 B 在跑，
    // A 已结算完——直接断言两路键各归各
    const aTypes = envelopes.filter((e) => e.sessionId === aId).map((e) => e.type);
    const bTypes = envelopes.filter((e) => e.sessionId === bId).map((e) => e.type);
    expect(aTypes).toContain('message_end'); // A 的 run 事件经即时转接路（带 A 键）
    expect(bTypes).toContain('message_end'); // B 的 run 事件经 open 全量转接路（带 B 键）
    // 无键漂移：全部信封键 ∈ {A, B}（转接闭包捕获各驱动自己的会话键）
    expect(envelopes.every((e) => e.sessionId === aId || e.sessionId === bId)).toBe(true);
  });

  it('非聚焦者事件照达（切走后旧会话 run 在飞——后台事件仍带本会话键）', async () => {
    const { streamFn, release } = pendingStream();
    const { runtime } = await assemble({ streamFn });
    const front = runtime.front;
    const envelopes: { sessionId: string; type: string }[] = [];
    front.addDisplay((envelope) => envelopes.push({ sessionId: envelope.sessionId, type: envelope.event.type }));
    const first = runtime.drivers.focused()!;
    const aId = first.session.header.sessionId;

    // A 开跑（挂起流——run 在飞中）
    front.submit('慢问');
    await spinUntil(() => first.driver.isRunning, 'A 在飞');
    // 开 B（A 变非聚焦——open 不退役、A 的 run 照跑）
    const second = runtime.drivers.open()!;
    const bId = second.session.header.sessionId;
    expect(front.focus.sessionId).toBe(bId); // open 语义含聚焦
    release(); // 放行 A 的流终值
    await first.driver.settle();

    // A 的事件在非聚焦态照达（信封带 A 键——TUI 侧据此落摘要行/切入重画）
    const aTypes = envelopes.filter((e) => e.sessionId === aId).map((e) => e.type);
    expect(aTypes).toContain('agent_end'); // 迟到结算照达（审计面）
    expect(aTypes).toContain('message_end');
    expect(envelopes.every((e) => e.sessionId === aId || e.sessionId === bId)).toBe(true);
    void second;
  });
});

describe('S3 退出扇出（requestQuit 从聚焦单路扩为全部活驱动 abort）', () => {
  it('双活驱动同时在飞 quit：全部被 abort、settle 必达不挂死', async () => {
    const { streamFn, release } = pendingStream();
    const { runtime, agent } = await assemble({ streamFn });
    const registry = runtime.drivers;
    const a = registry.focused()!;
    const b = registry.open()!; // focus=B；A 驻留后台

    // 双驱动同时在飞：B 经前台聚焦 submit、A 经显式键后台投递（多驱动并行的本义场景）
    front_submit: {
      runtime.front.submit('问 B');
      await spinUntil(() => b.driver.isRunning, 'B 在飞');
      agent.sendUserMessage('问 A', { session: a.session.header.sessionId });
      await spinUntil(() => a.driver.isRunning, 'A 在飞');
    }
    // 优雅退出：聚焦者 B 走 requestQuit 全语义 + A 直接 abort（扇出）
    runtime.front.requestQuit();
    await runtime.front.settle(); // 扇出后必达——不挂死等后台 run 自然跑完
    expect(a.driver.isRunning).toBe(false);
    expect(b.driver.isRunning).toBe(false);
    void release; // gate 已无消费者（abort 路已短路）——防御位不调
  });
});

describe('S5 审批守门归属（fresh 作用域三件 + answerer 标签 + bash 域注册）', () => {
  /** 带升权参数的 bash toolCall（read-only 档下触发审批 ask） */
  const bashEscalation = (justification: string): AssistantMessage => ({
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id: `call-bash-${justification}`,
        name: 'bash',
        arguments: { command: 'pwd', sandbox_permissions: 'workspace-write', justification },
      },
    ],
    usage: NO_USAGE,
    stopReason: 'toolUse',
    timestamp: 1,
  });

  it('双驱动 bash 升权各落各账：answerer 弹窗带 [chat·短id] 标签、approval 对落各自会话（F1+F2+迁域三合一）', async () => {
    // 脚本序：[0] A turn1（bash 升权）→ [1] A turn2（收尾）→ [2] B turn1 → [3] B turn2
    const { streamFn } = scriptedStream([
      bashEscalation('A 的升权理由'),
      textMessage('A 收尾'),
      bashEscalation('B 的升权理由'),
      textMessage('B 收尾'),
    ]);
    const { runtime } = await assemble({
      streamFn,
      approvalPolicy: 'ask',
      sandboxMode: 'read-only',
      interactive: true, // deps.confirm 注入开关（fresh 作用域 answerer 的接线前提——F1）
    });
    // 假交互通道：记录 confirm 弹窗文本、恒拒绝（拒绝路 = 不真跑 bash，纯审批面）
    const prompts: string[] = [];
    runtime.ui.attach({
      id: 'test-confirm',
      notify: () => {},
      setStatus: () => {},
      confirm: async (message) => {
        prompts.push(message);
        return false;
      },
    });

    const registry = runtime.drivers;
    const a = registry.focused()!;
    const aId = a.session.header.sessionId;
    await a.driver.submitOnce('跑 A');
    expect(prompts).toHaveLength(1); // answerer 真接线（修复前 fresh 作用域无 answerer →
    // ask = unavailable，confirm 零调用，工具结果为 unavailable 文案——本断言必红）
    // 弹窗标签：[chat·A 短id] + #approvalId 短形 + summary + 理由 + 批准问句
    expect(prompts[0]).toContain(`[chat·${aId.slice(0, 8)}]`);
    expect(prompts[0]).toMatch(/#[0-9a-f]{4}/);
    expect(prompts[0]).toContain('沙箱升权 read-only → workspace-write');
    expect(prompts[0]).toContain('A 的升权理由');
    expect(prompts[0]).toContain('批准？');
    // A 账：审批对（asked + decided(reject)）落 A 会话 durable
    const aTypes = a.session.events.map((e) => e.type);
    expect(aTypes).toContain('approval/asked');
    expect(aTypes).toContain('approval/decided');
    const aDecided = a.session.events.find((e) => e.type === 'approval/decided')!;
    expect((aDecided.data as { decision: string }).decision).toBe('reject');
    // 拒绝传导：工具结果 isError + 拒绝文案（升权被拒路径不走沙箱真执行）
    const aTool = JSON.stringify(a.session.events);
    expect(aTool).toContain('升权审批被拒');

    // 开 B 驱动：同款 bash 升权——标签换 B 短id、审批对落 B 账（各归各不串台）
    const b = registry.open()!;
    const bId = b.session.header.sessionId;
    await b.driver.submitOnce('跑 B');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(`[chat·${bId.slice(0, 8)}]`);
    expect(prompts[1]).toContain('B 的升权理由');
    expect(prompts[1]).not.toContain(`[chat·${aId.slice(0, 8)}]`);
    const bTypes = b.session.events.map((e) => e.type);
    expect(bTypes).toContain('approval/asked');
    expect(bTypes).toContain('approval/decided');
    // 互不串：A 账无 B 的理由、B 账无 A 的理由
    expect(JSON.stringify(a.session.events)).not.toContain('B 的升权理由');
    expect(JSON.stringify(b.session.events)).not.toContain('A 的升权理由');
    // bash 域注册面：两驱动可见面各含 bash（S5 迁域后域层随驱动落）
    expect(runtime.tools.listFor(aId).map((d) => d.name)).toContain('bash');
    expect(runtime.tools.listFor(bId).map((d) => d.name)).toContain('bash');
    // 全局层退役：裸 list() 无 bash（诊断口径——无驱动语境面）
    expect(runtime.tools.list().map((d) => d.name)).not.toContain('bash');
  });
});

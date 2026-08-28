/**
 * L5 app — goal 官方件全栈测试（纵切二：默认第三行 + 工具三件 + /goal 命令 +
 * 续跑触发 + 预算刹车 + 续接降级）。
 *
 * mock 只停在模型层（scripted streamFn），其余全真：真装配（默认层 goal 行 +
 * builtins 注册表 + 装载收口 session_start 补播）、真工具管道（toAgentTool 三段——schema
 * 执法位即在此面验证）、真 goals 表（真库文件跨进程重开）、真驱动（结算通知
 * 三通道路由）。工具调用一律走 toAgentTool——直接 execute 会绕过 schema 校验
 * 段，那是本纵切要锁的执法面。
 */

import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, LlmContext, StreamFn, StreamFnOptions, Usage } from '../contracts/llm.js';
import {
  AppError,
  GOAL_ACTIVE_EXISTS,
  GOAL_NOT_FOUND,
  GOAL_TRANSITION_INVALID,
  TOOL_ARGUMENTS_INVALID,
} from '../contracts/errors.js';
import type { UiBackend } from '../channels/types.js';
import { createBerryRuntime } from './assembly.js';
import type { BerryRuntime } from './assembly.js';

/* ---------------- 测试基建（与 agent-service.test 同款） ---------------- */

/** 零用量（totalTokens 2——goal 记账每轮 +2，远够不着预算帽） */
const NO_USAGE: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };

/** 指定总用量的文本终值（预算刹车用例——usage 即 durable assistant/message 载荷） */
function usageMessage(text: string, totalTokens: number): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { ...NO_USAGE, totalTokens },
    stopReason: 'stop',
    timestamp: 1,
  };
}

const textMessage = (text: string): AssistantMessage => usageMessage(text, 2);

/** 工具调用 assistant 终值（stopReason=toolUse） */
const toolCallMessage = (name: string, args: Record<string, unknown>): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id: `call-${name}`, name, arguments: args }],
  usage: NO_USAGE,
  stopReason: 'toolUse',
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

/** 通知录制后端（/goal 命令回执捕获） */
function recordingBackend() {
  const notifies: string[] = [];
  const backend: UiBackend = {
    id: 'rec',
    notify: (text) => notifies.push(text),
    setStatus: () => {},
    confirm: async () => true,
  };
  return { backend, notifies };
}

/** 本用例运行时登记（afterEach 统一关停防句柄泄漏） */
const runtimes: BerryRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop()!;
    await runtime.shutdown().catch(() => undefined);
  }
});

/** 装配 + 登记 */
async function assemble(overrides: Parameters<typeof createBerryRuntime>[0] = {}): Promise<BerryRuntime> {
  const runtime = await createBerryRuntime({ dbPath: ':memory:', workspace: makeTempDir('app-goal-'), ...overrides });
  runtimes.push(runtime);
  return runtime;
}

/** 经真工具管道调用（三段全走——schema 执法位在此面） */
function callTool(runtime: BerryRuntime, name: string, args: Record<string, unknown>) {
  const def = runtime.tools.get(name);
  if (def === undefined) throw new Error(`工具未注册：${name}`);
  return runtime.tools.toAgentTool(def).execute('tc-goal', args);
}

/** goal_get 投影文本（状态断言用——全字段如实示态） */
async function goalText(runtime: BerryRuntime): Promise<string> {
  const result = await callTool(runtime, 'goal_get', {});
  return (result.content[0] as { type: 'text'; text: string }).text;
}

/** 自旋等待（微任务级——同步 scripted 流即触即达） */
async function spinUntil(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  expect.unreachable(`等待超时：${what}`);
}

/** LlmContext 消息里的 user 文本（注入提示词断言面） */
function userTexts(context: LlmContext): string[] {
  return context.messages
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
}

/* ---------------- 用例 ---------------- */

describe('goal 官方件全栈：工具三件 + schema 执法', () => {
  it('默认层第三行激活 + 工具三件进面（goal_get/goal_set/goal_update）', async () => {
    const runtime = await assemble({ streamFn: scriptedStream([textMessage('答')]).streamFn });
    expect(runtime.appsService.list().map((r) => [r.id, r.status])).toContainEqual(['goal', 'activated']);
    expect(runtime.tools.list().map((t) => t.name)).toEqual(
      expect.arrayContaining(['goal_get', 'goal_set', 'goal_update']),
    );
  });

  it('goal_set → goal_get：设定激活 + 全字段投影；active 占位再设即拒（GOAL_ACTIVE_EXISTS）', async () => {
    const runtime = await assemble({ streamFn: scriptedStream([textMessage('答')]).streamFn });
    const set = await callTool(runtime, 'goal_set', { objective: '把 goal 纵切测试写完', tokenBudget: 50000 });
    expect((set.content[0] as { text: string }).text).toContain('目标已设定并激活');
    const text = await goalText(runtime);
    expect(text).toContain('状态：active');
    expect(text).toContain('把 goal 纵切测试写完');
    expect(text).toContain('50000 tokens');

    // active 行占位：再设即响亮拒绝（机器面不靠提示词自觉）
    const err = await callTool(runtime, 'goal_set', { objective: '第二个目标', tokenBudget: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(GOAL_ACTIVE_EXISTS);
  });

  it('goal_update union schema 执法位：completed 缺 evidence / blocked 缺 note 过不了参数校验段', async () => {
    const runtime = await assemble({ streamFn: scriptedStream([textMessage('答')]).streamFn });
    await callTool(runtime, 'goal_set', { objective: '目标', tokenBudget: 50000 });

    const noEvidence = await callTool(runtime, 'goal_update', { status: 'completed' }).catch((e) => e);
    expect((noEvidence as AppError).code).toBe(TOOL_ARGUMENTS_INVALID);
    const noNote = await callTool(runtime, 'goal_update', { status: 'blocked' }).catch((e) => e);
    expect((noNote as AppError).code).toBe(TOOL_ARGUMENTS_INVALID);
    // 状态依然是 active（非法申报不落库）
    expect(await goalText(runtime)).toContain('状态：active');
  });

  it('goal_update 状态机执法：无目标 GOAL_NOT_FOUND / 非 active GOAL_TRANSITION_INVALID', async () => {
    const runtime = await assemble({ streamFn: scriptedStream([textMessage('答')]).streamFn });
    const noGoal = await callTool(runtime, 'goal_update', { status: 'completed', evidence: '证据' }).catch((e) => e);
    expect((noGoal as AppError).code).toBe(GOAL_NOT_FOUND);

    await callTool(runtime, 'goal_set', { objective: '目标', tokenBudget: 50000 });
    // 手工降级出 needs-resume 形态（boot 降级另有全栈用例——此处只锁工具执法）
    await callTool(runtime, 'goal_update', { status: 'blocked', note: '阻塞原因' });
    const notActive = await callTool(runtime, 'goal_update', { status: 'completed', evidence: '证据' }).catch((e) => e);
    expect((notActive as AppError).code).toBe(GOAL_TRANSITION_INVALID);
  });

  it('goal_set 覆盖终态行重设：新目标新账本（旧证据不残留）', async () => {
    const runtime = await assemble({ streamFn: scriptedStream([textMessage('答')]).streamFn });
    await callTool(runtime, 'goal_set', { objective: '旧目标', tokenBudget: 50000 });
    await callTool(runtime, 'goal_update', { status: 'completed', evidence: '旧目标完成证据' });
    const set = await callTool(runtime, 'goal_set', { objective: '新目标', tokenBudget: 80000 });
    expect((set.content[0] as { text: string }).text).toContain('已覆盖旧目标');
    const text = await goalText(runtime);
    expect(text).toContain('状态：active');
    expect(text).toContain('新目标');
    expect(text).not.toContain('旧目标完成证据'); // 旧证据不残留
  });
});

describe('goal 续跑全栈：结算边界注入 → 模型申报完成 → 链自然停', () => {
  it('completed 结算 + active + 预算未尽 → 注入续跑提示（含纪律四件）；申报完成后不再续', async () => {
    // 脚本消费序：contexts[0]=用户首轮 → 续跑注入 contexts[1]（模型调 goal_update）
    // → 工具结果 contexts[2]（收口答）→ 结算时已 completed，链停
    const { streamFn, contexts } = scriptedStream([
      textMessage('首轮答'),
      toolCallMessage('goal_update', { status: 'completed', evidence: '逐需求证据齐备（测试脚本申报）' }),
      textMessage('收口答'),
    ]);
    const runtime = await assemble({ streamFn });
    await callTool(runtime, 'goal_set', { objective: '写完 goal 全栈测试', tokenBudget: 100000 });

    await runtime.conversation!.submitOnce('开始');
    // 续跑是结算后的闲时唤醒（异步于 submitOnce 决议）——自旋等第二个请求出现
    await spinUntil(() => contexts.length >= 2, '续跑注入开轮');
    await runtime.conversation!.settle();

    // 注入内容：续跑提示词携带目标原文 + 纪律四件（反缩水/完成审计/阻塞三轮/预算尽≠完成）
    const injected = userTexts(contexts[1]!).join('\n');
    expect(injected).toContain('goal 续跑');
    expect(injected).toContain('写完 goal 全栈测试');
    expect(injected).toContain('反缩水');
    expect(injected).toContain('预算尽');
    // 第二十四批题3a：续跑轮（纯 backgroundWake 批）工具面收窄——结算件
    // （goal_get/goal_update）在场，goal_set 与写面工具收走，收窄批 ⊆ 全量批
    const fullNames = (contexts[0]!.tools ?? []).map((t) => t.name);
    const wakeNames = (contexts[1]!.tools ?? []).map((t) => t.name);
    expect(wakeNames).toContain('goal_update');
    expect(wakeNames).toContain('goal_get');
    expect(wakeNames).not.toContain('goal_set');
    if (fullNames.includes('bash')) expect(wakeNames).not.toContain('bash');
    for (const name of wakeNames) expect(fullNames).toContain(name);
    // 申报已落库：completed + 证据；链停在 3 个请求（不再续跑）
    const text = await goalText(runtime);
    expect(text).toContain('状态：completed');
    expect(text).toContain('逐需求证据齐备');
    expect(contexts).toHaveLength(3);
  });

  it('needsWrite 开洞：goal_set 申报后续跑轮不收窄（全量工具面含 goal_set）', async () => {
    const { streamFn, contexts } = scriptedStream([
      textMessage('首轮答'),
      toolCallMessage('goal_update', { status: 'completed', evidence: '写面目标收口（测试脚本申报）' }),
      textMessage('收口答'),
    ]);
    const runtime = await assemble({ streamFn });
    await callTool(runtime, 'goal_set', {
      objective: '需要写文件的长目标',
      tokenBudget: 100000,
      needsWrite: true,
    });

    await runtime.conversation!.submitOnce('开始');
    await spinUntil(() => contexts.length >= 2, '续跑注入开轮');
    await runtime.conversation!.settle();

    // 开洞：续跑轮全量工具面（含 goal_set——未收窄）+ /goal 面如实示态
    const wakeNames = (contexts[1]!.tools ?? []).map((t) => t.name);
    expect(wakeNames).toContain('goal_set');
    expect(wakeNames).toContain('goal_update');
    const text = await goalText(runtime);
    expect(text).toContain('已申报写面开洞');
    expect(text).toContain('状态：completed');
    expect(contexts).toHaveLength(3);
  });

  it('needs-resume / stopped / 预算尽：结算后均不注入（续跑三条件缺一即停）', async () => {
    const { streamFn, contexts } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ streamFn });
    await callTool(runtime, 'goal_set', { objective: '目标', tokenBudget: 1000 });
    // 预算尽形态：tokenBudget 1000、首答 usage 1500 → 刹停发生在结算前（见刹车用例）
    // 此处直接人工停：stopped 行结算后不续
    await callTool(runtime, 'goal_update', { status: 'blocked', note: '阻塞' });
    await runtime.conversation!.submitOnce('问题');
    await runtime.conversation!.settle();
    expect(contexts).toHaveLength(1); // 无续跑注入
  });
});

describe('goal 预算刹车全栈：usage 累计 ≥ 帽 → 刹停 + 当轮收尾注入', () => {
  it('assistant/message usage 记账 → 刹停 stopped/budget → 忙时 steer 注入收尾提示', async () => {
    // 脚本消费序：contexts[0]=首答（usage 1500 ≥ 预算 1000 → 刹车注入 steer）
    // → contexts[1]=收尾轮（模型收口，run 才真正结算）
    const { streamFn, contexts } = scriptedStream([usageMessage('干了一半', 1500), textMessage('收尾交代')]);
    const runtime = await assemble({ streamFn });
    await callTool(runtime, 'goal_set', { objective: '预算内做完', tokenBudget: 1000 });

    await runtime.conversation!.submitOnce('开工');
    await spinUntil(() => contexts.length >= 2, '刹车收尾 steer 开轮');
    await runtime.conversation!.settle();

    // 刹停已落库：stopped/budget + 记账定格 1500
    const text = await goalText(runtime);
    expect(text).toContain('状态：stopped（原因：budget）');
    expect(text).toContain('1500 / 1000 tokens');
    // 收尾注入：忙时 steer——同轮继续，模型当轮交代（非硬断）
    const steered = userTexts(contexts[1]!).join('\n');
    expect(steered).toContain('预算刹车');
    expect(steered).toContain('不再续跑');
    // 刹停后结算：不再续跑（stopped 非 active）
    expect(contexts).toHaveLength(2);
  });
});

describe('boot 降级 + /goal 命令族 + /reload 不双降（跨进程真库文件）', () => {
  it('重开续接 active ⇒ needs-resume；/goal resume 重新授权；/reload 不误降级；/goal stop 人工停', async () => {
    const dbFile = join(realpathSync(tmpdir()), `app-goal-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const workspace = makeTempDir('app-goal-boot-');

    // 首程：设定 active 目标后关停（自管生命周期——让位给续接程）
    const first = await createBerryRuntime({
      dbPath: dbFile,
      workspace,
      streamFn: scriptedStream([textMessage('答')]).streamFn,
    });
    await callTool(first, 'goal_set', { objective: '跨重启的长目标', tokenBudget: 50000 });
    await first.shutdown();

    // 二程：同库同 cwd 续接（resumeSession:true = TUI 默认续接最新策略）——
    // 装载收口 session_start 补播（origin=resume + replay:true + 首见 armed）
    // 触发降级：active ⇒ needs-resume（激活权不跨进程；二十九批增补 8①）
    const second = await createBerryRuntime({
      dbPath: dbFile,
      workspace,
      resumeSession: true,
      streamFn: scriptedStream([textMessage('答'), textMessage('答二')]).streamFn,
    });
    runtimes.push(second);
    expect(await goalText(second)).toContain('状态：needs-resume');

    // /goal resume：人类重新授权 → active
    const { backend, notifies } = recordingBackend();
    second.ui.attach(backend);
    expect(await second.channels.commands.dispatch('/goal resume')).toBe('ok');
    expect(notifies.some((n) => n.includes('重新激活'))).toBe(true);
    expect(await goalText(second)).toContain('状态：active');

    // /reload：复用同一官方件实例重跑 apply——「本件尚未见过补播」旗标已解除，
    // 补播照发但三合一条件不满足，不误降级
    const reloaded = await second.reload();
    expect(reloaded.payload?.activated).toContain('goal');
    expect(await goalText(second)).toContain('状态：active');

    // /goal 查状态 + /goal stop 人工停
    expect(await second.channels.commands.dispatch('/goal')).toBe('ok');
    expect(notifies.some((n) => n.includes('跨重启的长目标'))).toBe(true);
    expect(await second.channels.commands.dispatch('/goal stop')).toBe('ok');
    const final = await goalText(second);
    expect(final).toContain('状态：stopped（原因：user）');
    // 停后结算不续跑（stopped 行——续跑三条件用例已锁，此处锁状态面）
    await second.conversation!.submitOnce('再问');
    await second.conversation!.settle();
  });
});

describe('persist:false 降级：goal 空转', () => {
  it('无持久层 → 工具/命令不注册、行仍 activated（语义诚实）', async () => {
    const runtime = await assemble({ persist: false, streamFn: scriptedStream([textMessage('答')]).streamFn });
    expect(runtime.appsService.list().map((r) => [r.id, r.status])).toContainEqual(['goal', 'activated']);
    expect(runtime.tools.get('goal_get')).toBeUndefined();
    expect(runtime.tools.get('goal_set')).toBeUndefined();
    expect(runtime.tools.get('goal_update')).toBeUndefined();
    expect(await runtime.channels.commands.dispatch('/goal')).toBe('unknown');
  });
});

/* ---------------- 用例：S1 键控（结算/记账按归属会话各归各） ---------------- */

describe('S1 键控：goal 结算/降级按归属会话路由', () => {
  it('双驱动各持目标：A 的续跑只进 A 时间线，B 目标不受 A 结算牵连', async () => {
    // 消费序：A 首轮 → A 续跑轮 → B 首轮（末条兜底重复无碍）
    const { streamFn, contexts } = scriptedStream([textMessage('答A1'), textMessage('答A2'), textMessage('答B1')]);
    const runtime = await assemble({ streamFn });
    const registry = runtime.drivers;
    const first = registry.focused()!;
    // goal_set 走聚焦路由（直接调工具无调用链——落前台聚焦会话）
    await callTool(runtime, 'goal_set', { objective: '甲目标', tokenBudget: 100000 });
    const second = registry.open()!;
    await callTool(runtime, 'goal_set', { objective: '乙目标', tokenBudget: 100000 });

    // A 跑完一轮（结算 completed）→ 续跑注入只进 A 时间线（显式键 = settled.sessionId）
    await first.driver.submitOnce('甲开始');
    await spinUntil(() => contexts.length >= 2, 'A 续跑注入开轮');
    await first.driver.settle();
    const aInjected = first.session.events.filter(
      (e) => e.type === 'user/message' && (e.data as { source?: string }).source === 'app:goal',
    );
    expect(aInjected.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(aInjected)).toContain('甲目标');

    // B 跑一轮：自己的目标在、A 的续跑提示词不串入 B 时间线
    await second.driver.submitOnce('乙开始');
    await second.driver.settle();
    expect(JSON.stringify(second.session.events)).not.toContain('甲目标');
    expect(JSON.stringify(first.session.events)).not.toContain('乙目标');

    // 各会话目标行独立可查（goal_get 走聚焦——幂等 open 切回）
    registry.open({ resume: first.session.header.sessionId });
    expect(await goalText(runtime)).toContain('甲目标');
    registry.open({ resume: second.session.header.sessionId });
    expect(await goalText(runtime)).toContain('乙目标');
  });

  it('⓪b 续接降级事件面：session_start origin=resume → 该会话 active 行降 needs-resume', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ streamFn });
    await callTool(runtime, 'goal_set', { objective: '跨进程目标', tokenBudget: 100000 });
    expect(await goalText(runtime)).toContain('状态：active');
    // 进程内再开续接会话的等价物（chat 件 open 恒发 session_start——goal 事件面订阅）
    runtime.ctx.emit('session_start', { sessionId: runtime.session!.header.sessionId, origin: 'resume' });
    expect(await goalText(runtime)).toContain('状态：needs-resume');
    // 非 resume 起源不触发降级路径（新开不是续接——状态保持，不抛不炸）
    runtime.ctx.emit('session_start', { sessionId: runtime.session!.header.sessionId, origin: 'new' });
    expect(await goalText(runtime)).toContain('状态：needs-resume');
  });
});

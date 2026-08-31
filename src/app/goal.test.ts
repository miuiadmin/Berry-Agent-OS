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

import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, LlmContext, StreamFn, StreamFnOptions, Usage } from '../contracts/llm.js';
import {
  AppError,
  GOAL_ACTIVE_EXISTS,
  GOAL_GATE_FAILED,
  GOAL_NOT_FOUND,
  GOAL_TODO_SCOPE,
  GOAL_TRANSITION_INVALID,
  TOOL_ARGUMENTS_INVALID,
} from '../contracts/errors.js';
import type { UiBackend } from '../channels/types.js';
import { JobsStore } from '../scheduler/store.js';
import { GoalStore } from '../goal/index.js';
import type { TickOsRegistrar } from './tick-register.js';
import { createRuntime } from './assembly.js';
import type { AppRuntime } from './assembly.js';

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
const runtimes: AppRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop()!;
    await runtime.shutdown().catch(() => undefined);
  }
});

/** 装配 + 登记 */
async function assemble(overrides: Parameters<typeof createRuntime>[0] = {}): Promise<AppRuntime> {
  const runtime = await createRuntime({ dbPath: ':memory:', workspace: makeTempDir('app-goal-'), ...overrides });
  runtimes.push(runtime);
  return runtime;
}

/** 经真工具管道调用（三段全走——schema 执法位在此面） */
function callTool(runtime: AppRuntime, name: string, args: Record<string, unknown>) {
  const def = runtime.tools.get(name);
  if (def === undefined) throw new Error(`工具未注册：${name}`);
  return runtime.tools.toAgentTool(def).execute('tc-goal', args);
}

/** goal_get 投影文本（状态断言用——全字段如实示态） */
async function goalText(runtime: AppRuntime): Promise<string> {
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

/** 直调驱动域工具（todo 等——经 compositionFor 投影取 def，三段管道照走） */
function callDriverTool(runtime: AppRuntime, name: string, args: Record<string, unknown>) {
  const sessionId = runtime.session!.header.sessionId;
  const def = runtime.tools.compositionFor(sessionId).find((d) => d.name === name);
  if (def === undefined) throw new Error(`工具未注册：${name}`);
  return runtime.tools.toAgentTool(def).execute('tc-goal3', args);
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

  it('goal_update 声明面根 object + 空参数三形指引（全面复盘 #24 回归锁：顶层 union 被网关剥成空声明面）', async () => {
    const runtime = await assemble({ streamFn: scriptedStream([textMessage('答')]).streamFn });
    // 声明面结构锁：根必须 type:'object'——顶层 union（anyOf 根）经宽容网关被
    // 剥成空声明面，真模型只见不可用 schema 以空参数 {} 调用、宿主 root 级拒绝
    // 9 连败（glm 经 anthropic-proxy 实证）——单测从不断言 schema 形状故此前漏网
    const def = runtime.tools.get('goal_update');
    expect(def, 'goal_update 已注册').toBeDefined();
    expect((def!.parameters as { type?: string }).type).toBe('object');

    await callTool(runtime, 'goal_set', { objective: '目标', tokenBudget: 50000 });
    // 空参数（真跑失败形状）：判别执法位给三形指引文案，非裸 root 拒绝——
    // 模型拿到可行动的回执才能自纠（空 schema 下模型只会重复 {}）
    const empty = await callTool(runtime, 'goal_update', {}).catch((e) => e);
    expect(empty).toBeInstanceOf(AppError);
    expect((empty as AppError).code).toBe(TOOL_ARGUMENTS_INVALID);
    expect((empty as AppError).message).toContain('三形');
    expect((empty as AppError).message).toContain('completed');
    // 两判别字段同携（ambiguous）同样拒：判别位执法互斥
    const both = await callTool(runtime, 'goal_update', {
      status: 'completed',
      outcome: 'outcome_progress',
      evidence: 'x',
    }).catch((e) => e);
    expect((both as AppError).code).toBe(TOOL_ARGUMENTS_INVALID);
    // 状态保持 active（非法形不落库）
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

  it('goal_set 终态行后重设：新 goalId 新行新账本（旧行留史、旧证据不残留）', async () => {
    const runtime = await assemble({ streamFn: scriptedStream([textMessage('答')]).streamFn });
    await callTool(runtime, 'goal_set', { objective: '旧目标', tokenBudget: 50000 });
    await callTool(runtime, 'goal_update', { status: 'completed', evidence: '旧目标完成证据' });
    const set = await callTool(runtime, 'goal_set', { objective: '新目标', tokenBudget: 80000 });
    expect((set.content[0] as { text: string }).text).toContain('行留史'); // v13 重设 = 新行留史非覆盖
    const text = await goalText(runtime);
    expect(text).toContain('状态：active');
    expect(text).toContain('新目标');
    expect(text).not.toContain('旧目标完成证据'); // 旧证据不残留（在新行投影上）
  });

  it('goal_update 轮结算形：outcome 落 goal/evidence 账本事件、行保持 active、可多次调用', async () => {
    const runtime = await assemble({ streamFn: scriptedStream([textMessage('答')]).streamFn });
    await callTool(runtime, 'goal_set', { objective: '长目标', tokenBudget: 50000 });
    // 两次轮结算（union 第三形：无 status 字段、outcome 判别）
    const first = await callTool(runtime, 'goal_update', { outcome: 'outcome_progress', evidence: '测试转绿一项' });
    expect((first.content[0] as { text: string }).text).toContain('轮结算已入账（outcome_progress）');
    const second = await callTool(runtime, 'goal_update', { outcome: 'surface_only' });
    expect((second.content[0] as { text: string }).text).toContain('轮结算已入账（surface_only）');
    // 行保持 active（轮结算非终态）
    expect(await goalText(runtime)).toContain('状态：active');
    // 账本投影：goal_get 近尾摘录带序号与 outcome（两Entries 全示）
    const text = await goalText(runtime);
    expect(text).toContain('证据账本（近 2/2 条）');
    expect(text).toContain('[outcome_progress]：测试转绿一项');
    expect(text).toContain('[surface_only]');
    // durable 事件真落两条（eventsOfType 面回读——appendEvent 正门写点）
    const events = runtime.ctx
      .get<{ eventsOfType(t: string): Array<{ data?: unknown }> }>('sessions')!
      .eventsOfType('goal/evidence');
    expect(events).toHaveLength(2);
    expect((events[0]!.data as { outcome: string }).outcome).toBe('outcome_progress');
    expect((events[1]!.data as { outcome: string }).outcome).toBe('surface_only');
    // goalId 归因键在场（账本按 goalId 过滤的锚）
    expect((events[0]!.data as { goalId: string }).goalId).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('goal_update 轮结算形 schema 执法：非法 outcome 词过不了参数校验段', async () => {
    const runtime = await assemble({ streamFn: scriptedStream([textMessage('答')]).streamFn });
    await callTool(runtime, 'goal_set', { objective: '目标', tokenBudget: 50000 });
    const bad = await callTool(runtime, 'goal_update', { outcome: 'progress' }).catch((e) => e);
    expect((bad as AppError).code).toBe(TOOL_ARGUMENTS_INVALID);
    expect(await goalText(runtime)).toContain('状态：active'); // 非法申报不落账
  });

  it('goal_get 带 goalId 查历史行：跨行史可寻（领养/审计面的读通道）', async () => {
    const runtime = await assemble({ streamFn: scriptedStream([textMessage('答')]).streamFn });
    await callTool(runtime, 'goal_set', { objective: '旧目标', tokenBudget: 50000 });
    // 先取旧行 goalId（设定后投影即含身份行）
    const oldGoalId = /身份：([0-9A-Z]{26})/.exec(await goalText(runtime))![1]!;
    await callTool(runtime, 'goal_update', { status: 'completed', evidence: '旧完成' });
    await callTool(runtime, 'goal_set', { objective: '新目标', tokenBudget: 50000 });
    // 缺省投影 = 当前行（active 优先）——新目标在场、旧证据不串面
    const current = await goalText(runtime);
    expect(current).toContain('新目标');
    expect(current).not.toContain('旧完成');
    // goalId 直取历史行：completed 旧行可寻（跨行史读通道）
    const history = await callTool(runtime, 'goal_get', { goalId: oldGoalId });
    const hist = (history.content[0] as { text: string }).text;
    expect(hist).toContain('旧目标');
    expect(hist).toContain('状态：completed');
    expect(hist).toContain('旧完成');
  });
});

describe('goal 续跑全栈：结算边界注入 → 模型申报完成 → 链自然停', () => {
  it('completed 结算 + active + 预算未尽 → 注入续跑提示（含纪律六件）；申报完成后 ⑤ 复验就地收场', async () => {
    // 脚本消费序：contexts[0]=用户首轮 → 续跑注入 contexts[1]（模型调 goal_update
    // completed）→ 下一模型步 ⑤ 复验面见非 active 行 stop:true 就地收场（刀三
    // T7-A——终态后的收口模型步不花预算；合成 turn_end 锚闭合）
    const { streamFn, contexts } = scriptedStream([
      textMessage('首轮答'),
      toolCallMessage('goal_update', { status: 'completed', evidence: '逐需求证据齐备（测试脚本申报）' }),
      textMessage('收口答'), // 不再消费——⑤ 收场后无第三模型步
    ]);
    const runtime = await assemble({ streamFn });
    await callTool(runtime, 'goal_set', { objective: '写完 goal 全栈测试', tokenBudget: 100000 });

    await runtime.conversation!.submitOnce('开始');
    // 续跑是结算后的闲时唤醒（异步于 submitOnce 决议）——自旋等第二个请求出现
    await spinUntil(() => contexts.length >= 2, '续跑注入开轮');
    await runtime.conversation!.settle();

    // 注入内容：续跑提示词携带目标原文 + 纪律六件（反缩水/完成审计/阻塞三轮/
    // 预算尽≠完成/轮结算诚实/后继义务）
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
    // 申报已落库：completed + 证据；链停在 2 个请求（⑤ 复验收场后结算见终态不再续）
    const text = await goalText(runtime);
    expect(text).toContain('状态：completed');
    expect(text).toContain('逐需求证据齐备');
    expect(contexts).toHaveLength(2);
  });

  it('needsWrite 开洞：goal_set 申报后续跑轮不收窄（全量工具面含 goal_set）', async () => {
    const { streamFn, contexts } = scriptedStream([
      textMessage('首轮答'),
      toolCallMessage('goal_update', { status: 'completed', evidence: '写面目标收口（测试脚本申报）' }),
      textMessage('收口答'), // 不再消费——⑤ 复验收场（同上用例）
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
    // ⑤ 复验收场：终态申报后无收口模型步（2 个请求定格）
    expect(contexts).toHaveLength(2);
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
    const first = await createRuntime({
      dbPath: dbFile,
      workspace,
      streamFn: scriptedStream([textMessage('答')]).streamFn,
    });
    await callTool(first, 'goal_set', { objective: '跨重启的长目标', tokenBudget: 50000 });
    await first.shutdown();

    // 二程：同库同 cwd 续接（resumeSession:true = TUI 默认续接最新策略）——
    // 装载收口 session_start 补播（origin=resume + replay:true + 首见 armed）
    // 触发降级：active ⇒ needs-resume（激活权不跨进程；二十九批增补 8①）
    const second = await createRuntime({
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

/* ---------------- 用例：goal 循环批刀二（计划态跨轮 + gates + open 否决） ---------------- */

describe('goal 刀二全栈：计划态跨轮 + gates 执法 + open 项否决', () => {
  it(
    '全链：goal_set 锚 → todo goal 段词汇落账（files gate 过）→ 新用户输入后注入仍在（跨轮）' +
      '→ open 项否决 → 全完放行 + goal_get 计划态投影',
    async () => {
      // files gate 判据物：真工作区内文件（非空）
      const workspace = makeTempDir('app-goal-plan-');
      writeFileSync(join(workspace, 'artifact.txt'), '落码产物\n');
      const { streamFn, contexts } = scriptedStream([textMessage('答'), textMessage('答二')]);
      const runtime = await assemble({ streamFn, workspace });
      const sessionId = runtime.session!.header.sessionId;

      /* ---- ① goal_set：激活锚 = 设定时点日志长度（其后 todo 表属 goal 段） ---- */
      await callTool(runtime, 'goal_set', { objective: '完成重构目标', tokenBudget: 100000 });

      /* ---- ② todo 直调（真管道）：goal 段词汇全字段 + files gate completed ---- */
      await callDriverTool(runtime, 'todo', {
        items: [
          { content: '落码', status: 'completed', noFollowUp: true, gate: { kind: 'files', spec: ['artifact.txt'] } },
          { content: '等外部依赖', status: 'deferred', role: 'user', resumeWhen: 'after@+2h' },
          { content: '收尾', status: 'pending' },
        ],
      });
      expect(runtime.session!.events.filter((e) => e.type === 'todo/write')).toHaveLength(1); // durable 落账

      /* ---- ③ open 项否决：2 项未完（deferred 含内）→ goal_update completed 被拒 ---- */
      const vetoed = await callTool(runtime, 'goal_update', { status: 'completed', evidence: '提前申报' }).catch(
        (e) => e,
      );
      expect(vetoed).toBeInstanceOf(AppError);
      expect((vetoed as AppError).code).toBe(GOAL_TRANSITION_INVALID);
      expect((vetoed as AppError).message).toContain('未完项');
      expect(await goalText(runtime)).toContain('状态：active'); // 否决不落库

      /* ---- ④ 计划态跨轮：新用户输入后（run-scoped 会归零）请求仍见全表回显 ---- */
      await runtime.conversation!.submitOnce('新指令');
      await spinUntil(() => contexts.length >= 1, '首请求');
      await runtime.conversation!.settle();
      const injected = userTexts(contexts[0]!).filter((t) => t.includes('非本次用户指令'));
      expect(injected).toHaveLength(1); // goal 段：user/message 非边界——run-scoped 下此处应为空
      expect(injected[0]).toContain('- [x] 落码');
      expect(injected[0]).toContain('- [-] 用户·等外部依赖 ⇢ after@+2h');
      expect(injected[0]).toContain('- [ ] 收尾');

      /* ---- ⑤ goal_get 计划态投影：计数 + 判据门（active 行才查） ---- */
      const midText = await goalText(runtime);
      expect(midText).toContain('计划态：共 3 项（未完 2，含缓办 1 · 已完 1）');
      expect(midText).toContain('判据门：1 项声明 gate（已过 1 / 待验 0）');

      /* ---- ⑥ 全完放行：deferred→completed 归位后 goal_update completed 结算 ---- */
      await callDriverTool(runtime, 'todo', {
        items: [
          { content: '落码', status: 'completed', noFollowUp: true },
          { content: '等外部依赖', status: 'completed', followUp: '依赖到位后复查' },
          { content: '收尾', status: 'completed', noFollowUp: true },
        ],
      });
      await callTool(runtime, 'goal_update', { status: 'completed', evidence: '逐需求证据齐备（测试脚本申报）' });
      expect(await goalText(runtime)).toContain('状态：completed');
    },
  );

  it('gates fail-closed 全栈 + 非 goal 段词汇守门：缺判据物整笔被拒（零落账）；goal 外 deferred 即拒', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ streamFn });

    /* ---- 非 goal 段对照（goal_set 之前）：goal 段词汇申报即拒 GOAL_TODO_SCOPE ---- */
    const scopeReject = await callDriverTool(runtime, 'todo', {
      items: [{ content: '缓办', status: 'deferred', resumeWhen: 'after@+2h' }],
    }).catch((e) => e);
    expect(scopeReject).toBeInstanceOf(AppError);
    expect((scopeReject as AppError).code).toBe(GOAL_TODO_SCOPE);
    expect(runtime.session!.events.filter((e) => e.type === 'todo/write')).toHaveLength(0);

    /* ---- gates fail-closed：goal 内 files gate 缺判据物 → 整笔被拒 ---- */
    await callTool(runtime, 'goal_set', { objective: '判据目标', tokenBudget: 100000 });
    const rejected = await callDriverTool(runtime, 'todo', {
      items: [
        { content: '落码', status: 'completed', noFollowUp: true, gate: { kind: 'files', spec: ['absent.txt'] } },
      ],
    }).catch((e) => e);
    expect(rejected).toBeInstanceOf(AppError);
    const err = rejected as AppError;
    expect(err.code).toBe(GOAL_GATE_FAILED);
    expect(err.message).toContain('kind=files reason=missing');
    expect(runtime.session!.events.filter((e) => e.type === 'todo/write')).toHaveLength(0); // fail-closed 零落账
  });
});

/* ---------------- 用例：goal 循环批刀三（预算双轨与轮身份） ---------------- */

describe('goal 刀三全栈：自激链至帽 + 归因落账 + 停滞硬停 + 重绑护栏 + ⑤ 复验', () => {
  /** 会话日志最小读面（注入/停因事件断言用） */
  interface SessionLogFace {
    readonly events: ReadonlyArray<{ readonly type: string; readonly data?: unknown }>;
  }

  /** 会话日志里的 goal 唤醒注入事件（data.attribution 断言面） */
  function wakeInjections(session: SessionLogFace): Array<Record<string, string | undefined>> {
    return session.events
      .filter((e) => e.type === 'user/message' && (e.data as { source?: string }).source === 'app:goal')
      .map((e) => (e.data as { attribution?: Record<string, string> }).attribution ?? {});
  }

  /** goal/evidence 停因形事件（reason 在场——capped/stalls/budget） */
  function stopReasons(session: SessionLogFace): string[] {
    return session.events
      .filter((e) => e.type === 'goal/evidence')
      .map((e) => (e.data as { reason?: string }).reason)
      .filter((reason): reason is string => reason !== undefined);
  }

  /** 从 goal_get 投影解析 goalId（身份：行——重绑/归因用例的行键） */
  async function goalIdOf(runtime: AppRuntime): Promise<string> {
    return (await goalText(runtime)).match(/身份：(\S+)/)![1]!;
  }

  it(
    '自激链至连续帽：3 轮自激后第 4 次拒发（reason capped·willRetry·非终态停）——' +
      '每轮注入携带归因 {goalId, wakeId（每轮新鲜）, wakePath:self} durable 落账',
    async () => {
      // 脚本末条兜底：全部 4 个 run 都吃同一文本应答（模型永不申报终态——链只能靠帽收口）
      const { streamFn, contexts } = scriptedStream([textMessage('答')]);
      const runtime = await assemble({ streamFn });
      await callTool(runtime, 'goal_set', { objective: '链帽目标', tokenBudget: 100000 });
      const goalId = await goalIdOf(runtime);

      await runtime.conversation!.submitOnce('开始');
      // 链推进：首跑 → 自激 1 → 自激 2 → 自激 3 → 第 4 次投递前连续帽拒发 = 4 个请求定格
      await spinUntil(() => contexts.length >= 4, '自激链推进至连续帽');
      await runtime.conversation!.settle();
      await spinUntil(() => stopReasons(runtime.session!).includes('capped'), 'capped 停因事件落 durable');

      // 归因落账：3 条唤醒注入各携带 goalId + 新鲜 wakeId + self 路标（wakeGate 帽扫描的就是这面）
      const attributions = wakeInjections(runtime.session!);
      expect(attributions).toHaveLength(3);
      for (const attribution of attributions) {
        expect(attribution.goalId).toBe(goalId);
        expect(attribution.wakePath).toBe('self');
        expect(typeof attribution.wakeId).toBe('string');
      }
      expect(new Set(attributions.map((a) => a.wakeId)).size).toBe(3); // 每轮 wakeId 新鲜
      // capped = 暂停投递非终态停：行仍 active（willRetry——下一 run 结算或到窗后再试）
      expect(await goalText(runtime)).toContain('状态：active');
      expect(contexts).toHaveLength(4); // 拒发后无第 5 请求
    },
  );

  it('停滞硬停：同 era 连续 3 轮 surface_only → stopped/stalls + 停因落账；账本摘录不混停因形', async () => {
    const { streamFn, contexts } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ streamFn });
    await callTool(runtime, 'goal_set', { objective: '停滞目标', tokenBudget: 100000 });
    // 3 轮 surface_only 直接经工具面入账（机器信号面——不经模型即攒齐停滞证据）
    for (let i = 0; i < 3; i++) {
      await callTool(runtime, 'goal_update', { outcome: 'surface_only', evidence: `表面动作 ${i + 1}` });
    }
    await runtime.conversation!.submitOnce('推进');
    await runtime.conversation!.settle();

    const text = await goalText(runtime);
    expect(text).toContain('状态：stopped（原因：stalls）');
    expect(stopReasons(runtime.session!)).toContain('stalls');
    expect(contexts).toHaveLength(1); // 硬停先于投递——无续跑注入
    // 账本摘录只收轮结算形（renderLedgerTail 过滤）：3 条 [surface_only] 在册，
    // 停因形（stalls）走状态行示态——混进序号摘录会渲染出 [undefined] 行
    expect(text).toContain('证据账本（近 3/3 条）');
    expect(text).toContain('[surface_only]');
    expect(text).not.toContain('undefined');
  });

  it('重绑护栏：/goal resume 领养重绑他乡后，旧会话迟到归因结算不再续跑（诚实让位不写状态）', async () => {
    const { streamFn, contexts } = scriptedStream([textMessage('答'), textMessage('答B')]);
    const runtime = await assemble({ streamFn });
    const registry = runtime.drivers;
    const first = registry.focused()!;
    await callTool(runtime, 'goal_set', { objective: '领养目标', tokenBudget: 100000 });
    const goalId = (await goalText(runtime)).match(/身份：(\S+)/)![1]!;
    // 降级（boot 等价物）→ 开新会话 B → /goal resume <goalId> 跨会话领养重绑到 B
    runtime.ctx.emit('session_start', { sessionId: first.session.header.sessionId, origin: 'resume' });
    const second = registry.open()!;
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);
    expect(await runtime.channels.commands.dispatch(`/goal resume ${goalId}`)).toBe('ok');
    expect(notifies.some((n) => n.includes('重新激活'))).toBe(true);

    // 旧会话 A 的迟到 run：携带本 goal 归因（在飞轮的典型残留）→ ⑤ 复验面在
    // 首个模型步前就地收场（行已换绑 B ≠ 本会话——在飞轮停发，零模型花销）；
    // 其后 ③ 结算路的同判再让位（双护栏同序触发）
    await first.driver.submitOnce('旧会话迟到结算', {
      source: 'app:goal',
      attribution: { goalId, wakeId: 'w-stale', wakePath: 'self' },
    });
    await first.driver.settle();
    expect(contexts).toHaveLength(0); // ⑤ 就地收场——run 从未进模型
    // ③ 注入标志（续跑提示词开场句）在 A/B 两时间线均未出现——注：A 的迟到
    // 消息自身带 source app:goal（测试造的归因面），不能按 source 计数
    for (const log of [first.session, second.session]) {
      const wakes = log.events.filter((e) => e.type === 'user/message' && JSON.stringify(e.data).includes('goal 续跑'));
      expect(wakes).toHaveLength(0);
    }
    // 行未被动过手脚：仍 active 且绑在 B（领养结果不被旧链路结算覆写）
    expect(await goalText(runtime)).toContain('状态：active');
  });

  it('停滞指令段 + 到窗复评段：两轮 surface_only 触发重估义务、绝对形过期 deferred 点名复评（extras 织入注入）', async () => {
    const { streamFn, contexts } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ streamFn });
    await callTool(runtime, 'goal_set', { objective: '复评目标', tokenBudget: 100000 });
    // 绝对形过期 = 固有点恒到窗（锚无关——确定性断言面）；2 轮 surface_only 攒 needsFloorRecovery
    await callDriverTool(runtime, 'todo', {
      items: [{ content: '等外部依赖', status: 'deferred', role: 'user', resumeWhen: 'after@2020-01-01T00:00:00Z' }],
    });
    for (let i = 0; i < 2; i++) {
      await callTool(runtime, 'goal_update', { outcome: 'surface_only', evidence: `表面 ${i + 1}` });
    }
    await runtime.conversation!.submitOnce('推进');
    await spinUntil(() => contexts.length >= 2, '续跑注入开轮');
    await runtime.conversation!.settle();

    const injected = userTexts(contexts[1]!).join('\n');
    expect(injected).toContain('停滞信号：以下为机器判定点名的行为义务，非建议');
    expect(injected).toContain('重估写面需求'); // needsFloorRecovery 义务（2 轮 surface_only）
    expect(injected).toContain('到窗复评：以下 deferred 项的复活条件已到窗');
    expect(injected).toContain('- after@2020-01-01T00:00:00Z'); // resumeWhen 原文点名
  });

  it('⑤ 复验让位：终态后 stale 归因在飞 → agent_pre_step 停发但状态面不被覆写（幂等让位）', async () => {
    // 归因闸门的反面（无归因 run 一律放行）由本套件全部普通对话用例隐式锁死——
    // ⑤ 已注册若缺闸门，每个会话每次 run 都会被停，全套件即红。预算尽分支由
    // ④ 记账（assistant/message 落账即同步刹停）结构性先达——active 行带
    // used≥budget 不可存活，⑤ 预算分支 = 记账迟到写竞窗防御位，本测锁可达分支。
    const { streamFn, contexts } = scriptedStream([
      textMessage('首轮答'),
      toolCallMessage('goal_update', { status: 'completed', evidence: '逐需求证据齐备（测试脚本申报）' }),
    ]);
    const runtime = await assemble({ streamFn });
    await callTool(runtime, 'goal_set', { objective: '复验目标', tokenBudget: 100000 });
    const sessionId = runtime.session!.header.sessionId;
    // 带归因的 run（归因在驱动上钉住——settle 后保留至下次 launch，复验面可读）
    await runtime.conversation!.submitOnce('开始', {
      source: 'app:goal',
      attribution: { goalId: await goalIdOf(runtime), wakeId: 'w-1', wakePath: 'self' },
    });
    await spinUntil(() => contexts.length >= 2, '续跑注入开轮（注入轮申报终态）');
    await runtime.conversation!.settle();
    expect(await goalText(runtime)).toContain('状态：completed');

    // 终态后的 stale 归因 pre-step：走根总线 waterfall 直派（装配桥同款入口）——
    // 停发（{stop:true}）但不写状态面，先到者（终态申报）赢
    const decision = await runtime.ctx.waterfall<{ readonly stop?: boolean }>(
      'agent_pre_step',
      { sessionId },
      () => undefined,
    );
    expect(decision).toEqual({ stop: true });
    const text = await goalText(runtime);
    expect(text).toContain('状态：completed'); // 不被覆写成 budget/stalls
    expect(stopReasons(runtime.session!)).not.toContain('budget');
    expect(contexts).toHaveLength(2); // 停发即无新模型步
  });

  it('boot 降级 tick 豁免：挂钟轮到点 resume 不降级（active 保持）；daemon 形态仍降级（豁免面只有 tick）', async () => {
    const dbFile = join(
      realpathSync(tmpdir()),
      `app-goal-tick-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    const workspace = makeTempDir('app-goal-tick-');

    // 首程：设定 active 目标后关停
    const first = await createRuntime({
      dbPath: dbFile,
      workspace,
      streamFn: scriptedStream([textMessage('答')]).streamFn,
    });
    await callTool(first, 'goal_set', { objective: '挂钟豁免目标', tokenBudget: 50000 });
    await first.shutdown();

    // tick 程：同库同 cwd 续接——挂钟轮到点的 resume 非人类重启，激活权保留
    const tick = await createRuntime({
      dbPath: dbFile,
      workspace,
      resumeSession: true,
      processKind: 'tick',
      streamFn: scriptedStream([textMessage('答')]).streamFn,
    });
    runtimes.push(tick);
    expect(await goalText(tick)).toContain('状态：active');
    await tick.shutdown();

    // daemon 程：常驻形态开面也是新进程接管——降级照发（豁免面只有 tick）
    const daemon = await createRuntime({
      dbPath: dbFile,
      workspace,
      resumeSession: true,
      processKind: 'daemon',
      streamFn: scriptedStream([textMessage('答')]).streamFn,
    });
    runtimes.push(daemon);
    expect(await goalText(daemon)).toContain('状态：needs-resume');
  });
});

/* ---------------- 用例：刀四挂钟命令族（/goal wake + CR-6 同笔停摆） ---------------- */

/** 假 OS 注册器（记录调用面——真 GoalJobsFace 走真 JobsStore，OS 侧停站） */
function fakeOsRegistrar() {
  const registered: string[] = [];
  const unregistered: string[] = [];
  const registrar: TickOsRegistrar = {
    register: async (job) => {
      registered.push(job.name);
      return { ok: true, message: 'fake-launchd-registered' };
    },
    unregister: async (name) => {
      unregistered.push(name);
      return { ok: true, message: 'fake-launchd-removed' };
    },
    isRegistered: async () => false,
  };
  return { registrar, registered, unregistered };
}

/** 挂钟行查询帮手（真 JobsStore 直读——owner/enabled/session_id 断言面） */
function goalJobRow(runtime: AppRuntime, goalId: string) {
  return new JobsStore(runtime.persistence!.store.connection).get(`goal-${goalId}`);
}

describe('goal 刀四全栈：/goal wake 挂钟命令族（真 GoalJobsFace + 假 OS 注册器）', () => {
  it('挂/摘全链：wake → 行 + wake_schedule 列 + OS 联动；off → 删行 + 注销 + 列空', async () => {
    const os = fakeOsRegistrar();
    const runtime = await assemble({
      streamFn: scriptedStream([textMessage('答')]).streamFn,
      osTickRegistrar: os.registrar,
    });
    await callTool(runtime, 'goal_set', { objective: '挂钟护航的长目标', tokenBudget: 50000 });
    const goalId = (await goalText(runtime)).match(/身份：(\S+)/)![1]!;
    const sessionId = runtime.drivers.focused()!.session.header.sessionId;
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);

    // 挂：schedule 词法过 + 行落库 + OS 注册联动 + goals 行声明列
    expect(await runtime.channels.commands.dispatch('/goal wake daily@09:00')).toBe('ok');
    expect(notifies.some((n) => n.includes('挂钟已登记'))).toBe(true);
    const job = goalJobRow(runtime, goalId)!;
    expect(job).toBeDefined();
    expect(job.owner).toBe('builtin:goal');
    expect(job.ownerKey).toBe(goalId);
    expect(job.enabled).toBe(true);
    expect(job.sessionId).toBe(sessionId);
    expect(job.schedule).toBe('daily@09:00');
    expect(new GoalStore(runtime.persistence!.store.connection).getByGoalId(goalId)!.wakeSchedule).toBe('daily@09:00');
    expect(os.registered).toEqual([`goal-${goalId}`]);

    // 摘：删行（防幽灵行）+ OS 注销 + 声明列回空
    expect(await runtime.channels.commands.dispatch('/goal wake off')).toBe('ok');
    expect(goalJobRow(runtime, goalId)).toBeUndefined();
    expect(new GoalStore(runtime.persistence!.store.connection).getByGoalId(goalId)!.wakeSchedule).toBeNull();
    expect(os.unregistered).toEqual([`goal-${goalId}`]);
  });

  it('词法执法在面：坏串响亮拒绝（行不写、OS 不动）；无 goal 拒', async () => {
    const os = fakeOsRegistrar();
    const runtime = await assemble({
      streamFn: scriptedStream([textMessage('答')]).streamFn,
      osTickRegistrar: os.registrar,
    });
    // 无 active 行：先拒
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);
    expect(await runtime.channels.commands.dispatch('/goal wake daily@09:00')).toBe('ok');
    expect(notifies.some((n) => n.includes('当前会话没有目标——挂钟挂在目标行上'))).toBe(true);
    // 有行 + 坏串：parseSchedule 面上拒
    await callTool(runtime, 'goal_set', { objective: '词法目标', tokenBudget: 50000 });
    const goalId = (await goalText(runtime)).match(/身份：(\S+)/)![1]!;
    expect(await runtime.channels.commands.dispatch('/goal wake nonsense')).toBe('ok');
    expect(notifies.some((n) => n.includes('schedule 不合法'))).toBe(true);
    expect(goalJobRow(runtime, goalId)).toBeUndefined();
    expect(os.registered).toHaveLength(0);
  });

  it('【回归锁 #52】⑤ 复验面预算刹停同笔停摆挂钟（与 ④/stalls/tools 终态路同一纪律）', async () => {
    const os = fakeOsRegistrar();
    const runtime = await assemble({
      streamFn: scriptedStream([textMessage('首轮答'), textMessage('次轮答')]).streamFn,
      osTickRegistrar: os.registrar,
    });
    await callTool(runtime, 'goal_set', { objective: '⑤ 复验预算目标', tokenBudget: 50000 });
    const goalId = (await goalText(runtime)).match(/身份：(\S+)/)![1]!;
    const sessionId = runtime.drivers.focused()!.session.header.sessionId;
    expect(await runtime.channels.commands.dispatch('/goal wake every@1h')).toBe('ok');
    expect(goalJobRow(runtime, goalId)!.enabled).toBe(true);

    // 带归因的 run 钉归因（⑤ 复验面的归因闸门数据源）
    await runtime.conversation!.submitOnce('开始', {
      source: 'app:goal',
      attribution: { goalId, wakeId: 'w-1', wakePath: 'self' },
    });
    await runtime.conversation!.settle();

    // 直造行态：store.addUsage 抬水位但不发 durable 事件（④ 记账路不触发）——
    // 行 active 且 used≥budget 只在 ⑤ 复验时点成立，正是「记账迟到写竞窗」的
    // 防御位形状（goal 刀三教训：此分支不可自然达，直造可达）
    new GoalStore(runtime.persistence!.store.connection).addUsage(sessionId, 60000, Date.now());

    const decision = await runtime.ctx.waterfall<{ readonly stop?: boolean }>(
      'agent_pre_step',
      { sessionId },
      () => undefined,
    );
    expect(decision).toEqual({ stop: true });
    expect(await goalText(runtime)).toContain('状态：stopped'); // budget 刹停落终态
    // 回归锁：挂钟同笔翻转 enabled=0（修复前此路漏 suspendWake——OS 钟照跳，
    // 每跳 tick 整机装配后让路空转，复盘 #52）
    await new Promise((r) => setTimeout(r, 20));
    expect(goalJobRow(runtime, goalId)!.enabled).toBe(false);
  });

  it('CR-6 终态同笔停摆：goal_update completed → enabled=0 行留史（OS 注册保留不注销）', async () => {
    const os = fakeOsRegistrar();
    const runtime = await assemble({
      streamFn: scriptedStream([textMessage('答')]).streamFn,
      osTickRegistrar: os.registrar,
    });
    await callTool(runtime, 'goal_set', { objective: '终态停摆目标', tokenBudget: 50000 });
    const goalId = (await goalText(runtime)).match(/身份：(\S+)/)![1]!;
    expect(await runtime.channels.commands.dispatch('/goal wake every@1h')).toBe('ok');
    expect(goalJobRow(runtime, goalId)!.enabled).toBe(true);

    // 终态形：settleDeclared 后 onTerminal → suspendWake → face.disable（fire-and-forget 微任务）
    await callTool(runtime, 'goal_update', { status: 'completed', evidence: '三件测试全绿收尾' });
    await new Promise((r) => setTimeout(r, 20));
    const job = goalJobRow(runtime, goalId)!;
    expect(job).toBeDefined(); // 行留史
    expect(job.enabled).toBe(false); // 生命周期位翻转
    expect(os.unregistered).toHaveLength(0); // OS 注册保留（廉价 no-op 非反复注销）
  });

  it('resume 重挂治愈陈旧指针：降级停摆 → 跨会话领养 resume → upsert 行复活且 session_id 换新', async () => {
    const os = fakeOsRegistrar();
    const runtime = await assemble({
      streamFn: scriptedStream([textMessage('答')]).streamFn,
      osTickRegistrar: os.registrar,
    });
    const registry = runtime.drivers;
    const first = registry.focused()!;
    await callTool(runtime, 'goal_set', { objective: '领养重挂目标', tokenBudget: 100000 });
    const goalId = (await goalText(runtime)).match(/身份：(\S+)/)![1]!;
    expect(await runtime.channels.commands.dispatch('/goal wake daily@09:00')).toBe('ok');

    // 降级（boot 等价物——活体 session_start resume 路）→ 同笔停摆挂钟
    runtime.ctx.emit('session_start', { sessionId: first.session.header.sessionId, origin: 'resume' });
    await new Promise((r) => setTimeout(r, 20));
    expect(goalJobRow(runtime, goalId)!.enabled).toBe(false);

    // 开新会话 B + 跨会话领养：reactivate 重绑 B + register upsert（enabled 复活 +
    // session_id 换新——治愈领养重绑后钟行陈旧指针，tick 投递前查行不再让路）
    const second = registry.open()!;
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);
    expect(await runtime.channels.commands.dispatch(`/goal resume ${goalId}`)).toBe('ok');
    expect(notifies.some((n) => n.includes('重新激活'))).toBe(true);
    const job = goalJobRow(runtime, goalId)!;
    expect(job.enabled).toBe(true);
    expect(job.sessionId).toBe(second.session.header.sessionId);
    expect(os.registered.filter((n) => n === `goal-${goalId}`).length).toBe(2); // 重挂再注册
  });
});

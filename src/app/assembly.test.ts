/**
 * L5 app — 组合根全栈测试（scripted streamFn + 真实装配，mock 只停在模型层）。
 *
 * 验证接线而非各模块行为（各模块有 1-to-1 测试）：事件落库、投影回读、
 * carve-out 全栈链（审批 → 守门 → durable 三事件齐）、持久化 round-trip、
 * 多轮续跑、命令面注册。
 */

import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AssistantMessage,
  AssistantStream,
  AssistantStreamEvent,
  LlmContext,
  StreamFn,
  StreamFnOptions,
  Usage,
} from '../contracts/llm.js';
import type { UiBackend } from '../channels/types.js';
import type { SessionEvent } from '../contracts/events.js';
import { deriveMessages } from '../session/derive.js';
import { interruptedTurnClosers } from '../session/index.js';
import { Persistence } from '../persist/index.js';
// 重开库须带与组合根同链迁移（collectBuiltinMigrations 机械聚合——与装配
// 同源，此后加带表件零改动跟随；宿主裸开只识 v1，少一段即拒开）
import { collectBuiltinMigrations } from './builtins.js';
import { createBerryRuntime } from './assembly.js';
import { ConversationDriver } from '../chat/index.js';
import type { BerryRuntime } from './assembly.js';
import { defaultConvertToLlm } from './convert.js';
import { runOnceMain } from './run-main.js';
import { dumpConfigMain } from './dump-config.js';
import {
  AppError,
  APP_NOT_FOUND,
  APP_SHUTDOWN_QUIESCE_VIOLATED,
  COMPOSITION_ROW_INVALID,
  PERSIST_BATCH_WRITE_FAILED,
  PLUGIN_EVENT_RATE,
  PLUGIN_LOAD_FAILED,
  SESSION_EVENT_DATA_INVALID,
  SESSION_EVENT_TOO_LARGE,
} from '../contracts/errors.js';
import { runInCallerChain } from '../context/chain.js';
import type { SubagentProvider, SubagentResult, SubagentsServiceFace } from '../contracts/subagent.js';

/* ---------------- 测试基建 ---------------- */

/** 零用量 */
const NO_USAGE: Usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 };

/** 文本 assistant 终值 */
const textMessage = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  usage: NO_USAGE,
  stopReason: 'stop',
  timestamp: 1,
});

/** 工具调用 assistant 终值（stopReason=toolUse） */
const toolCallMessage = (name: string, args: Record<string, unknown>): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id: `call-${name}`, name, arguments: args }],
  usage: NO_USAGE,
  stopReason: 'toolUse',
  timestamp: 1,
});

/** 合成流：start → done（终值即脚本消息；loop 只消费事件序与 result()） */
function syntheticStream(message: AssistantMessage): AssistantStream {
  const events: AssistantStreamEvent[] = [
    { type: 'start', partial: { ...message, content: [] } },
    { type: 'done', reason: 'stop', message },
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

/** 脚本化 StreamFn（按调用序取响应；记录请求上下文） */
function scriptedStream(responses: AssistantMessage[]) {
  const contexts: LlmContext[] = [];
  const streamFn: StreamFn = (context: LlmContext, _options: StreamFnOptions) => {
    contexts.push(context);
    const message = responses[Math.min(contexts.length - 1, responses.length - 1)]!;
    return syntheticStream(message);
  };
  return { streamFn, contexts };
}

/** 临时工作区（realpath 归一——macOS /var 与 /private/var 差异教训） */
function makeWorkspace(): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-asm-')));
}

/** 本用例运行时登记（afterEach 统一关停防句柄泄漏） */
const runtimes: BerryRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop()!;
    await runtime.shutdown().catch(() => undefined);
  }
});

/** 装配 + 登记（全部用例经此入口——统一 options 缺省；插件装载使工厂 async） */
async function assemble(overrides: Parameters<typeof createBerryRuntime>[0] = {}): Promise<BerryRuntime> {
  const runtime = await createBerryRuntime({
    dbPath: ':memory:',
    workspace: makeWorkspace(),
    ...overrides,
  });
  runtimes.push(runtime);
  return runtime;
}

/** 事件类型序列 */
const types = (runtime: BerryRuntime) => (runtime.session?.events ?? []).map((e) => e.type);

/** 恒真 stub UI 后端（interactive 审批用） */
function approveAllBackend(): UiBackend {
  return {
    id: 'stub',
    notify: () => {},
    setStatus: () => {},
    confirm: async () => true,
  };
}

/* ---------------- 装配面 ---------------- */

describe('createBerryRuntime 装配面', () => {
  it('fs 四件 + 内置命令注册；sandbox/mode 落库；系统提示词含基座', async () => {
    const runtime = await assemble();
    // 官方默认层三行（契约篇 §5.1）：memory 首行五件 + subagent 次行委派工具
    // agent + goal 第三行工具三件（goal 纵切二起为默认装配现实）。
    // S2 两层注册表：fs 四件随 chat 件驱动 open 落**域层**（本会话键）——会话
    // 可见面 = listFor(本会话) = 全局层 + 域层；裸 list() 只余全局层（诊断口径）
    expect(runtime.tools.listFor(runtime.session!.header.sessionId).map((t) => t.name)).toEqual([
      'find',
      'grep',
      'memory_write',
      'memory_forget',
      'memory_restore',
      'memory_read',
      'memory_search',
      'agent',
      'goal_get',
      'goal_set',
      'goal_update',
      'fetch',
      'plugins_list',
      'events_query',
      'plugins_install',
      'plugins_update',
      'plugins_toggle',
      'plugins_configure',
      'plugins_reload',
      'plugins_uninstall_inspect',
      'agent_hermes', // delegable 应用自动注册（第三纵切，boot 组合根——hermes 声明 entry.delegable）
      'read',
      'write',
      'edit',
      'ls',
      'bash',
    ]);
    const commands = runtime.channels.commands.list().map((c) => c.name);
    for (const expected of ['help', 'quit', 'skills']) {
      expect(commands).toContain(expected);
    }
    expect(runtime.session?.events.map((e) => e.type)).toEqual(['sandbox/mode']);
    expect(runtime.systemPrompt).toContain('terminal-based coding assistant');
  });

  it('llm 具名服务已 provide（ctx.llm：插件单发补全面，骨架篇 §9.3）', async () => {
    const runtime = await assemble();
    const service = runtime.ctx.tryGet<{ complete(req: { messages: unknown[] }): Promise<unknown> }>('llm');
    expect(service).toBeTruthy();
    expect(typeof service!.complete).toBe('function');
  });

  it('sessions 具名服务（ctx.sessions：插件 durable 落点 + 内核词伪造防护，骨架篇 §9.2）', async () => {
    const runtime = await assemble();
    const sessions = runtime.ctx.tryGet<{ appendEvent(type: string, data: unknown): SessionEvent | undefined }>(
      'sessions',
    )!;
    expect(sessions).toBeTruthy();
    // 已注册插件词汇可写：落当前活跃会话日志（memory/diff = surface 事件）
    const ev = sessions.appendEvent('memory/diff', { baseline: 'deadbeefdeadbeef', entries: [] })!;
    expect(ev.type).toBe('memory/diff');
    expect(runtime.session!.events.at(-1)).toBe(ev);
    // 内核词汇伪造防护：核心词的写入权属宿主（归因/审批/结算语义绑宿主写点）
    for (const core of ['user/message', 'assistant/message', 'tool/call', 'request/header', 'llm/usage']) {
      expect(() => sessions.appendEvent(core, {})).toThrowError(/核心事件词汇/);
    }
    // 未注册词汇：session.append 二道闸（注册即写入许可）
    expect(() => sessions.appendEvent('nope/void', {})).toThrowError(/未知事件类型/);

    // #19 收口回归锁（插件面钥匙——2026-08-25 Hermes 探针收口）：作用域经
    // ctx.registerSessionEventType 注册自有词汇 → appendEvent 即可写（此前第三方
    // 写任何自有词汇必撞「未知事件类型」——有门没钥匙）；核心词在注册侧先拦；
    // 作用域 dispose → 词汇随插件卸载回卷（/reload 重装重注册语义），写侧恢复拒绝
    const scope = runtime.ctx.fork({ name: 't-plugin' });
    expect(() => scope.registerSessionEventType({ type: 'user/message', category: 'surface' })).toThrowError(
      /核心事件类型/,
    );
    scope.registerSessionEventType({ type: 't-probe/note', category: 'log-only' });
    const noted = sessions.appendEvent('t-probe/note', { text: '探针' })!;
    expect(noted.type).toBe('t-probe/note');
    await scope.dispose();
    expect(() => sessions.appendEvent('t-probe/note', {})).toThrowError(/未知事件类型/);

    // persist:false：服务仍 provide（inject 硬依赖，缺供即启动断言）但无会话 → undefined 降级
    const bare = await assemble({ persist: false });
    const bareSessions = bare.ctx.tryGet<{ appendEvent(t: string, d: unknown): SessionEvent | undefined }>('sessions')!;
    expect(bareSessions.appendEvent('memory/diff', {})).toBeUndefined();
  });

  it('sessions 写面频率护栏（契约篇 §1.6 资源护栏族 #14，刀〇b）：按目标会话令牌桶 fail-loud', async () => {
    // 小桶注入（容量 3）+ 时钟冻结（回填 = 0）——确定性触顶；生产缺省 2000/1000 每分钟
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const runtime = await assemble({ sessionRateLimit: { capacity: 3, perMinute: 60 } });
      const sessions = runtime.ctx.tryGet<{ appendEvent(t: string, d: unknown): SessionEvent | undefined }>(
        'sessions',
      )!;
      for (let i = 0; i < 3; i++) {
        expect(sessions.appendEvent('memory/diff', { baseline: 'aa', entries: [] })).toBeTruthy();
      }
      // 第 4 发撞桶：fail-loud——message 带面名（appendEvent）与目标会话键（两面包可分辨）
      try {
        sessions.appendEvent('memory/diff', { baseline: 'bb', entries: [] });
        expect.unreachable('应当抛错');
      } catch (e) {
        expect((e as AppError).code).toBe(PLUGIN_EVENT_RATE);
        expect((e as AppError).message).toContain('appendEvent');
        expect((e as AppError).message).toContain(runtime.session!.header.sessionId);
      }
      // 执法先于计费：未注册词在 session.append 内先抛（不占令牌、码可分辨非护栏）
      try {
        sessions.appendEvent('nope/void', {});
        expect.unreachable('应当抛错');
      } catch (e) {
        expect((e as AppError).code).not.toBe(PLUGIN_EVENT_RATE);
        expect((e as Error).message).toContain('未知事件类型');
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('sessions 读面（P0-1 只读投影：currentSessionId + eventsOfType 写读同规，会话篇 §3.2）', async () => {
    const runtime = await assemble();
    const sessions = runtime.ctx.tryGet<{
      appendEvent(type: string, data: unknown): SessionEvent | undefined;
      currentSessionId(): string | undefined;
      eventsOfType(type: string): SessionEvent[];
    }>('sessions')!;
    // currentSessionId 与 sessionId 信封同源（活引用闭包）
    expect(sessions.currentSessionId()).toBe(runtime.session!.header.sessionId);

    // eventsOfType：已注册词汇过滤枚举（内存活日志投影——append 即见，零迟滞）
    sessions.appendEvent('memory/diff', { baseline: 'aa', entries: [] });
    const diffs = sessions.eventsOfType('memory/diff');
    expect(diffs.length).toBeGreaterThanOrEqual(1);
    expect(diffs.every((e) => e.type === 'memory/diff')).toBe(true);

    // 写读同规回归锁：撞未注册词同抛 SESSION_FORMAT_UNSUPPORTED（读侧静默空数组
    // = 拼错事件名的无声死，禁止——此前读面不存在，此测试锁的是新增读闸行为）
    expect(() => sessions.eventsOfType('nope/void')).toThrowError(/未知事件类型/);
    // 核心词不禁读（已注册即返回——读不伪造宿主语义；此处断言可读且有内容）
    const sandboxFacts = sessions.eventsOfType('sandbox/mode');
    expect(sandboxFacts.length).toBeGreaterThanOrEqual(1);

    // persist:false 无会话：currentSessionId undefined + 已注册词汇空枚举（不炸）
    const bare = await assemble({ persist: false });
    const bareSessions = bare.ctx.tryGet<{
      currentSessionId(): string | undefined;
      eventsOfType(type: string): SessionEvent[];
    }>('sessions')!;
    expect(bareSessions.currentSessionId()).toBeUndefined();
    expect(bareSessions.eventsOfType('memory/diff')).toEqual([]);
    // 无会话时未注册词照抛（词汇闸与会话无关——注册表是全局事实）
    expect(() => bareSessions.eventsOfType('nope/void')).toThrowError(/未知事件类型/);
  });

  it('sessions 遮蔽写面（appendWithSurfaceOp 宿主代写四执法点 + deriveMessages 投影读面，compaction 纵切）', async () => {
    const runtime = await assemble();
    const sessions = runtime.ctx.tryGet<{
      appendEvent(type: string, data: unknown): SessionEvent | undefined;
      appendWithSurfaceOp(carrier: {
        readonly type: string;
        readonly data: { readonly content: unknown; readonly source: string };
        readonly surfaceOp: { readonly op: 'replace'; readonly start: number; readonly end: number };
        readonly sourceEventSeqs: readonly number[];
      }): Promise<SessionEvent | undefined>;
      deriveMessages(): Array<{ type: string; content?: unknown }>;
    }>('sessions')!;
    // 造两条可遮蔽事件（sandbox/mode 已占 seq0；本两条 = seq1/seq2）
    sessions.appendEvent('memory/diff', { baseline: 'aa', entries: [] });
    sessions.appendEvent('memory/diff', { baseline: 'bb', entries: [] });

    // 执法点 ①：载体型单边——仅受理 user/message（assistant 词写权属 loop）
    await expect(
      sessions.appendWithSurfaceOp({
        type: 'assistant/message',
        data: { content: 'x', source: 'plugin:t' },
        surfaceOp: { op: 'replace', start: 1, end: 2 },
        sourceEventSeqs: [0, 1, 2],
      }),
    ).rejects.toThrowError(/载体型单边/);

    // 执法点 ②：必带 replace 型 surfaceOp（无遮蔽注入走 sendUserMessage 归因正门）
    await expect(
      sessions.appendWithSurfaceOp({
        type: 'user/message',
        data: { content: 'x', source: 'plugin:t' },
        surfaceOp: undefined,
        sourceEventSeqs: [1],
      } as never),
    ).rejects.toThrowError(/必带 replace 型 surfaceOp/);

    // 执法点 ③：归因强制 plugin: 前缀（宿主代写是插件行为，归因落在插件名上）
    await expect(
      sessions.appendWithSurfaceOp({
        type: 'user/message',
        data: { content: 'x', source: 'user' },
        surfaceOp: { op: 'replace', start: 1, end: 2 },
        sourceEventSeqs: [0, 1, 2],
      }),
    ).rejects.toThrowError(/归因强制 plugin:/);

    // 执法点 ④：依据在列——sourceEventSeqs 须含区间外至少一笔（依据≠被遮蔽节点）
    await expect(
      sessions.appendWithSurfaceOp({
        type: 'user/message',
        data: { content: 'x', source: 'plugin:t' },
        surfaceOp: { op: 'replace', start: 1, end: 2 },
        sourceEventSeqs: [1, 2], // 全在区间内
      }),
    ).rejects.toThrowError(/溯源依据在列/);

    // 合法路径：遮 [1,2] + 依据含区间外 seq0 → 落账 + 投影读面生效
    const carrier = await sessions.appendWithSurfaceOp({
      type: 'user/message',
      data: { content: '压缩摘要', source: 'plugin:compaction' },
      surfaceOp: { op: 'replace', start: 1, end: 2 },
      sourceEventSeqs: [0, 1, 2],
    });
    expect(carrier).toBeDefined();
    expect(carrier!.surfaceOp).toMatchObject({ start: 1, end: 2 });
    expect(runtime.session!.events.at(-1)).toBe(carrier);
    // deriveMessages 投影读面：载体可见（user 型 + 摘要内容）
    const msgs = sessions.deriveMessages();
    const carrierMsg = msgs.find((m) => m.type === 'user' && JSON.stringify(m.content).includes('压缩摘要'));
    expect(carrierMsg).toBeDefined();

    // persist:false 无会话：合法载体也返回 undefined 降级（与 appendEvent 同规）
    const bare = await assemble({ persist: false });
    const bareSessions = bare.ctx.tryGet<{
      appendWithSurfaceOp(carrier: unknown): Promise<SessionEvent | undefined>;
      deriveMessages(): unknown[];
    }>('sessions')!;
    expect(
      await bareSessions.appendWithSurfaceOp({
        type: 'user/message',
        data: { content: 'x', source: 'plugin:t' },
        surfaceOp: { op: 'replace', start: 0, end: 0 },
        sourceEventSeqs: [0, 1], // 1 = 区间外依据（形状合法——执法四点全过后才到无落点降级）
      } as never),
    ).toBeUndefined();
    expect(bareSessions.deriveMessages()).toEqual([]);
  });

  it('llm 模型目录只读投影（P0-1：listModels/getModel——ModelInfo 投影面）', async () => {
    const runtime = await assemble();
    const service = runtime.ctx.tryGet<{
      listModels(provider?: string): Array<{ id: string; provider: string; contextWindow: number }>;
      getModel(id: string): { id: string } | undefined;
    }>('llm')!;
    // faux provider 目录非空；id 为 provider/model 全形；传输/配置面字段不在投影
    const all = service.listModels();
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) {
      expect(m.id).toContain('/');
      expect(m.provider.length).toBeGreaterThan(0);
      expect(m.contextWindow).toBeGreaterThan(0);
    }
    expect(Object.keys(all[0]!).sort()).toEqual([
      'contextWindow',
      'id',
      'input',
      'maxTokens',
      'name',
      'provider',
      'reasoning',
    ]);
    // 点查：全形 id 命中同投影；不在目录 = undefined（点查语义，不抛）
    const first = all[0]!;
    expect(service.getModel(first.id)!.id).toBe(first.id);
    expect(service.getModel('nope/never-exists')).toBeUndefined();
    // provider 过滤参数可用（同目录同账切面）
    expect(service.listModels(first.provider).every((m) => m.provider === first.provider)).toBe(true);
  });

  it('persist:false 不开库不建会话（dump-config 姿态）', async () => {
    const runtime = await assemble({ persist: false });
    expect(runtime.persistence).toBeUndefined();
    expect(runtime.session).toBeUndefined();
    // S2 后全局层口径：fs 四件迁域层（无驱动即无域工具——persist:false 不开
    // 驱动）；memory/goal 空转；admin 件八工具经 ctx 取服务恒在（sessions
    // 降级返空）——剩 find/grep/agent/fetch + admin 八件共十二件
    // + agent_hermes（delegable 自动注册，boot 组合根——无驱动语境也在全局层）
    expect(runtime.tools.list().map((t) => t.name)).toEqual([
      'find',
      'grep',
      'agent',
      'fetch',
      'plugins_list',
      'events_query',
      'plugins_install',
      'plugins_update',
      'plugins_toggle',
      'plugins_configure',
      'plugins_reload',
      'plugins_uninstall_inspect',
      'agent_hermes',
    ]);
  });

  it('技能发现注入：SKILL.md 落临时位置后进系统提示词 + /skill 命令注册', async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'app-skill-'));
    mkdirSync(join(home, '.berry', 'skills', 'demo'), { recursive: true });
    writeFileSync(
      join(home, '.berry', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: 演示技能\n---\n\n演示指令体\n',
    );
    const runtime = await assemble({ homeDir: home });
    // 出厂样例技能随包恒可见（§4.4 ⑤——repo 根 skills/ 三件，拍板 17），本测试
    // 临时 home 下 user 层零技能 → 清单 = 出厂三件 + 注入的 demo（user 层压过出厂）
    // + admin 件随件技能（builtin 自述 packageRoot 桥——契约篇 §3.4，随第十行装载）
    expect(runtime.skills.list().map((s) => s.name)).toEqual([
      'demo',
      'commit-checklist',
      'plugin-quickstart',
      'troubleshooting',
      'admin',
    ]);
    expect(runtime.systemPrompt).toContain('<name>demo</name>');
    expect(runtime.channels.commands.lookup('skill:demo')).toBeDefined();
  });
});

/* ---------------- 会话驱动全栈 ---------------- */

describe('ConversationDriver + durable 接线', () => {
  it('submitOnce 单轮：request/header + turn + 消息全落库；投影回读两条', async () => {
    const { streamFn, contexts } = scriptedStream([textMessage('你好，完成')]);
    const runtime = await assemble({ streamFn });
    const result = await runtime.conversation!.submitOnce('做点什么');
    expect(result?.status).toBe('completed');
    expect(types(runtime)).toEqual([
      'sandbox/mode',
      'request/header',
      'turn/start',
      'user/message',
      'assistant/message',
      // 底账统一（契约篇 §5.4）：主循环前台道折叠，紧跟 assistant 终值
      'llm/usage',
      'turn/end',
    ]);
    // LLM 请求上下文含系统提示词与工具面（装配接线证据；memory 五件 + agent +
    // goal 三件为默认装配成员）。S2 顺序 = listFor 面：全局层在前 + fs 域层在后
    expect(contexts[0]?.systemPrompt).toContain('terminal-based coding assistant');
    expect(contexts[0]?.tools?.map((t) => t.name)).toEqual([
      'find',
      'grep',
      'memory_write',
      'memory_forget',
      'memory_restore',
      'memory_read',
      'memory_search',
      'agent',
      'goal_get',
      'goal_set',
      'goal_update',
      'fetch',
      'plugins_list',
      'events_query',
      'plugins_install',
      'plugins_update',
      'plugins_toggle',
      'plugins_configure',
      'plugins_reload',
      'plugins_uninstall_inspect',
      'agent_hermes',
      'read',
      'write',
      'edit',
      'ls',
      'bash',
    ]);
    // request/header 载荷带应用域腿（血缘显式打标的证据面——契约篇 §5.4）
    const header = runtime.session!.events.find((e) => e.type === 'request/header');
    expect((header?.data as { app?: string }).app).toBe('chat');
    // 投影回读
    const projected = deriveMessages(runtime.session!.events);
    expect(projected.map((m) => m.type)).toEqual(['user', 'assistant']);
  });

  it('carve-out 全栈：headless 无应答者 → unavailable → gate block → durable 三事件齐', async () => {
    const workspace = makeWorkspace();
    mkdirSync(join(workspace, '.git'), { recursive: true });
    writeFileSync(join(workspace, '.git', 'config'), '原内容\n');
    const { streamFn } = scriptedStream([
      toolCallMessage('write', { path: '.git/config', content: '篡改' }),
      textMessage('被拦下了'),
    ]);
    const runtime = await assemble({ streamFn, workspace });

    const result = await runtime.conversation!.submitOnce('改 git 配置');
    expect(result?.status).toBe('completed');
    // 文件未被改动（审批拒绝链全程生效）
    expect(readFileSync(join(workspace, '.git', 'config'), 'utf8')).toBe('原内容\n');

    const events = runtime.session!.events;
    const gate = events.find((e) => e.type === 'gate/decision');
    expect(gate).toBeDefined();
    expect((gate!.data as { decision: string }).decision).toBe('block');
    const asked = events.find((e) => e.type === 'approval/asked');
    const decided = events.find((e) => e.type === 'approval/decided');
    expect(asked).toBeDefined();
    expect((decided!.data as { decision: string }).decision).toBe('unavailable');
    // 不变式：gate/decision 与 approval 对都先于 tool/result
    const indexOf = (type: string) => events.findIndex((e) => e.type === type);
    expect(indexOf('gate/decision')).toBeLessThan(indexOf('tool/result'));
    expect(indexOf('approval/decided')).toBeLessThan(indexOf('tool/result'));
    // 工具结果是错误（结构化拒绝进上下文），模型二轮收尾
    const projected = deriveMessages(events);
    expect(projected.map((m) => m.type)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    const toolResultMessage = projected[2]!;
    expect(toolResultMessage.type === 'toolResult' && toolResultMessage.isError).toBe(true);
  });

  it('interactive 审批 answerer：confirm=true 放行 carve-out 写入落地', async () => {
    const workspace = makeWorkspace();
    mkdirSync(join(workspace, '.git'), { recursive: true });
    writeFileSync(join(workspace, '.git', 'config'), '原内容\n');
    const { streamFn } = scriptedStream([
      toolCallMessage('read', { path: '.git/config' }),
      toolCallMessage('write', { path: '.git/config', content: '新内容\n' }),
      textMessage('改好了'),
    ]);
    const runtime = await assemble({ streamFn, workspace, interactive: true });
    runtime.ui.attach(approveAllBackend());

    const result = await runtime.conversation!.submitOnce('改 git 配置');
    expect(result?.status).toBe('completed');
    expect(readFileSync(join(workspace, '.git', 'config'), 'utf8')).toBe('新内容\n');
    const decided = runtime.session!.events.find((e) => e.type === 'approval/decided');
    expect((decided!.data as { decision: string }).decision).toBe('approve');
  });

  it('session/event 活体镜像（契约篇 §2.2）：append 后同步上总线，载荷 { sessionId, event } 信封', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ streamFn });
    const mirrored: Array<{ sessionId: string; event: SessionEvent }> = [];
    runtime.ctx.on('session/event', (payload: { sessionId: string; event: SessionEvent }) => {
      mirrored.push(payload);
    });
    await runtime.conversation!.submitOnce('问');
    // 镜像与 durable 同序同量（sandbox/mode 在订阅前已落，不重播——历史不是活体）
    expect(mirrored.map((m) => m.event.type)).toEqual([
      'request/header',
      'turn/start',
      'user/message',
      'assistant/message',
      // 底账统一：前台道折叠经活体镜像同样可见（事件流事实）
      'llm/usage',
      'turn/end',
    ]);
    // 信封归属：全部事件带同一 sessionId（dsh-11——多会话并存可分辨）
    const id = runtime.session!.header.sessionId;
    expect(mirrored.every((m) => m.sessionId === id)).toBe(true);
    // 事件本体即 SessionEvent（seq 连续递增，非重制副本）
    expect(mirrored.map((m) => m.event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('tools_change 接线（骨架篇 §9.2 装配层义务）：注册即刷新 loop 工具快照 + 即时落 header change 快照', async () => {
    const { streamFn, contexts } = scriptedStream([
      textMessage('首轮'),
      toolCallMessage('echo', { text: '回声' }),
      textMessage('完成'),
    ]);
    const runtime = await assemble({ streamFn });
    await runtime.conversation!.submitOnce('第一问');
    expect(runtime.session!.events.filter((e) => e.type === 'request/header')).toHaveLength(1); // 首轮 initial

    // 装配后动态注册（M2 插件挂载工具的同款路径）：tools_change → 活数组原位刷新
    let executions = 0;
    runtime.tools.register({
      name: 'echo',
      description: '回声工具（动态注册接线测试）',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      execute: async (args) => {
        executions++;
        return { content: [{ type: 'text', text: (args as { text: string }).text }] };
      },
    });

    // 注册即落 change 快照（不等下一 run 边界——「模型可见即落日志」），
    // 快照 toolSchemas 已含新工具
    const headers = runtime.session!.events.filter((e) => e.type === 'request/header');
    expect(headers.map((h) => (h.data as { reason: string }).reason)).toEqual(['initial', 'change']);
    const changeData = headers[1]!.data as { toolSchemas: Array<{ name: string }> };
    expect(changeData.toolSchemas.map((t) => t.name)).toContain('echo');

    // 第二轮：loop 每次模型请求读 context.tools（活数组已刷新）——新工具对模型可见可调用。
    // S2 顺序 = listFor 面：全局层（动态 echo 追加在全局层尾）在前 + fs 域层在后
    await runtime.conversation!.submitOnce('用 echo');
    expect(contexts[1]?.tools?.map((t) => t.name)).toEqual([
      'find',
      'grep',
      'memory_write',
      'memory_forget',
      'memory_restore',
      'memory_read',
      'memory_search',
      'agent',
      'goal_get',
      'goal_set',
      'goal_update',
      'fetch',
      'plugins_list',
      'events_query',
      'plugins_install',
      'plugins_update',
      'plugins_toggle',
      'plugins_configure',
      'plugins_reload',
      'plugins_uninstall_inspect',
      'agent_hermes',
      'echo',
      'read',
      'write',
      'edit',
      'ls',
      'bash',
    ]);
    expect(executions).toBe(1); // 真走了三段管道执行（非仅 schema 可见）
    expect(runtime.session!.events.some((e) => e.type === 'tool/result')).toBe(true);
  });

  it('多轮续跑：第二个 run 复用同一活数组时间线', async () => {
    const { streamFn, contexts } = scriptedStream([textMessage('第一答'), textMessage('第二答')]);
    const runtime = await assemble({ streamFn });
    await runtime.conversation!.submitOnce('第一问');
    await runtime.conversation!.submitOnce('第二问');
    // 第二次 LLM 调用可见完整历史（活数组单一时间线）
    expect(contexts[1]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const projected = deriveMessages(runtime.session!.events);
    expect(projected.map((m) => m.type)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('emit 回调违约：catch 补 turn_end，durable 日志无敞开 turn（#9 修复 b）', async () => {
    const { streamFn } = scriptedStream([textMessage('永远到不了的回答')]);
    const runtime = await assemble({ streamFn });
    // 展示消费者在首个 message_end（user 消息定稿）处一次性违约（模拟 durable
    // append 失败等回调契约破坏——emit 无隔离，异常沿 loop 上抛到驱动 catch）
    let violated = false;
    runtime.conversation!.addDisplay((event) => {
      if (event.type === 'message_end' && !violated) {
        violated = true;
        throw new Error('展示回调炸了');
      }
    });

    const result = await runtime.conversation!.submitOnce('会炸的问题');
    expect(result?.status).toBe('failed');
    // 修 b 前缺 turn/end：日志留敞开 turn，恢复协议对「孤儿+后续正常 turn」失据
    expect(types(runtime)).toEqual([
      'sandbox/mode',
      'request/header',
      'turn/start',
      'user/message',
      'assistant/message',
      // 底账统一（契约篇 §5.4）：主循环前台道折叠，紧跟 assistant 终值
      'llm/usage',
      'turn/end',
    ]);
    // 日志闭合 → 恢复协议零活儿（turn 必闭合纪律，会话篇 §1.4）
    expect(interruptedTurnClosers(runtime.session!.events)).toEqual([]);
  });
});

describe('ConversationDriver 防御（直接构造）', () => {
  it('writeHeader 抛错不卡死：running 复位后新 run 可开（#23 小修③）', async () => {
    // 直接构造驱动（不经组合根）：writeHeader 是注入面，可显式抛错。
    // streamFn 永抛——本用例只关心 run 编排不因首件失败永久卡 running
    const driver = new ConversationDriver({
      sessionId: 'test-session',
      context: { systemPrompt: '', messages: [], tools: [] },
      loopConfig: {
        streamFn: () => {
          throw new Error('模型不可用');
        },
        model: 'test/model',
        convertToLlm: defaultConvertToLlm,
      },
      writeHeader: () => {
        throw new Error('header 落库失败');
      },
    });
    // 第一次 run：writeHeader 抛 → 走统一 catch 合成 error 收尾（修 ③ 前是
    // running=true 后裸调抛错——attempt 未创建、finally 永不复位、永久卡死）
    const first = await driver.submitOnce('第一句');
    expect(first?.status).toBe('failed');
    // running 已复位：第二次能开新 run（修 ③ 前会入队返回 undefined 挂死）
    const second = await driver.submitOnce('第二句');
    expect(second?.status).toBe('failed');
  });
});

/* ---------------- 持久化 round-trip 与命令入口 ---------------- */

describe('持久化 round-trip 与命令入口', () => {
  it('flush → close → 重开 → loadSession：事件与投影完整还原', async () => {
    const dbFile = join(realpathSync(tmpdir()), `app-asm-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const workspace = makeWorkspace();
    const { streamFn } = scriptedStream([textMessage('存下来的回答')]);
    // 手动管理生命周期（不经 assemble 登记——本用例自管关停顺序）
    const runtime = await createBerryRuntime({ dbPath: dbFile, workspace, streamFn });
    await runtime.conversation!.submitOnce('要持久化的问题');
    await runtime.shutdown();

    const reopened = Persistence.open({
      path: dbFile,
      // 机械聚合链（collectBuiltinMigrations——与装配同源，此后加带表件零改动跟随）
      migrations: collectBuiltinMigrations(),
    });
    try {
      const sessionId = reopened.store.listSessionIds()[0]!;
      const session = reopened.loadSession(sessionId)!;
      expect(session).toBeDefined();
      const projected = deriveMessages(session.events);
      expect(projected.map((m) => m.type)).toEqual(['user', 'assistant']);
      expect(session.events.some((e) => e.type === 'request/header')).toBe(true);
    } finally {
      await reopened.close();
    }
  });

  it('库路径父目录不存在也能启动（ensureDbDir 建档——2026-08-25 修前 berry run 全新机器 ENOENT）', async () => {
    // 深层不存在的父目录：缺省数据目录与显式 APP_DB_PATH 两种首启形态的公共不变量
    const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-mkdir-')));
    const dbFile = join(base, 'deep', 'nested', 'sessions.db');
    const { streamFn } = scriptedStream([textMessage('首启回答')]);
    const runtime = await createBerryRuntime({ dbPath: dbFile, workspace: makeWorkspace(), streamFn });
    try {
      expect(existsSync(dbFile)).toBe(true); // 父目录被组合根 ③ 建档，SQLite 落库成功
      await runtime.conversation!.submitOnce('首启问题');
    } finally {
      await runtime.shutdown();
    }
  });

  it('runOnceMain：正常完成退出码 0；用法与失败路径不入此（run-main 直测）', async () => {
    const { streamFn } = scriptedStream([textMessage('单次回答')]);
    const code = await runOnceMain('单次问题', { dbPath: ':memory:', workspace: makeWorkspace(), streamFn });
    expect(code).toBe(0);
  });
});

/* ---------------- 启动续接与会话热切换（技术栈篇 §5 拍板） ---------------- */

/** 录音 stub UI 后端（/new 通知可见性断言用） */
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

describe('启动续接策略（技术栈篇 §5：默认续接最新会话）', () => {
  it('resumeSession:true 按 cwd 续接最新：同会话续跑 + 恢复协议闭合 + header reason=resume + 同档不重复落', async () => {
    const dbFile = join(realpathSync(tmpdir()), `app-resume-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const workspace = makeWorkspace();
    const script1 = scriptedStream([textMessage('第一答')]);
    // 首程自管生命周期（不经 assemble 登记——shutdown 后让位给续接程）
    const first = await createBerryRuntime({ dbPath: dbFile, workspace, streamFn: script1.streamFn });
    const firstId = first.session!.header.sessionId;
    await first.conversation!.submitOnce('第一问');
    // 模拟中断残形：敞开 turn（最后一个 turn/start 后无 turn/end）
    first.session!.append('turn/start', {});
    await first.shutdown();

    // 二次启动：同库同 cwd，按最新续接（恢复协议自动补齐闭合）
    const script2 = scriptedStream([textMessage('续答'), textMessage('再答')]);
    const second = await createBerryRuntime({
      dbPath: dbFile,
      workspace,
      resumeSession: true,
      streamFn: script2.streamFn,
    });
    try {
      expect(second.session!.header.sessionId).toBe(firstId); // 同一会话续跑
      // 敞开 turn 已被 closer 闭合（会话篇 §4：中断不是残缺）
      expect(
        second.session!.events.some(
          (e) => e.type === 'turn/end' && (e.data as { reason: string }).reason === 'interrupted',
        ),
      ).toBe(true);
      // 续程首请求：LLM 上下文带历史种子（投影回读 + 新问）
      await second.conversation!.submitOnce('第二问');
      expect(script2.contexts[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      // header 序列：首程 initial + 续程首快照 resume——组装参数未变不多落
      const headers = second.session!.events.filter((e) => e.type === 'request/header');
      expect(headers.map((e) => (e.data as { reason: string }).reason)).toEqual(['initial', 'resume']);
      // sandbox/mode 同档不重复（全日志仅首程一条——fold 取最后，重复只污染日志）
      expect(second.session!.events.filter((e) => e.type === 'sandbox/mode')).toHaveLength(1);
      // 第二 run 同 config：不落新快照（会话篇 §1.3 仅变化时落）
      await second.conversation!.submitOnce('第三问');
      expect(second.session!.events.filter((e) => e.type === 'request/header')).toHaveLength(2);
      // 投影回读完整（恢复 + 两轮续跑；敞开 turn 无消息腿不贡献投影）
      const projected = deriveMessages(second.session!.events);
      expect(projected.map((m) => m.type)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    } finally {
      await second.shutdown();
    }
  });

  it('resumeSession 指定不存在 id：回落新建（续接优先 ≠ 必须续接）', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ resumeSession: 'no-such-session', streamFn });
    expect(runtime.persistence!.latestSessionId(runtime.workspace)).toBeUndefined(); // 前置：库确无此 cwd 会话
    const result = await runtime.conversation!.submitOnce('问');
    expect(result?.status).toBe('completed');
    const header = runtime.session!.events.find((e) => e.type === 'request/header')!;
    expect((header.data as { reason: string }).reason).toBe('initial'); // 回落新建按 initial 记
  });
});

describe('/new 会话热切换', () => {
  it('新会话落新事件、旧会话封存不动、durable 换指生效、通知可见', async () => {
    const { streamFn } = scriptedStream([textMessage('旧答'), textMessage('新答')]);
    const runtime = await assemble({ streamFn });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);
    await runtime.conversation!.submitOnce('旧问');
    const oldSession = runtime.session!;
    const oldId = oldSession.header.sessionId;
    const oldCount = oldSession.events.length;

    // /new 分发（TUI 命令路由同款入口）
    const newCmd = runtime.channels.commands.lookup('new');
    expect(newCmd).toBeDefined();
    newCmd!.handler('');
    expect(runtime.session!.header.sessionId).not.toBe(oldId); // 已切到新会话
    expect(runtime.session!.events.map((e) => e.type)).toEqual(['sandbox/mode']); // 新会话从档位事件起步
    expect(notifies.some((n) => n.includes('已开新会话'))).toBe(true);

    // 新对话落新会话；旧会话对象不再增长（durable 已换指）
    await runtime.conversation!.submitOnce('新问');
    expect(
      runtime.session!.events.some(
        (e) => e.type === 'user/message' && (e.data as { content: string }).content === '新问',
      ),
    ).toBe(true);
    expect(oldSession.events.length).toBe(oldCount);
    // 新会话首快照 reason=initial（header 落账状态已随热切换复位）
    const header = runtime.session!.events.find((e) => e.type === 'request/header')!;
    expect((header.data as { reason: string }).reason).toBe('initial');
  });

  it('run 进行中拒绝热切换：会话不变、通知可见、run 照常结算', async () => {
    // 闸门流：首事件等放行——submitOnce 发出后 run 稳定处于进行中
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answer = textMessage('慢答');
    const streamFn: StreamFn = () => ({
      [Symbol.asyncIterator]() {
        let delivered = false;
        return {
          next: async () => {
            if (delivered) return Promise.resolve({ value: undefined, done: true as const });
            await gate;
            delivered = true;
            return Promise.resolve({
              value: { type: 'done', reason: 'stop', message: answer } as AssistantStreamEvent,
              done: false as const,
            });
          },
        };
      },
      result: async () => answer,
    });
    const runtime = await assemble({ streamFn });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);

    const pending = runtime.conversation!.submitOnce('慢问');
    expect(runtime.conversation!.isRunning).toBe(true); // launch 同步置位——run 已在跑
    runtime.channels.commands.lookup('new')!.handler(''); // 热切换被拒
    expect(notifies.some((n) => n.includes('不能开新会话'))).toBe(true);
    const idBefore = runtime.session!.header.sessionId;

    release();
    const result = await pending;
    expect(result?.status).toBe('completed'); // 拒切换不影响在跑 run
    expect(runtime.session!.header.sessionId).toBe(idBefore); // 会话未变
  });
});

/* ---------------- S3 /app 多会话前台（三动词全栈，契约篇 §5.4） ---------------- */

describe('/app 多会话前台（S3：new 驻留聚焦 / 清单徽标 / 双寻址切换）', () => {
  it('new：开新+驻留+聚焦——旧条目不退役、focus 换指、通知可见', async () => {
    const { streamFn } = scriptedStream([textMessage('旧答')]);
    const runtime = await assemble({ streamFn });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);
    await runtime.conversation!.submitOnce('旧问');
    const oldId = runtime.session!.header.sessionId;

    runtime.channels.commands.lookup('app')!.handler('new');
    const newId = runtime.front.focus.sessionId!;
    expect(newId).toBeDefined();
    expect(newId).not.toBe(oldId); // 聚焦已切新（open 语义含聚焦）
    expect(runtime.drivers.entries.get(oldId)?.retired).toBe(false); // 驻留不退役（与 /new 对照）
    expect(notifies.some((n) => n.startsWith('已开会话'))).toBe(true);
    // 新会话从档位事件起步（空白档——与 /new 新会话同形）；旧会话事件账不动
    expect(runtime.drivers.entries.get(newId)!.session.events.map((e) => e.type)).toEqual(['sandbox/mode']);
    expect(
      runtime.drivers.entries
        .get(oldId)!
        .session.events.some((e) => e.type === 'user/message' && (e.data as { content: string }).content === '旧问'),
    ).toBe(true);
  });

  it('裸调清单徽标如实 + 序号/前缀双寻址切换 + 零命中/越界/停摆各失败形', async () => {
    const { streamFn } = scriptedStream([textMessage('答一')]);
    const runtime = await assemble({ streamFn });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);
    await runtime.conversation!.submitOnce('问一');
    const firstId = runtime.session!.header.sessionId;

    runtime.channels.commands.lookup('app')!.handler('new'); // 开第二个（聚焦后者）
    const secondId = runtime.front.focus.sessionId!;

    // 裸调清单：两条活动、徽标各如实（●聚焦/·空闲）
    notifies.length = 0;
    runtime.channels.commands.lookup('app')!.handler('');
    const listing = notifies.join('\n');
    expect(listing).toContain('活动会话（2）');
    expect(listing).toContain('●聚焦');
    expect(listing).toContain('·空闲');

    // 序号寻址：1 → 切回首会话（序号按当次清单）
    runtime.channels.commands.lookup('app')!.handler('1');
    expect(runtime.front.focus.sessionId).toBe(firstId);
    // 前缀寻址：完整 id 唯一命中 → 切回次会话
    runtime.channels.commands.lookup('app')!.handler(secondId);
    expect(runtime.front.focus.sessionId).toBe(secondId);

    // 零命中前缀 / 越界序号：各自报错、focus 不动
    runtime.channels.commands.lookup('app')!.handler('zzzz-no-such');
    runtime.channels.commands.lookup('app')!.handler('9');
    expect(runtime.front.focus.sessionId).toBe(secondId);
    expect(notifies.some((n) => n.includes('无此会话'))).toBe(true);
    expect(notifies.some((n) => n.includes('无此序号'))).toBe(true);

    // 退役一条后：裸调出现停摆计数行；退役条目退出寻址面（前缀零命中）
    expect(runtime.drivers.retire(firstId)).toBe(true); // 非聚焦非在跑——合法退役
    notifies.length = 0;
    runtime.channels.commands.lookup('app')!.handler('');
    expect(notifies.join('\n')).toContain('已停摆会话');
    runtime.channels.commands.lookup('app')!.handler(firstId); // 已退役 → 不在 active 清单 → 零命中
    expect(runtime.front.focus.sessionId).toBe(secondId); // 未切动
    expect(notifies.some((n) => n.includes('无此会话'))).toBe(true);
    // 退役/查无 false 的程序面（命令层「切换失败」是 list→switchTo 间竞态防御位，
    // 命令面不可确定性触达——契约断言落在 registry 直调）
    expect(runtime.drivers.switchTo(firstId)).toBe(false);
  });
});

/* ---------------- 应用前台入口（第三纵切：boot --app + /app <id> 进入 + delegable） ---------------- */

describe('应用前台入口（第三纵切：boot 打标 / 应用进入 / delegable 自动注册）', () => {
  /** header 快照载荷（request/header 事件 data——组装参数 + app 腿） */
  const headerPayload = (runtime: BerryRuntime): { app?: string } =>
    runtime.session!.events.find((e) => e.type === 'request/header')!.data as never;

  it('boot --app hermes：默认会话即 hermes 域——header app 腿打标（CLI run --app 形态）', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ app: 'hermes', streamFn });
    await runtime.conversation!.submitOnce('问'); // request/header 懒落——首 run 物化
    expect(headerPayload(runtime).app).toBe('hermes');
  });

  it('boot --app 查无：APP_NOT_FOUND 拒启 + message 披露在册清单（自助排错）', async () => {
    // resolveApp 早于装载抛错——无运行时可泄漏，直捕断言（rejects 谓词不重复起装配）
    const err = (await assemble({ app: 'no-such' }).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(APP_NOT_FOUND);
    expect(err.message).toContain('no-such');
    expect(err.message).toContain('chat、hermes'); // 在册清单随错披露
  });

  it('/app <id> [首条消息]：应用进入 + 聚焦切换 + 尾随消息落应用域（chat 域不串）', async () => {
    const { streamFn } = scriptedStream([textMessage('答'), textMessage('答二')]);
    const runtime = await assemble({ streamFn });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);
    await runtime.conversation!.submitOnce('问'); // chat 域先有一条（聚焦在 chat）
    const bootId = runtime.session!.header.sessionId;

    runtime.channels.commands.lookup('app')!.handler('hermes 首条消息');
    const enteredId = runtime.front.focus.sessionId!;
    expect(enteredId).not.toBe(bootId); // 聚焦已切应用域
    expect(notifies.some((n) => n.includes('已进入应用'))).toBe(true);
    // 尾随消息经 submit 走聚焦路由 → 落在应用域会话（与手打同一通道，无专用路径）
    await runtime.conversation!.settle();
    const enteredEvents = runtime.drivers.entries.get(enteredId)!.session.events;
    expect(
      enteredEvents.some((e) => e.type === 'user/message' && (e.data as { content: string }).content === '首条消息'),
    ).toBe(true);
    // chat 域账不动（消息没走错门）
    expect(JSON.stringify(runtime.drivers.entries.get(bootId)!.session.events)).not.toContain('首条消息');
  });

  it('裸调清单披露可用应用行；delegable 应用双注册（provider 表 + agent_<id> 静态工具）', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ streamFn });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);
    runtime.channels.commands.lookup('app')!.handler('');
    // 可用应用披露行（在册且组件齐备——chat/hermes 默认树全在场；缺场应用不披露）
    expect(notifies.join('\n')).toContain('可用应用：chat、hermes');
    // delegable 自动注册（boot 组合根）：hermes 声明 entry.delegable → 双面
    const subagents = runtime.ctx.get<SubagentsServiceFace>('subagents');
    expect(subagents.list().map((info) => info.name)).toContain('hermes');
    expect(runtime.tools.get('agent_hermes')).toBeDefined();
  });
});

/* ---------------- S2 多驱动工具面（组合域分片全栈） ---------------- */

describe('S2 多驱动工具面（组合域分片：双驱动隔离零泄漏 + retire 拆层 + /new 冻结）', () => {
  /** fs 四名（域层恒在 listFor 尾部——chat 件 open 域注册） */
  const FS_NAMES = ['read', 'write', 'edit', 'ls'];

  it('双驱动各域各套 fs：实例隔离（观察表 per-driver 投影）、全局层零泄漏、retire 拆层他域不动、/reload 后活域存续', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ streamFn });
    const entryA = runtime.drivers.focused()!;
    const aId = entryA.session.header.sessionId;
    // 直接 open（不走 /new——不退役 A）：双驱动并存形态（S3 /app 前台切换的目标面）
    const entryB = runtime.drivers.open()!;
    const bId = entryB.session.header.sessionId;
    expect(bId).not.toBe(aId);

    // 两域视角各含 fs 四名；裸 list（全局层）零 fs——域层零泄漏
    const faceA = runtime.tools.listFor(aId);
    const faceB = runtime.tools.listFor(bId);
    expect(faceA.map((t) => t.name).filter((n) => FS_NAMES.includes(n))).toEqual(FS_NAMES);
    expect(faceB.map((t) => t.name).filter((n) => FS_NAMES.includes(n))).toEqual(FS_NAMES);
    expect(runtime.tools.list().some((t) => FS_NAMES.includes(t.name))).toBe(false);
    // 实例隔离：A/B 的 read 是两个 def 实例（观察态 per-driver 的注册面投影——读不过户）
    expect(faceA.find((t) => t.name === 'read')).not.toBe(faceB.find((t) => t.name === 'read'));

    // A retire（退役即停摆的工具面半边）：A 域拆层 fs 消隐、B 面分毫不动
    expect(runtime.drivers.retire(aId)).toBe(true);
    expect(runtime.drivers.entries.get(aId)!.retired).toBe(true);
    expect(runtime.tools.listFor(aId).some((t) => FS_NAMES.includes(t.name))).toBe(false);
    expect(
      runtime.tools
        .listFor(bId)
        .map((t) => t.name)
        .filter((n) => FS_NAMES.includes(n)),
    ).toEqual(FS_NAMES);

    // /reload 后活域存续：注册表本体随 Ring 1 锚不回卷、域层条目挂 DriverEntry
    //（retire 已拆的 A 域不复活；B 域四名齐全）
    const reloaded = await runtime.reload();
    expect(reloaded.payload).toBeDefined();
    expect(
      runtime.tools
        .listFor(bId)
        .map((t) => t.name)
        .filter((n) => FS_NAMES.includes(n)),
    ).toEqual(FS_NAMES);
    expect(runtime.tools.listFor(aId).some((t) => FS_NAMES.includes(t.name))).toBe(false);
  });

  it('/new 冻结：旧条目退役（域拆层、条目保留）、新条目新域新会话起步', async () => {
    const { streamFn } = scriptedStream([textMessage('旧答'), textMessage('新答')]);
    const runtime = await assemble({ streamFn });
    const oldId = runtime.session!.header.sessionId;
    const oldEntry = runtime.drivers.focused()!;

    const newSession = runtime.newSession();
    expect(newSession).toBeDefined();
    const newId = newSession!.header.sessionId;
    expect(newId).not.toBe(oldId);
    // 旧条目：retired 标记在 + 保留在注册表（迟到结算继续落原会话账）
    expect(runtime.drivers.entries.get(oldId)!.retired).toBe(true);
    expect(runtime.drivers.entries.get(oldId)).toBe(oldEntry);
    // 旧域已拆层（「冻结」的工具面半边——退役会话不再 run，工具面消隐防泄漏累积）
    expect(runtime.tools.listFor(oldId).some((t) => FS_NAMES.includes(t.name))).toBe(false);
    // 新域就位：新会话视角 fs 四名齐全 + 聚焦已切新条目
    expect(
      runtime.tools
        .listFor(newId)
        .map((t) => t.name)
        .filter((n) => FS_NAMES.includes(n)),
    ).toEqual(FS_NAMES);
    expect(runtime.drivers.focused()!.session.header.sessionId).toBe(newId);
  });
});

/* ---------------- ⑨b 插件装载（组合树 + 加载器全栈） ---------------- */

/** 写一个目录形态的 fixture 插件（约定入口 index.ts），返回插件目录路径 */
function writePluginDir(compositionDir: string, source: string): string {
  const pluginDir = join(compositionDir, 'my-plugin');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'index.ts'), source);
  return pluginDir;
}

describe('⑨b 插件装载（组合树 + 加载器全栈）', () => {
  it('插件技能提供方 boot 装载即进渐进披露（#17 回归锁——skills_change 接线前必红：装机即隐身）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-skill-')));
    // 物化技能正文（契约篇 §4.4 FS 假设钉死：filePath 必须真实可读——hub 类
    // provider「安装即落盘」的映像），provider 管发现
    const skillDir = join(compositionDir, 'installed-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: plug-probe-skill\ndescription: 插件提供方技能（装载即披露回归锁）。\n---\n\n正文。\n',
    );
    const pluginDir = writePluginDir(
      compositionDir,
      [
        'export const name = "skill-plugin";',
        'export const inject = ["skills"];',
        'export default async function apply(ctx) {',
        '  const skills = ctx.get("skills");',
        '  ctx.effect(() =>',
        '    skills.registerProvider({',
        '      id: "plug-probe",',
        '      list: () => ({',
        '        skills: [{',
        '          name: "plug-probe-skill",',
        '          description: "插件提供方技能（装载即披露回归锁）。",',
        '          content: "正文。",',
        `          filePath: ${JSON.stringify(join(skillDir, 'SKILL.md'))},`,
        `          baseDir: ${JSON.stringify(skillDir)},`,
        '          source: "package",',
        '          disableModelInvocation: false,',
        '        }],',
        '        diagnostics: [],',
        '      }),',
        '    }),',
        '  );',
        '}',
      ].join('\n'),
    );
    writeFileSync(join(compositionDir, 'overlay.yaml'), `rows:\n  - id: skill-plugin\n    plugin: ${pluginDir}\n`);
    const runtime = await assemble({ compositionDir });
    try {
      // 装载后无需 /reload /new：skills_change → rebuildSystemPrompt 即时接线
      expect(runtime.systemPrompt).toContain('<name>plug-probe-skill</name>');
      // 且服务面可取（refresh 已随 rebuild 发生）
      expect(
        runtime.ctx.get<{ get(n: string): { filePath: string } }>('skills').get('plug-probe-skill')?.filePath,
      ).toBe(join(skillDir, 'SKILL.md'));
    } finally {
      await runtime.shutdown();
    }
  });

  it('overlay 插件全栈：工具经 ctx.effect 注册 → 装配后可见可执行；paths/plugins 服务就位', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const pluginDir = writePluginDir(
      compositionDir,
      [
        'export const name = "tool-plugin";',
        'export default async function apply(ctx, config) {',
        '  const tools = ctx.get("tools");',
        '  // 契约篇 §3.2：注册即 effect——apply 回卷时注册随之撤销',
        '  ctx.effect(() =>',
        '    tools.register({',
        '      name: "plug-echo",',
        '      description: "插件注册的回声工具（装载全栈测试）",',
        '      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },',
        '      execute: async (args) => ({ content: [{ type: "text", text: `${config.tag}:${args.text}` }] }),',
        '    }),',
        '  );',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: tool-plugin\n    plugin: ${pluginDir}\n    config:\n      tag: 装载\n`,
    );

    const { streamFn, contexts } = scriptedStream([
      toolCallMessage('plug-echo', { text: '回声' }),
      textMessage('完成'),
    ]);
    const runtime = await assemble({ streamFn, compositionDir });

    // 装载状态面：ctx.plugins 与 runtime.plugins 同源（官方默认层 memory/subagent/
    // goal 三行 + scheduler 第五行 + mcp 第六行 + tools 第七行〔Ring 1 行树化——
    // boot 于 ring1Anchor 装载、状态同面可见〕 + overlay tool-plugin 行均
    // activated——list 状态行序 = 组合树序；applyMs 为装载计时（刀〇a 打点面）
    // 值不定，用 toMatchObject 不断言精确数）
    expect(runtime.plugins.list()).toMatchObject([
      { id: 'chat', status: 'activated', name: 'chat' },
      { id: 'memory', status: 'activated', name: 'memory' },
      { id: 'subagent', status: 'activated', name: 'subagent' },
      { id: 'goal', status: 'activated', name: 'goal' },
      { id: 'scheduler', status: 'activated', name: 'scheduler' },
      { id: 'mcp', status: 'activated', name: 'mcp' },
      { id: 'tools', status: 'activated', name: 'tools' },
      { id: 'web', status: 'activated', name: 'web' },
      { id: 'compaction', status: 'activated', name: 'compaction' },
      { id: 'admin', status: 'activated', name: 'admin' },
      { id: 'tool-plugin', status: 'activated', name: 'tool-plugin' },
    ]);
    expect(runtime.ctx.tryGet<{ list(): unknown[] }>('plugins')).toBeTruthy();
    // 组合树报告带行（官方默认层打底在前）
    expect(runtime.composition.rows.map((row) => row.id)).toEqual([
      'chat',
      'memory',
      'subagent',
      'goal',
      'scheduler',
      'mcp',
      'tools',
      'web',
      'compaction',
      'admin',
      'tool-plugin',
    ]);
    // 插件工具已进注册表（S2：全局层在前 + fs 域层在后——本会话可见面）
    expect(runtime.tools.listFor(runtime.session!.header.sessionId).map((t) => t.name)).toEqual([
      'find',
      'grep',
      'memory_write',
      'memory_forget',
      'memory_restore',
      'memory_read',
      'memory_search',
      'agent',
      'goal_get',
      'goal_set',
      'goal_update',
      'fetch',
      'plugins_list',
      'events_query',
      'plugins_install',
      'plugins_update',
      'plugins_toggle',
      'plugins_configure',
      'plugins_reload',
      'plugins_uninstall_inspect',
      'plug-echo',
      'agent_hermes', // delegable 注册在 ⑨ 装载后——overlay 插件工具之后、fs 域层之前
      'read',
      'write',
      'edit',
      'ls',
      'bash',
    ]);
    // 目录服务：ctx.paths 指向组合树目录、插件数据目录可取（首取即建）
    const paths = runtime.ctx.tryGet<{ dataDir(): string; pluginDataDir(id: string): string }>('paths');
    expect(paths!.dataDir()).toBe(compositionDir);
    expect(paths!.pluginDataDir('tool-plugin')).toBe(join(compositionDir, 'plugins', 'tool-plugin'));

    // 首 run：工具对模型可见（⑨b 注册经 ⑧ 接线原位刷新了 loop 快照）+ 真走三段管道
    await runtime.conversation!.submitOnce('用插件工具');
    expect(contexts[0]?.tools?.map((t) => t.name)).toContain('plug-echo');
    expect(runtime.session!.events.some((e) => e.type === 'tool/result')).toBe(true);
    const projected = deriveMessages(runtime.session!.events);
    expect(projected.map((m) => m.type)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    // 装配期注册的 header：一张 initial、toolSchemas 已含插件工具（快照内容正确）
    const headers = runtime.session!.events.filter((e) => e.type === 'request/header');
    expect(headers).toHaveLength(1);
    expect((headers[0]!.data as { reason: string }).reason).toBe('initial');
    expect((headers[0]!.data as { toolSchemas: Array<{ name: string }> }).toolSchemas.map((t) => t.name)).toContain(
      'plug-echo',
    );
  });

  it('插件提示词段全栈：ctx.effect 注册 registerSection → systemPrompt 含段内容（分节序固定）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const pluginDir = writePluginDir(
      compositionDir,
      [
        'export const name = "prompt-plugin";',
        'export default async function apply(ctx) {',
        '  const prompts = ctx.get("prompts");',
        '  // pi-4(a)：注册即 effect——/reload 回卷锚即注销段（prompts_change 随之广播）',
        '  ctx.effect(() =>',
        '    prompts.registerSection({ id: "demo/notice", render: () => "插件段内容：记住用中文注释" }),',
        '  );',
        '}',
      ].join('\n'),
    );
    writeFileSync(join(compositionDir, 'overlay.yaml'), `rows:\n  - id: prompt-plugin\n    plugin: ${pluginDir}\n`);

    const { streamFn } = scriptedStream([textMessage('收到')]);
    const runtime = await assemble({ streamFn, compositionDir });

    // 段已进 systemPrompt：分节序固定 = 基座 → 技能 → 具名段（段在基座文案之后）
    expect(runtime.systemPrompt).toContain('插件段内容：记住用中文注释');
    expect(runtime.systemPrompt.indexOf('插件段内容：记住用中文注释')).toBeGreaterThan(
      runtime.systemPrompt.indexOf('terminal-based coding assistant'),
    );
    // 段 id 清单面（字典序；memory/core 简报段 + subagent/list 清单段为官方件
    // 注册——memory 空库物化为空串、subagent 单 provider 物化一行清单）
    const prompts = runtime.ctx.get<{ listSections(): string[] }>('prompts');
    // environment = 宿主自留地段（exec 纵切——无 / 单段 id 排插件域段之前，字典序）；
    // instructions = 宿主自留地第二段（尾刀四层发现——工作区无指令文件时物化空串）
    expect(prompts.listSections()).toEqual([
      'demo/notice',
      'environment',
      'instructions',
      'memory/core',
      'subagent/list',
    ]);

    // 首 run 落的 header initial 快照含段内容（模型可见即落日志）
    await runtime.conversation!.submitOnce('看提示词');
    const headers = runtime.session!.events.filter((e) => e.type === 'request/header');
    expect((headers[0]!.data as { systemPrompt: string }).systemPrompt).toContain('插件段内容：记住用中文注释');
  });

  // B-1 回归锁（admin 刀，契约篇 §3.4 落码义务）：chat 件首会话 open() 的
  // systemPrompt 首物化早于 ⑨ 装载收口——无收口补物化时首物化点 plugins.list()
  // 恒空，environment 第五件计数在首请求快照里冻结为「插件 0 行」。锁：initial
  // header 的 systemPrompt 计数必须非零且 activated === total（默认层全激活）。
  // 修前必红验证法：注释掉 boot 收口的 rematerializeAll()（assembly ⑨ 尾）。
  it('boot 装载收口重物化：首 header 的插件计数非零（无收口补物化时恒 0 必红）', async () => {
    const { streamFn } = scriptedStream([textMessage('好')]);
    const runtime = await assemble({ streamFn });
    await runtime.conversation!.submitOnce('问');
    const header = runtime.session!.events.find((e) => e.type === 'request/header');
    const sp = (header!.data as { systemPrompt: string }).systemPrompt;
    const m = /插件 (\d+) 行：activated (\d+)/.exec(sp);
    expect(m).not.toBeNull();
    // total > 0（默认装配 = 十行——修前此处取到 0 即红）；activated === total（默认全激活）
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(Number(m![2])).toBe(Number(m![1]));
  });

  it('context_transform 桥接：插件挂瀑布注入消息 → 模型请求含注入、日志不含（瞬态面）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const pluginDir = writePluginDir(
      compositionDir,
      [
        'export const name = "inject-plugin";',
        'export default async function apply(ctx) {',
        '  // 按需检索注入形态（记忆篇 §6 通道 2）：瀑布收到 (messages, sessionId, next)，',
        '  // 变换后必须调 next 传播且逐参透传（单参调用会丢归属键——S1 双参契约）',
        '  ctx.on("context_transform", (messages, sessionId, next) =>',
        '    next([...messages, { role: "user", content: "【检索注入】用户偏好 pnpm", timestamp: 1 }], sessionId),',
        '  );',
        '}',
      ].join('\n'),
    );
    writeFileSync(join(compositionDir, 'overlay.yaml'), `rows:\n  - id: inject-plugin\n    plugin: ${pluginDir}\n`);

    const { streamFn, contexts } = scriptedStream([textMessage('好的')]);
    const runtime = await assemble({ streamFn, compositionDir });
    await runtime.conversation!.submitOnce('装包');

    // 模型请求含注入消息（桥接生效——loop transformContext → 总线瀑布）
    const flat = contexts[0]!.messages.map((m) => JSON.stringify(m)).join('\n');
    expect(flat).toContain('【检索注入】用户偏好 pnpm');
    // 瞬态面纪律（记忆篇 §6）：注入只进请求不落日志——事件日志无注入文本
    const logText = JSON.stringify(runtime.session!.events);
    expect(logText).not.toContain('【检索注入】');
  });

  it('context_transform 桥钟：插件钩子挂起 → EVENT_HANDLER_TIMEOUT、run 按失败收尾（§1.6 时钟族，刀〇a）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const pluginDir = writePluginDir(
      compositionDir,
      [
        'export const name = "hang-transform";',
        'export default async function apply(ctx) {',
        '  // 挂起转化条款目标形态（契约篇 §1.6）：进瀑布后永不调 next 也不返回——',
        '  // 挂起与抛错同族，整链竞速桥钟后按故障收尾',
        '  ctx.on("context_transform", () => new Promise(() => {}));',
        '}',
      ].join('\n'),
    );
    writeFileSync(join(compositionDir, 'overlay.yaml'), `rows:\n  - id: hang-transform\n    plugin: ${pluginDir}\n`);

    const { streamFn } = scriptedStream([textMessage('到不了的回答')]);
    // transformTimeoutMs 小钟（30ms）：生产缺省 5s——测试不等真钟
    const runtime = await assemble({ streamFn, compositionDir, transformTimeoutMs: 30 });
    const result = await runtime.conversation!.submitOnce('会挂起的问题');

    // loop 零 try/catch 纪律：钩子超时沿 transformContext 上抛进 runTurns 统一 catch
    expect(result?.status).toBe('failed');
    // 码进文本（describeError 统一口径 [CODE] 前缀——杜绝 app 兜底吞码）
    expect(result?.errorMessage).toContain('[EVENT_HANDLER_TIMEOUT]');
  });

  it('插件启动断言：失败行非空 → 工厂抛 PLUGIN_LOAD_FAILED 聚合清单（不带病运行）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const pluginDir = writePluginDir(compositionDir, 'export const name = "bad";\nexport default 42;\n');
    writeFileSync(join(compositionDir, 'overlay.yaml'), `rows:\n  - id: bad\n    plugin: ${pluginDir}\n`);

    // 不经 assemble 登记（工厂抛出即无 runtime 可关停）
    const attempt = createBerryRuntime({
      dbPath: ':memory:',
      workspace: makeWorkspace(),
      compositionDir,
    });
    await expect(attempt).rejects.toMatchObject({ code: PLUGIN_LOAD_FAILED });
    await expect(attempt).rejects.toThrowError(/bad/); // 行 id 进聚合清单（归因）
  });

  it('dump-config 失败路径：打印合成树 + 失败清单退出码 1；空树成功路径退出码 0', async () => {
    const badDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const pluginDir = writePluginDir(badDir, 'export const name = "bad";\nexport default 42;\n');
    writeFileSync(join(badDir, 'overlay.yaml'), `rows:\n  - id: bad\n    plugin: ${pluginDir}\n`);
    // 不传 persist——:memory: 全装配同构（P0-3）：显式 persist:false 会绕开持久层
    // 全真跑，正是诊断面要禁的侧门（P0-3 批主请求，2026-08-26）
    expect(await dumpConfigMain({ compositionDir: badDir })).toBe(1);

    const emptyDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    expect(await dumpConfigMain({ compositionDir: emptyDir })).toBe(0);
  });

  it('dump-config 主库零落盘（P0-3 回归锁）：:memory: 全装配后数据目录无任何 SQLite 库文件', async () => {
    // 钉独立数据目录（dumpConfigMain 不收 dataDir 参数——路径面统一走 APP_DATA_DIR
    // env，与生产同构）；finally 还原，防污染真实 ~/.berry 与兄弟用例
    const dataRoot = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-dump-')));
    const prev = process.env['APP_DATA_DIR'];
    process.env['APP_DATA_DIR'] = dataRoot;
    try {
      expect(await dumpConfigMain({})).toBe(0);
      // 全装配真跑过（装载器执法/config 校验/Kahn 激活全在内存库上执行）……
      // 而磁盘数据目录里任何形态的 SQLite 库文件都不存在（主库零落盘——
      // 目录创建类副作用被容忍，库文件写入不允许）
      const leftBehind = readdirSync(dataRoot).filter((f) => /\.db(-wal|-shm)?$/i.test(f));
      expect(leftBehind).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env['APP_DATA_DIR'];
      else process.env['APP_DATA_DIR'] = prev;
    }
  });
});

/* ---------------- /reload 组合树重载（M2 纵切收口） ---------------- */

/** 版本化插件源：工具执行回显 `<版本标记>:<入参>`——同路径改码后 reload 应换版本（jiti 驱逐） */
function versionedPluginSource(mark: string): string {
  return [
    `export const name = "tool-plugin";`,
    `const MARK = ${JSON.stringify(mark)};`,
    `export default async function apply(ctx) {`,
    `  const tools = ctx.get("tools");`,
    `  ctx.effect(() =>`,
    `    tools.register({`,
    `      name: "plug-echo",`,
    `      description: "版本化回声工具（reload 驱逐纪律测试）",`,
    `      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },`,
    `      execute: async (args) => ({ content: [{ type: "text", text: \`\${MARK}:\${args.text}\` }] }),`,
    `    }),`,
    `  );`,
    `}`,
  ].join('\n');
}

/** 取最近一次工具调用的投影回显文本（plug-echo 回声） */
function lastEchoText(runtime: BerryRuntime): string {
  const toolResults = deriveMessages(runtime.session!.events).filter((m) => m.type === 'toolResult');
  const last = toolResults.at(-1)!;
  // 投影条目载荷经 convert 合成——content 文本在 message 字段族里，直接断整段 JSON 太脆，
  // 取 block 化文本（toolResult 投影含 content blocks）
  return JSON.stringify(last);
}

describe('/reload 组合树重载', () => {
  it('jiti 驱逐纪律全栈：同路径改码 → reload → 新代码生效（moduleCache:false 不吃旧模块）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-reload-')));
    const pluginDir = writePluginDir(compositionDir, versionedPluginSource('v1'));
    writeFileSync(join(compositionDir, 'overlay.yaml'), `rows:\n  - id: tool-plugin\n    plugin: ${pluginDir}\n`);
    // 脚本两轮齐全：每轮 toolCall+text（scriptedStream 只前进不回绕——缺项会钳在末条）
    const { streamFn } = scriptedStream([
      toolCallMessage('plug-echo', { text: '回声' }),
      textMessage('完成'),
      toolCallMessage('plug-echo', { text: '回声' }),
      textMessage('完成'),
    ]);
    const runtime = await assemble({ streamFn, compositionDir });
    // composition/reloaded 观察哨（root ctx 订阅——reload 只 dispose 插件锚，哨不动）
    const reloadedPayloads: unknown[] = [];
    runtime.ctx.on('composition/reloaded', (payload: unknown) => {
      reloadedPayloads.push(payload);
    });

    await runtime.conversation!.submitOnce('第一问');
    expect(lastEchoText(runtime)).toContain('v1:回声');

    // 同路径改码（版本标记换 v2）→ reload → 激活行照旧、代码是新求值的
    //（memory/subagent 为官方默认层两行，每次 reload 照常激活——恒在）
    writeFileSync(join(pluginDir, 'index.ts'), versionedPluginSource('v2'));
    const result = await runtime.reload();
    expect(result.payload).toEqual({
      activated: [
        'chat',
        'memory',
        'subagent',
        'goal',
        'scheduler',
        'mcp',
        'web',
        'compaction',
        'admin',
        'tool-plugin',
      ],
      failed: [],
      skipped: [],
    });
    expect(reloadedPayloads).toEqual([
      {
        activated: [
          'chat',
          'memory',
          'subagent',
          'goal',
          'scheduler',
          'mcp',
          'web',
          'compaction',
          'admin',
          'tool-plugin',
        ],
        failed: [],
        skipped: [],
      },
    ]);

    await runtime.conversation!.submitOnce('第二问');
    expect(lastEchoText(runtime)).toContain('v2:回声'); // 新代码已生效
    // plugins 服务同实例就地更新（§1.3 服务集恒定——reload 前后 ctx 拿到同一个）
    expect(runtime.ctx.tryGet('plugins')).toBe(runtime.plugins);
  });

  it('禁用行 reload：工具摘除 + writeHeader 落 change 快照 + loop 快照同步刷新', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-reload-')));
    const pluginDir = writePluginDir(compositionDir, versionedPluginSource('v1'));
    writeFileSync(join(compositionDir, 'overlay.yaml'), `rows:\n  - id: tool-plugin\n    plugin: ${pluginDir}\n`);
    const { streamFn, contexts } = scriptedStream([textMessage('首答'), textMessage('纯文本应答')]);
    const runtime = await assemble({ streamFn, compositionDir });
    expect(runtime.tools.list().map((t) => t.name)).toContain('plug-echo');
    // 首请求先落 initial（装载窗口语义：首张 header 由首 run 落——reload 的
    // change 快照才有 diff 基线）
    await runtime.conversation!.submitOnce('首问');

    // overlay 置 disabled → reload → 行变 skipped、工具摘除
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: tool-plugin\n    plugin: ${pluginDir}\n    disabled: true\n`,
    );
    const result = await runtime.reload();
    expect(result.payload).toEqual({
      activated: ['chat', 'memory', 'subagent', 'goal', 'scheduler', 'mcp', 'web', 'compaction', 'admin'],
      failed: [],
      skipped: ['tool-plugin'],
    });
    // 插件工具已摘除（memory 五件 + agent 为默认装配成员——不受 overlay 禁用影响）。
    // S2：fs 域层挂活驱动 DriverEntry——跨 /reload 存续（本会话可见面照旧含 fs 四件）。
    // agent_hermes 前移到 grep 后：/reload 重装载插件工具重新追加在其后（Map 注册
    // 序——幸存者在前），delegable 注册只在 boot、跨 /reload 存续（应用注册表不动）
    expect(runtime.tools.listFor(runtime.session!.header.sessionId).map((t) => t.name)).toEqual([
      'find',
      'grep',
      'agent_hermes',
      'memory_write',
      'memory_forget',
      'memory_restore',
      'memory_read',
      'memory_search',
      'agent',
      'goal_get',
      'goal_set',
      'goal_update',
      'fetch',
      'plugins_list',
      'events_query',
      'plugins_install',
      'plugins_update',
      'plugins_toggle',
      'plugins_configure',
      'plugins_reload',
      'plugins_uninstall_inspect',
      'read',
      'write',
      'edit',
      'ls',
      'bash',
    ]);
    expect(runtime.plugins.list().map((r) => [r.id, r.status])).toEqual([
      ['chat', 'activated'],
      ['memory', 'activated'],
      ['subagent', 'activated'],
      ['goal', 'activated'],
      ['scheduler', 'activated'],
      ['mcp', 'activated'],
      ['tools', 'activated'],
      ['web', 'activated'],
      ['compaction', 'activated'],
      ['admin', 'activated'],
      ['tool-plugin', 'skipped'],
    ]);

    // tools_change 即时刷新：后续 run 的模型可见工具集已无插件工具
    await runtime.conversation!.submitOnce('再问');
    expect(contexts.at(-1)?.tools?.map((t) => t.name)).not.toContain('plug-echo');

    // header 内建 diff：工具面变了 → 第二张快照 reason=change 且不含插件工具
    const headers = runtime.session!.events.filter((e) => e.type === 'request/header');
    expect(headers).toHaveLength(2);
    expect((headers[1]!.data as { reason: string }).reason).toBe('change');
    expect((headers[1]!.data as { toolSchemas: Array<{ name: string }> }).toolSchemas.map((t) => t.name)).not.toContain(
      'plug-echo',
    );
  });

  it('失败行两面语义的 reload 半边：逐行报告、进程存活、成功行照常运行', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-reload-')));
    const pluginDir = writePluginDir(compositionDir, versionedPluginSource('v1'));
    writeFileSync(join(compositionDir, 'overlay.yaml'), `rows:\n  - id: tool-plugin\n    plugin: ${pluginDir}\n`);
    const { streamFn } = scriptedStream([textMessage('活着')]);
    const runtime = await assemble({ streamFn, compositionDir });

    // overlay 加坏行（default 42 非 apply 函数 → 形状失败）→ reload 不抛、两态并报
    const badDir = join(compositionDir, 'bad-plugin');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'index.ts'), 'export const name = "bad";\nexport default 42;\n');
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: tool-plugin\n    plugin: ${pluginDir}\n  - id: bad\n    plugin: ${badDir}\n`,
    );
    const result = await runtime.reload();
    expect(result.error).toBeUndefined();
    expect(result.payload?.activated).toEqual([
      'chat',
      'memory',
      'subagent',
      'goal',
      'scheduler',
      'mcp',
      'web',
      'compaction',
      'admin',
      'tool-plugin',
    ]);
    expect(result.payload?.failed).toEqual(['bad']);
    // 状态面：失败行带着错误码可见（「没生效」不静默）
    const badRow = runtime.plugins.list().find((r) => r.id === 'bad')!;
    expect(badRow.status).toBe('failed');
    expect(badRow.code).toMatch(/^PLUGIN_/);
    expect(runtime.tools.list().map((t) => t.name)).toContain('plug-echo'); // 成功行照常
    // 进程存活：会话还能继续跑
    const answer = await runtime.conversation!.submitOnce('还活着吗');
    expect(answer?.status).toBe('completed');
  });

  it('overlay 树坏：error 面、原装配纹丝不动（预检后拆——旧锚不可逆动作先验）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-reload-')));
    const pluginDir = writePluginDir(compositionDir, versionedPluginSource('v1'));
    writeFileSync(join(compositionDir, 'overlay.yaml'), `rows:\n  - id: tool-plugin\n    plugin: ${pluginDir}\n`);
    const runtime = await assemble({ compositionDir });
    const rowsBefore = runtime.composition.rows;

    // 未知字段 → 拒绝式校验抛 COMPOSITION_ROW_INVALID；reload 返回 error 不动旧装配
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: tool-plugin\n    plugin: ${pluginDir}\n    bogus: 未知字段\n`,
    );
    const result = await runtime.reload();
    expect(result.error).toBeDefined();
    expect(result.payload).toBeUndefined();
    expect(runtime.tools.list().map((t) => t.name)).toContain('plug-echo'); // 旧工具仍在
    expect(runtime.composition.rows).toEqual(rowsBefore); // 树报告未换
  });

  it('run 进行中排队重载（刀 2：结算后自动排水；串行链防双装载竞态）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-reload-')));
    const pluginDir = writePluginDir(compositionDir, versionedPluginSource('v1'));
    writeFileSync(join(compositionDir, 'overlay.yaml'), `rows:\n  - id: tool-plugin\n    plugin: ${pluginDir}\n`);
    // 闸门流：首事件等放行——submitOnce 发出后 run 稳定处于进行中
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answer = textMessage('慢答');
    const streamFn: StreamFn = () => ({
      [Symbol.asyncIterator]() {
        let delivered = false;
        return {
          next: async () => {
            if (delivered) return Promise.resolve({ value: undefined, done: true as const });
            await gate;
            delivered = true;
            return Promise.resolve({
              value: { type: 'done', reason: 'stop', message: answer } as AssistantStreamEvent,
              done: false as const,
            });
          },
        };
      },
      result: async () => answer,
    });
    const runtime = await assemble({ streamFn, compositionDir });

    const pending = runtime.conversation!.submitOnce('慢问');
    expect(runtime.conversation!.isRunning).toBe(true);
    expect(await runtime.reload()).toEqual({ queued: true }); // run 中排队（刀 2：不再拒绝）

    release();
    await pending;
    // run 结算回调自动排水排队的 reload（串行链在其后）——显式再 reload 拿同款载荷
    expect((await runtime.reload()).payload).toEqual({
      activated: [
        'chat',
        'memory',
        'subagent',
        'goal',
        'scheduler',
        'mcp',
        'web',
        'compaction',
        'admin',
        'tool-plugin',
      ],
      failed: [],
      skipped: [],
    }); // run 结束后放行
  });

  it('命令薄壳链全栈：/plugins 清单 + /plugin-toggle 链 reload + /plugin-install（local 源零子进程）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-reload-')));
    const pluginDir = writePluginDir(compositionDir, versionedPluginSource('v1'));
    writeFileSync(join(compositionDir, 'overlay.yaml'), `rows:\n  - id: tool-plugin\n    plugin: ${pluginDir}\n`);
    const { streamFn } = scriptedStream([textMessage('好')]);
    const runtime = await assemble({ streamFn, compositionDir });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);

    // /plugins：状态行可见
    expect(await runtime.channels.commands.dispatch('/plugins')).toBe('ok');
    expect(notifies.some((n) => n.includes('tool-plugin') && n.includes('✓'))).toBe(true);

    // /plugin-toggle：翻转 + 自动链 reload（对账与组合正交——壳负责串两步）
    expect(await runtime.channels.commands.dispatch('/plugin-toggle tool-plugin')).toBe('ok');
    expect(notifies.some((n) => n.includes('已禁用'))).toBe(true);
    expect(notifies.some((n) => n.includes('组合已重载'))).toBe(true);
    expect(runtime.tools.list().map((t) => t.name)).not.toContain('plug-echo');

    // /plugin-install local 源（零子进程）：对账写回 + 链 reload → 新工具可见
    const twinDir = join(compositionDir, 'twin-plugin');
    mkdirSync(twinDir, { recursive: true });
    writeFileSync(
      join(twinDir, 'index.ts'),
      [
        'export const name = "twin";',
        'export default async function apply(ctx) {',
        '  const tools = ctx.get("tools");',
        '  ctx.effect(() =>',
        '    tools.register({',
        '      name: "plug-twin",',
        '      description: "第二件插件工具（install→reload 链测试）",',
        '      parameters: { type: "object", properties: {} },',
        '      execute: async () => ({ content: [{ type: "text", text: "twin" }] }),',
        '    }),',
        '  );',
        '}',
      ].join('\n'),
    );
    expect(await runtime.channels.commands.dispatch(`/plugin-install ${twinDir}`)).toBe('ok');
    expect(notifies.some((n) => n.includes('已装入') && n.includes('local'))).toBe(true);
    expect(runtime.tools.list().map((t) => t.name)).toContain('plug-twin');
    expect(runtime.plugins.list().map((r) => [r.id, r.status])).toEqual([
      ['chat', 'activated'],
      ['memory', 'activated'],
      ['subagent', 'activated'],
      ['goal', 'activated'],
      ['scheduler', 'activated'],
      ['mcp', 'activated'],
      ['tools', 'activated'],
      ['web', 'activated'],
      ['compaction', 'activated'],
      ['admin', 'activated'],
      ['tool-plugin', 'skipped'],
      ['twin-plugin', 'activated'],
    ]);
  });
});

/* ---------------- Ring 1 行树化（tools 第七行——契约篇 §5.1 节奏表落码） ---------------- */

describe('Ring 1 行树化：启动断言第二断言类 + /reload 报告语义', () => {
  it('boot 拒启：overlay 禁用 tools 行 → COMPOSITION_ROW_INVALID 聚合清单（拒启先收尾持久层再回卷）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-ring1-')));
    writeFileSync(join(compositionDir, 'overlay.yaml'), 'rows:\n  - id: tools\n    disabled: true\n');
    const { streamFn } = scriptedStream([textMessage('不会到这')]);
    // 拒启面手动 try/catch（assemble 助手只登记成功面——失败面无 runtimes 可收）
    const err = await createBerryRuntime({
      dbPath: ':memory:',
      workspace: makeWorkspace(),
      compositionDir,
      streamFn,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(COMPOSITION_ROW_INVALID);
    expect((err as AppError).message).toContain('Ring 1 必备行断言失败');
    expect((err as AppError).message).toContain('tools');
    expect((err as AppError).message).toContain('替换行引用'); // 拒启事实带修法指引
  });

  it('/reload Ring 1 行变更：载荷报告 ring1RestartRequired + tools 服务不回卷（同实例同工具面）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-ring1-reload-')));
    const { streamFn } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ streamFn, compositionDir });
    const toolsBefore = runtime.ctx.get<{}>('tools');
    const namesBefore = runtime.tools.list().map((t) => t.name);
    const reloadedPayloads: unknown[] = [];
    runtime.ctx.on('composition/reloaded', (payload: unknown) => {
      reloadedPayloads.push(payload);
    });

    // overlay 给 tools 行加 config——行合成字段变化（Ring 1 行仅 boot 生效）
    writeFileSync(join(compositionDir, 'overlay.yaml'), 'rows:\n  - id: tools\n    config: { maxBytes: 1 }\n');
    const result = await runtime.reload();

    // 报告面：ring1RestartRequired 点名 tools；activated 清单不含 tools（Ring 2 重装载面）
    expect(result.payload).toMatchObject({ ring1RestartRequired: ['tools'] });
    expect(result.payload?.activated).not.toContain('tools');
    expect(reloadedPayloads).toEqual([
      {
        activated: ['chat', 'memory', 'subagent', 'goal', 'scheduler', 'mcp', 'web', 'compaction', 'admin'],
        failed: [],
        skipped: [],
        ring1RestartRequired: ['tools'],
      },
    ]);
    // 不回卷语义：ring1Anchor 不在 reload dispose 面——tools 服务同一实例、工具面原样。
    // 序不敏感比对（sort 双侧）：/reload 重装载使插件工具重注册到 agent_hermes
    // 之后（Map 注册序漂移），工具面集合不变才是本断言的本体
    expect(runtime.ctx.get('tools')).toBe(toolsBefore);
    expect([...runtime.tools.list().map((t) => t.name)].sort()).toEqual([...namesBefore].sort());
    // 行状态面：tools 行仍 activated（沿用 boot 装载结果 = 运行时真值）
    expect(runtime.plugins.list().find((r) => r.id === 'tools')).toMatchObject({ status: 'activated' });
  });

  it('对照面：/reload 无 Ring 1 行变更 → 载荷不带 ring1RestartRequired 字段（不虚报）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-ring1-noop-')));
    const pluginDir = writePluginDir(compositionDir, versionedPluginSource('v1'));
    writeFileSync(join(compositionDir, 'overlay.yaml'), `rows:\n  - id: tool-plugin\n    plugin: ${pluginDir}\n`);
    const { streamFn } = scriptedStream([textMessage('答'), textMessage('答')]);
    const runtime = await assemble({ streamFn, compositionDir });
    const reloadedPayloads: unknown[] = [];
    runtime.ctx.on('composition/reloaded', (payload: unknown) => {
      reloadedPayloads.push(payload);
    });

    const result = await runtime.reload();
    expect('ring1RestartRequired' in (result.payload ?? {})).toBe(false);
    expect(reloadedPayloads[0]).not.toHaveProperty('ring1RestartRequired');
  });
});

/* ---------------- subagent 结算通知全栈（纵切三） ---------------- */

describe('subagent 结算通知全栈（④d 接线 → 折叠 + 通知 + 续跑）', () => {
  /** 可控结算的 stub provider（provider 即模型层等价物——全栈其余全真） */
  function controllableProvider(name: string): {
    provider: SubagentProvider;
    settleWith(result: SubagentResult): void;
  } {
    let settleWith: (result: SubagentResult) => void = () => {};
    const result = new Promise<SubagentResult>((resolve) => (settleWith = resolve));
    const provider: SubagentProvider = {
      name,
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      start(request) {
        return { id: `${name}-run`, result, dispose: () => undefined };
      },
    };
    return { provider, settleWith };
  }

  it('后台结算：llm/usage 折叠落账 + source=subagent-settled 通知唤醒续跑（第二个模型调用可见通知）', async () => {
    const { streamFn, contexts } = scriptedStream([textMessage('答一'), textMessage('答二')]);
    const runtime = await assemble({ streamFn });
    const { provider, settleWith } = controllableProvider('stub-sub');
    const subagents = runtime.ctx.get<SubagentsServiceFace>('subagents');
    subagents.register(provider);

    await runtime.conversation!.submitOnce('首问');
    const sessionId = runtime.session!.header.sessionId;
    expect(contexts).toHaveLength(1);

    // 后台委派（owner = 当前会话）→ 结算（带用量）
    const run = subagents.start({
      provider: 'stub-sub',
      prompt: '审读代码',
      label: '委派-审读',
      ownerSessionId: sessionId,
      background: true,
    });
    settleWith({
      output: '审毕',
      stopReason: 'completed',
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
    });
    await expect(run.job!.done).resolves.toBe('completed');

    // 通知 followUp 唤醒：第二个模型调用已发生，末条 user 消息即通知（归因在上下文里不丢）
    await runtime.conversation!.settle();
    expect(contexts).toHaveLength(2);
    const lastUser = contexts[1]!.messages.at(-1) as { role: string; source?: string; content: string };
    expect(lastUser.role).toBe('user');
    expect(lastUser.source).toBe('subagent-settled');
    expect(lastUser.content).toContain('委派-审读');

    // durable 双事件：llm/usage 折叠（background 道，callId = 子运行 id）+ user/message 带归因。
    // 底账统一（契约篇 §5.4）：主循环 turn 先自折 foreground 道，结算再折 background 道——
    // 两道并存不冲突，find 只认 background 的折叠才是结算产物
    const usageEvents = runtime.session!.events.filter((e) => e.type === 'llm/usage');
    const foreground = usageEvents.find((e) => (e.data as { priority: string }).priority === 'foreground');
    expect(foreground?.data).toMatchObject({
      callId: expect.stringMatching(/^turn:/),
      priority: 'foreground',
      usage: { input: NO_USAGE.input, output: NO_USAGE.output },
    });
    const background = usageEvents.find((e) => (e.data as { priority: string }).priority === 'background');
    expect(background?.data).toEqual({
      callId: 'stub-sub-run',
      model: expect.any(String),
      priority: 'background',
      usage: { input: 100, output: 50 },
    });
    const notice = runtime.session!.events.find(
      (e) => e.type === 'user/message' && (e.data as { source?: string }).source === 'subagent-settled',
    );
    expect(notice).toBeDefined();
    expect((notice!.data as { content: string }).content).toContain('委派-审读');
  });

  it('/new 热切换发 session_start 活体事件（origin=initial，载荷带新会话 id）', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ streamFn });
    await runtime.conversation!.submitOnce('问');
    /** 活体事件采集（ctx.on——装配期 emit 先于测试订阅，/new 半边可观测） */
    const starts: { sessionId?: string; origin?: string }[] = [];
    runtime.ctx.on('session_start', (data) => starts.push(data as { sessionId?: string; origin?: string }));
    runtime.channels.commands.lookup('new')!.handler('');
    expect(starts).toHaveLength(1);
    expect(starts[0]!.sessionId).toBe(runtime.session!.header.sessionId);
    expect(starts[0]!.origin).toBe('initial');
  });
});

describe('web 件全栈（默认层第八行：fetch 工具 + ctx.fetch 服务同一管道）', () => {
  it('模型面工具在册 + 服务面经真三段管道落 gate/decision 账 + caller 归因进 durable', async () => {
    // 外部边界注入（webOverrides → builtins → 件构造缝）：fetch/lookup 假实现，
    // 管道/守门/落账/组合树全真——mock 只停在出网边界
    const runtime = await assemble({
      webOverrides: {
        fetchImpl: async () => new Response('全栈正文', { status: 200, headers: { 'content-type': 'text/plain' } }),
        lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      },
    });
    // 模型面：默认层第八行 web 件注册 fetch 工具（进模型词汇表）
    expect(runtime.tools.list().map((t) => t.name)).toContain('fetch');
    // 服务面：ctx.fetch 走真管道（守门决议 durable 落账——「不旁路」的组合根证据）
    const service = runtime.ctx.get<{
      fetch(url: string, opts?: { caller?: string }): Promise<{ status: number; text: string }>;
    }>('fetch');
    const result = await service.fetch('https://ok.example/x', { caller: 'probe-plugin' });
    expect(result.status).toBe(200);
    expect(result.text).toBe('全栈正文');
    const gateEvents = (runtime.session?.events ?? []).filter((e) => e.type === 'gate/decision');
    expect(gateEvents).toHaveLength(1);
    expect((gateEvents[0]!.data as { toolCallId?: string }).toolCallId).toMatch(/^fetch-/);
    expect((gateEvents[0]!.data as { decision?: string }).decision).toBe('allow');
  });
});

/* ---------------- S6 关停序：abort-all + quiesce 断言（形态⑤） ---------------- */

/** 挂起流：start 后挂起直到 abort（abort → error{aborted} 终止事件；result 带 abort 编码） */
function pendingAbortStream(): { streamFn: StreamFn } {
  const message = textMessage('慢答');
  const streamFn: StreamFn = (_context: LlmContext, _options: StreamFnOptions, signal?: AbortSignal) => ({
    [Symbol.asyncIterator]() {
      let at = 0;
      const events = [{ type: 'start' as const, partial: { ...message, content: [] } }];
      return {
        next: async () => {
          if (at < events.length) return { value: events[at++]!, done: false as const };
          // 挂起直到 abort（loop 把 hooks.signal 透传为第三位参数）——已 abort
          // 短路先判（signal 事件只发一次，事后挂监听收不到）
          if (signal?.aborted) return abortEventOf(message);
          await new Promise((resolve) => {
            signal?.addEventListener('abort', resolve, { once: true });
          });
          return abortEventOf(message);
        },
      };
    },
    // result() 契约（loop 收口以它为准）：abort 编码进返回消息的 stopReason
    result: async () => (signal?.aborted ? { ...message, stopReason: 'aborted' } : message),
  });
  return { streamFn };
}

/** abort 终止事件（error 流事件编码 reason:'aborted'——loop 终值映射 aborted 的输入形） */
const abortEventOf = (message: AssistantMessage) => ({
  value: {
    type: 'error' as const,
    reason: 'aborted' as const,
    error: { ...message, stopReason: 'aborted' as const },
  },
  done: false as const,
});

describe('S6 关停序（abort-all / quiesce 断言——骨架篇 §1.3 S6 形态⑤）', () => {
  it('直接 shutdown（不经 requestQuit 前置扇出）：abort-all 打断在飞 run 不挂死', async () => {
    const { streamFn } = pendingAbortStream();
    const runtime = await assemble({ streamFn });
    const conversation = runtime.conversation!;
    void conversation.submitOnce('慢问'); // fire-and-forget 开跑（run 结果走事件流）
    // 微任务自旋等 run 真在飞（挂起流已开）
    for (let i = 0; i < 200 && !conversation.isRunning; i += 1) await Promise.resolve();
    expect(conversation.isRunning).toBe(true);

    // 直接关停（测试收尾/fatal 路后续的形态——无 requestQuit 前置扇出）：修复前
    // shutdown 的 settle 等挂起流永不到来 → 本测试超时红；修复后 abort-all
    // （开头全条目 driver.retire 仅 abort）打断在飞轮，关停序列正常走完
    await runtime.shutdown();
    expect(conversation.isRunning).toBe(false);
  });

  it('quiesce 断言：全 settle 后仍有非退役驱动 isRunning → shutdown 拒进 flush（APP_SHUTDOWN_QUIESCE_VIOLATED）', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ streamFn });
    // 塞假活条目（模拟「settle 与 running 复位配对被破」的写点漂移——isRunning
    // 恒 true 的假驱动；形状补全 controls/注销器 no-op——quiesce 拒绝路径的
    // finally ctx 回卷会触发变更监听遍历条目，缺面即隔离日志噪音）
    const fakeId = 'fake-session-quiesce';
    const fakeEntry = {
      session: { header: { sessionId: fakeId } },
      driver: { isRunning: true, retire: () => {}, settle: () => Promise.resolve() },
      controls: { refreshTools: () => {}, rematerialize: () => {}, writeHeader: () => {} },
      disposeDomainTools: () => {},
      disposeScope: () => {},
      resumed: false,
      durable: { handle: () => {} },
      headerState: { next: 'initial' },
      retired: false,
    } as never;
    (runtime.drivers.entries as Map<string, never>).set(fakeId, fakeEntry);

    try {
      // 断言是防不是治：拒进 flush（防「flush 时仍有在写者」撕裂尾）——AppError 携码
      await expect(runtime.shutdown()).rejects.toMatchObject({ code: APP_SHUTDOWN_QUIESCE_VIOLATED });
    } finally {
      // 恢复现场：afterEach 的兜底关停不再撞假条目（正常走完）
      (runtime.drivers.entries as Map<string, never>).delete(fakeId);
    }
  });
});

/* ---------------- 会话写入面 v2（会话篇 §5.1/§5.2，2026-08-27 P1-1） ---------------- */

/** 导入面服务子集（结构子集接口——消费件同款取用法） */
interface SessionsSpawnFace {
  createSession(opts: { seed: readonly SessionEvent[] }): Promise<string>;
  fork(boundary?: number): Promise<string | undefined>;
}

/** 合法最小种子（闭合 turn + 核心词——导入流天然形态） */
function closedSeed(): SessionEvent[] {
  return [
    Object.freeze({ type: 'turn/start', seq: 0, time: 1_000, data: Object.freeze({}) }),
    Object.freeze({
      type: 'user/message',
      seq: 1,
      time: 1_001,
      data: Object.freeze({ content: '导入的第一句', source: 'import' }),
    }),
    Object.freeze({ type: 'turn/end', seq: 2, time: 1_002, data: Object.freeze({}) }),
  ];
}

/** 物理库 sessions 行直读（origin/importer/cwd/app 归因断言） */
function sessionRowOf(
  runtime: BerryRuntime,
  sessionId: string,
): { origin: string; importer: string | null; cwd: string | null; app: string | null } {
  return runtime
    .persistence!.store.connection.prepare('SELECT origin, importer, cwd, app FROM sessions WHERE id = ?')
    .get(sessionId) as { origin: string; importer: string | null; cwd: string | null; app: string | null };
}

describe('createSession 导入面（origin=import 钉死 + 四道卫生闸 + durable 承诺）', () => {
  it('全链：origin/importer 落行、种子物理落库可收养（loadSession 命中——非幻影 id）', async () => {
    const runtime = await assemble();
    const sessions = runtime.ctx.tryGet<SessionsSpawnFace>('sessions')!;
    const id = await sessions.createSession({ seed: closedSeed() });

    // origin='import' 钉死 + 无链调用 importer='host' 兜底 + cwd/app 继承前台会话
    const row = sessionRowOf(runtime, id);
    expect(row.origin).toBe('import');
    expect(row.importer).toBe('host');
    expect(row.cwd).toBe(runtime.workspace);
    // durable 承诺：物理事件全量在库（非幻影 id——收养路径 loadSession 命中）
    const loaded = runtime.persistence!.loadSession(id);
    expect(loaded).toBeTruthy();
    expect(loaded!.events.map((e) => e.type)).toEqual(['turn/start', 'user/message', 'turn/end']);
    // 读回走 queryEvents 同账（读面不排除导入会话）
    const query = await runtime.ctx.tryGet<{
      queryEvents(q: {
        sessionIds?: string[];
        types?: string[];
        sinceMs?: number;
        limit?: number;
      }): Promise<{ rows: unknown[] }>;
    }>('sessions')!;
    const result = await query.queryEvents({ sessionIds: [id], limit: 10 });
    expect(result.rows.length).toBe(3);
  });

  it('caller 归因：链上调用 importer=链身份（装载器/工具管道两写点的读点取数）', async () => {
    const runtime = await assemble();
    const sessions = runtime.ctx.tryGet<SessionsSpawnFace>('sessions')!;
    const id = await runInCallerChain('fx-migrator', () => sessions.createSession({ seed: closedSeed() }));
    expect(sessionRowOf(runtime, id).importer).toBe('fx-migrator');
  });

  it('persist:false 诊断装配 = durable 承诺物理不可履行，响亮拒绝（不返回空转 id）', async () => {
    const bare = await assemble({ persist: false });
    const sessions = bare.ctx.tryGet<SessionsSpawnFace>('sessions')!;
    await expect(sessions.createSession({ seed: closedSeed() })).rejects.toMatchObject({
      code: PERSIST_BATCH_WRITE_FAILED,
    });
    await expect(sessions.fork()).rejects.toMatchObject({ code: PERSIST_BATCH_WRITE_FAILED });
  });

  it('卫生闸①：data 非 JSON 值拒绝；time 非有限数值拒绝（SESSION_EVENT_DATA_INVALID）', async () => {
    const runtime = await assemble();
    const sessions = runtime.ctx.tryGet<SessionsSpawnFace>('sessions')!;
    // 非 JSON：bigint（JSON.stringify 抛）
    const badData = [
      Object.freeze({ type: 'turn/start', seq: 0, time: 1, data: Object.freeze({ big: 1n }) }),
    ] as unknown as SessionEvent[];
    await expect(sessions.createSession({ seed: badData })).rejects.toMatchObject({ code: SESSION_EVENT_DATA_INVALID });
    // time 非有限：NaN / 字符串
    const badTime = [
      Object.freeze({ type: 'turn/start', seq: 0, time: Number.NaN, data: Object.freeze({}) }),
    ] as unknown as SessionEvent[];
    await expect(sessions.createSession({ seed: badTime })).rejects.toMatchObject({ code: SESSION_EVENT_DATA_INVALID });
    const badTime2 = [
      Object.freeze({ type: 'turn/start', seq: 0, time: '1000', data: Object.freeze({}) }),
    ] as unknown as SessionEvent[];
    await expect(sessions.createSession({ seed: badTime2 })).rejects.toMatchObject({
      code: SESSION_EVENT_DATA_INVALID,
    });
  });

  it('卫生闸②③：单事件 64KiB 体积帽 + 种子总量帽 10 万（SESSION_EVENT_TOO_LARGE）', async () => {
    const runtime = await assemble();
    const sessions = runtime.ctx.tryGet<SessionsSpawnFace>('sessions')!;
    // 64KiB+：超体积护栏（与活体 append 同尺）
    const huge = 'x'.repeat(64 * 1024 + 1);
    const oversize = [
      Object.freeze({ type: 'turn/start', seq: 0, time: 1, data: Object.freeze({ big: huge }) }),
    ] as unknown as SessionEvent[];
    await expect(sessions.createSession({ seed: oversize })).rejects.toMatchObject({ code: SESSION_EVENT_TOO_LARGE });
    // 总量帽：100_001 条轻事件——闸三零遍历先拒
    const flood: SessionEvent[] = [];
    for (let i = 0; i < 100_001; i++) {
      flood.push({ type: 'turn/start', seq: i, time: 1, data: {} });
    }
    await expect(sessions.createSession({ seed: flood })).rejects.toMatchObject({ code: SESSION_EVENT_TOO_LARGE });
  });

  it('卫生闸④：信封字段剥除（surfaceOp/sourceEventSeqs 不透传）+ ignorable 按注册表重盖章', async () => {
    const runtime = await assemble();
    const sessions = runtime.ctx.tryGet<SessionsSpawnFace>('sessions')!;
    // 带 surfaceOp/sourceEventSeqs/伪 ignorable 的种子：外部数据是平展事实流，
    // 宿主侧信封字段一律剥除；memory/diff 注册面 ignorable 缺省 false → 重盖章无此位
    const poisoned = [
      Object.freeze({
        type: 'turn/start',
        seq: 0,
        time: 1,
        data: Object.freeze({}),
        surfaceOp: { op: 'replace', start: 0, end: 0 },
        sourceEventSeqs: [0],
        ignorable: true,
      }),
      Object.freeze({
        type: 'memory/diff',
        seq: 1,
        time: 2,
        data: Object.freeze({ baseline: 'aa', entries: [] }),
        ignorable: true, // 伪盖章：memory/diff 注册非 ignorable——重盖章后应无此位
      }),
    ] as unknown as SessionEvent[];
    const id = await sessions.createSession({ seed: poisoned });
    const events = runtime.persistence!.loadSession(id)!.events;
    // 信封剥除：两条事件均无 surfaceOp/sourceEventSeqs
    expect(events.every((e) => e.surfaceOp === undefined && e.sourceEventSeqs === undefined)).toBe(true);
    // 重盖章：memory/diff 非 ignorable → ignorable 位被剥（外部 true 不透传）
    expect(events[1]!.ignorable).toBeUndefined();
  });

  it('未知事件词拒绝（注册即写入许可）；种子 seq 断裂归构造时 validateSeed 既有闸', async () => {
    const runtime = await assemble();
    const sessions = runtime.ctx.tryGet<SessionsSpawnFace>('sessions')!;
    const unknownWord = [
      Object.freeze({ type: 'nope/void', seq: 0, time: 1, data: Object.freeze({}), ignorable: true }),
    ] as unknown as SessionEvent[];
    await expect(sessions.createSession({ seed: unknownWord })).rejects.toThrowError(/未注册事件类型/);
    // seq 断裂：闸④重盖章剥掉 ignorable → validateSeed 拒（服务面不重复执法）
    const broken = [
      Object.freeze({ type: 'turn/start', seq: 5, time: 1, data: Object.freeze({}) }),
    ] as unknown as SessionEvent[];
    await expect(sessions.createSession({ seed: broken })).rejects.toThrowError(/seq 断裂/);
  });

  it('敞开 turn 恢复协议兜底：种子尾停在 turn 中间 → 合成 closer 随屏障落库', async () => {
    const runtime = await assemble();
    const sessions = runtime.ctx.tryGet<SessionsSpawnFace>('sessions')!;
    const openTail = [
      Object.freeze({ type: 'turn/start', seq: 0, time: 1_000, data: Object.freeze({}) }),
      Object.freeze({
        type: 'user/message',
        seq: 1,
        time: 1_001,
        data: Object.freeze({ content: '半截', source: 'import' }),
      }),
    ] as unknown as SessionEvent[];
    const id = await sessions.createSession({ seed: openTail });
    const types = runtime.persistence!.loadSession(id)!.events.map((e) => e.type);
    // 投影可安全续跑：日志闭合（turn/end 或等价 closer 已补）
    expect(interruptedTurnClosers).toBeTruthy();
    expect(types[types.length - 1]).toBe('turn/end');
  });
});

describe('fork 露头（事件前缀种子分叉 + durable 承诺同款）', () => {
  it('全链：返回 id 物理可收养、前缀=父事件、origin=fork、end-seed 边界标记', async () => {
    const runtime = await assemble();
    // 父会话先有活体事件（appendEvent 走当前路由锚）
    const appendFace = runtime.ctx.tryGet<{ appendEvent(t: string, d: unknown): SessionEvent | undefined }>(
      'sessions',
    )!;
    appendFace.appendEvent('memory/diff', { baseline: 'aa', entries: [] });
    const sessions = runtime.ctx.tryGet<SessionsSpawnFace>('sessions')!;
    const parentId = runtime.session!.header.sessionId;
    const childId = await sessions.fork();

    expect(childId).toBeTruthy();
    expect(childId).not.toBe(parentId);
    const row = sessionRowOf(runtime, childId!);
    expect(row.origin).toBe('fork');
    // durable 承诺：物理行在（非幻影 id）——收养路径 loadSession 命中
    const child = runtime.persistence!.loadSession(childId!);
    expect(child).toBeTruthy();
    const types = child!.events.map((e) => e.type);
    // 种子 = 父前缀（含 memory/diff）+ end-seed 边界标记
    expect(types).toContain('memory/diff');
    expect(types[types.length - 1]).toBe('session/end-seed');
    expect(child!.header.parentSession).toBe(parentId);
  });

  it('boundary 落在敞开 turn 内 = SESSION_FORK_BOUNDARY_INVALID（Session.fork 既有执法）', async () => {
    const runtime = await assemble();
    const sessions = runtime.ctx.tryGet<SessionsSpawnFace>('sessions')!;
    // 前台日志尾部补一条 turn/start（无 end）→ 以全长为边界 = 切在敞开 turn 内
    runtime.session!.append('turn/start', {});
    const boundary = runtime.session!.events.length;
    await expect(sessions.fork(boundary)).rejects.toThrowError(/敞开 turn/);
  });
});

describe('会话增生桶（洪水上界：createSession 与 fork 同一进程级令牌桶）', () => {
  it('小桶注入：容量耗尽后两面同桶 fail-loud（PLUGIN_EVENT_RATE 一码三面之三）', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const runtime = await assemble({ sessionSpawnRateLimit: { capacity: 1, perMinute: 1 } });
      const sessions = runtime.ctx.tryGet<SessionsSpawnFace>('sessions')!;
      // 第一发过（容量 1）
      await sessions.createSession({ seed: closedSeed() });
      // 第二发 fork 撞桶：同桶不同面——message 带面名（fork）可分辨
      await expect(sessions.fork()).rejects.toMatchObject({
        code: PLUGIN_EVENT_RATE,
        message: expect.stringContaining('fork'),
      });
    } finally {
      spy.mockRestore();
    }
  });
});

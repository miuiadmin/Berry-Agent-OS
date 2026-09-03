/**
 * L5 app — 组合根全栈测试（scripted streamFn + 真实装配，mock 只停在模型层）。
 *
 * 验证接线而非各模块行为（各模块有 1-to-1 测试）：事件落库、投影回读、
 * carve-out 全栈链（审批 → 守门 → durable 三事件齐）、持久化 round-trip、
 * 多轮续跑、命令面注册。
 */

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  AssistantMessage,
  AssistantStream,
  AssistantStreamEvent,
  LlmContext,
  StreamFn,
  StreamFnOptions,
  Usage,
} from '../contracts/llm.js';
import type { ToolDefinition } from '../contracts/tools.js';
import type { UiBackend } from '../channels/types.js';
import type { SessionEvent } from '../contracts/events.js';
import { deriveMessages } from '../session/derive.js';
import { interruptedTurnClosers } from '../session/index.js';
import { Persistence } from '../persist/index.js';
// 重开库须带与组合根同链迁移（collectBuiltinMigrations 机械聚合——与装配
// 同源，此后加带表件零改动跟随；宿主裸开只识 v1，少一段即拒开）
import { collectBuiltinMigrations } from './builtins.js';
import { createRuntime } from './assembly.js';
import { ConversationDriver } from '../chat/index.js';
import type { AgentServiceFace } from '../chat/index.js';
import type { AppRuntime } from './assembly.js';
import { defaultConvertToLlm } from './convert.js';
import { runOnceMain } from './run-main.js';
import { dumpConfigMain } from './dump-config.js';
import {
  AppError,
  APP_NOT_FOUND,
  APP_SHUTDOWN_QUIESCE_VIOLATED,
  COMPOSITION_ROW_INVALID,
  PERSIST_BATCH_WRITE_FAILED,
  APP_EVENT_RATE,
  APP_LOAD_FAILED,
  APP_APPLY_FAILED,
  APP_INJECT_UNRESOLVED,
  SESSION_EVENT_DATA_INVALID,
  SESSION_EVENT_TOO_LARGE,
} from '../contracts/errors.js';
import { runInCallerChain, runInSessionChain } from '../context/chain.js';
// D3 装载分面分区测试出口：按区身份探服务 + 应用区 id 构造（context 模块词汇单源）
import { appZoneId, tryResolveService } from '../context/index.js';
import type { SubagentProvider, SubagentResult, SubagentsServiceFace } from '../contracts/subagent.js';
import { fauxProvider, type LlmService } from '../llm/index.js';

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
const runtimes: AppRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop()!;
    await runtime.shutdown().catch(() => undefined);
  }
});

/* G1 降级后（2026-08-30）：boot 第三方行失败落 boot-failures.json 进数据目录——
   全文件钉独立数据目录，防测试诊断文件污染真实 ~/.berry；自钉用例后写胜出照常 */
let globalDataDirPrev: string | undefined;
beforeAll(() => {
  globalDataDirPrev = process.env['APP_DATA_DIR'];
  process.env['APP_DATA_DIR'] = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-asm-data-')));
});
afterAll(() => {
  if (globalDataDirPrev === undefined) delete process.env['APP_DATA_DIR'];
  else process.env['APP_DATA_DIR'] = globalDataDirPrev;
});

/** 装配 + 登记（全部用例经此入口——统一 options 缺省；应用装载使工厂 async） */
async function assemble(overrides: Parameters<typeof createRuntime>[0] = {}): Promise<AppRuntime> {
  const runtime = await createRuntime({
    dbPath: ':memory:',
    workspace: makeWorkspace(),
    ...overrides,
  });
  runtimes.push(runtime);
  return runtime;
}

/** 事件类型序列 */
const types = (runtime: AppRuntime) => (runtime.session?.events ?? []).map((e) => e.type);

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

describe('createRuntime 装配面', () => {
  it('fs 四件 + 内置命令注册；sandbox/mode 落库；系统提示词含基座', async () => {
    const runtime = await assemble();
    // 官方默认层三行（契约篇 §5.1）：memory 首行五件 + subagent 次行委派工具
    // agent + goal 第三行工具三件（goal 纵切二起为默认装配现实）。
    // 三层注册表（域键升级批）：fs 四名 + bash 随 chat 件驱动 open 落**驱动层**
    //（本会话键）——会话组成面 = compositionFor(本会话) = 全局层 ∪ 应用域层 ∪
    // 驱动层；裸 list() 只余全局层（诊断口径）
    expect(runtime.tools.compositionFor(runtime.session!.header.sessionId).map((t) => t.name)).toEqual([
      'find',
      'grep',
      'skill_manage',
      'memory_write',
      'memory_forget',
      'memory_restore',
      'memory_read',
      'memory_search',
      'memory_freeze',
      'memory_unfreeze',
      'memory_ttl',
      'memory_access_log',
      'agent',
      'goal_get',
      'goal_set',
      'goal_update',
      'fetch',
      'apps_list',
      'events_query',
      'apps_install',
      'apps_mount',
      'apps_unmount',
      'apps_update',
      'apps_toggle',
      'apps_configure',
      'apps_reload',
      'apps_uninstall_inspect',
      'obs_query',
      // browser 十件（第十六行——2026-09-01 第四十九批刀二；注册序 = 清单序）
      'browser_navigate',
      'browser_back',
      'browser_forward',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_scroll',
      'browser_screenshot',
      'browser_console',
      'agent_hermes', // delegable 应用自动注册（第三纵切，boot 组合根——hermes 声明 entry.delegable）
      'read',
      'write',
      'edit',
      'ls',
      'bash',
      'todo',
    ]);
    const commands = runtime.channels.commands.list().map((c) => c.name);
    for (const expected of ['help', 'quit', 'skills']) {
      expect(commands).toContain(expected);
    }
    expect(runtime.session?.events.map((e) => e.type)).toEqual(['sandbox/mode']);
    expect(runtime.systemPrompt).toContain('terminal-based coding assistant');
  });

  it('llm 具名服务已 provide（ctx.llm：应用单发补全面，骨架篇 §9.3）', async () => {
    const runtime = await assemble();
    const service = runtime.ctx.tryGet<{ complete(req: { messages: unknown[] }): Promise<unknown> }>('llm');
    expect(service).toBeTruthy();
    expect(typeof service!.complete).toBe('function');
  });

  it('sessions 具名服务（ctx.sessions：应用 durable 落点 + 内核词伪造防护，骨架篇 §9.2）', async () => {
    const runtime = await assemble();
    const sessions = runtime.ctx.tryGet<{ appendEvent(type: string, data: unknown): SessionEvent | undefined }>(
      'sessions',
    )!;
    expect(sessions).toBeTruthy();
    // 已注册应用词汇可写：落当前活跃会话日志（memory/diff = surface 事件）
    const ev = sessions.appendEvent('memory/diff', { baseline: 'deadbeefdeadbeef', entries: [] })!;
    expect(ev.type).toBe('memory/diff');
    expect(runtime.session!.events.at(-1)).toBe(ev);
    // 内核词汇伪造防护：核心词的写入权属宿主（归因/审批/结算语义绑宿主写点）
    for (const core of ['user/message', 'assistant/message', 'tool/call', 'request/header', 'llm/usage']) {
      expect(() => sessions.appendEvent(core, {})).toThrowError(/核心事件词汇/);
    }
    // 未注册词汇：session.append 二道闸（注册即写入许可）
    expect(() => sessions.appendEvent('nope/void', {})).toThrowError(/未知事件类型/);

    // #19 收口回归锁（装载面钥匙——2026-08-25 Hermes 探针收口）：作用域经
    // ctx.registerSessionEventType 注册自有词汇 → appendEvent 即可写（此前第三方
    // 写任何自有词汇必撞「未知事件类型」——有门没钥匙）；核心词在注册侧先拦；
    // 作用域 dispose → 词汇随应用卸载回卷（/reload 重装重注册语义），写侧恢复拒绝
    const scope = runtime.ctx.fork({ name: 't-plugin' });
    expect(() =>
      scope.registerSessionEventType({ type: 'user/message', tier: 'stable', category: 'surface' }),
    ).toThrowError(/核心事件类型/);
    scope.registerSessionEventType({ type: 't-probe/note', category: 'log-only', tier: 'stable' });
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
        expect((e as AppError).code).toBe(APP_EVENT_RATE);
        expect((e as AppError).message).toContain('appendEvent');
        expect((e as AppError).message).toContain(runtime.session!.header.sessionId);
      }
      // 执法先于计费：未注册词在 session.append 内先抛（不占令牌、码可分辨非护栏）
      try {
        sessions.appendEvent('nope/void', {});
        expect.unreachable('应当抛错');
      } catch (e) {
        expect((e as AppError).code).not.toBe(APP_EVENT_RATE);
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
        data: { content: 'x', source: 'app:t' },
        surfaceOp: { op: 'replace', start: 1, end: 2 },
        sourceEventSeqs: [0, 1, 2],
      }),
    ).rejects.toThrowError(/载体型单边/);

    // 执法点 ②：必带 replace 型 surfaceOp（无遮蔽注入走 sendUserMessage 归因正门）
    await expect(
      sessions.appendWithSurfaceOp({
        type: 'user/message',
        data: { content: 'x', source: 'app:t' },
        surfaceOp: undefined,
        sourceEventSeqs: [1],
      } as never),
    ).rejects.toThrowError(/必带 replace 型 surfaceOp/);

    // 执法点 ③：归因强制 app: 前缀（宿主代写是应用行为，归因落在应用名上）
    await expect(
      sessions.appendWithSurfaceOp({
        type: 'user/message',
        data: { content: 'x', source: 'user' },
        surfaceOp: { op: 'replace', start: 1, end: 2 },
        sourceEventSeqs: [0, 1, 2],
      }),
    ).rejects.toThrowError(/归因强制 app:/);

    // 执法点 ④：依据在列——sourceEventSeqs 须含区间外至少一笔（依据≠被遮蔽节点）
    await expect(
      sessions.appendWithSurfaceOp({
        type: 'user/message',
        data: { content: 'x', source: 'app:t' },
        surfaceOp: { op: 'replace', start: 1, end: 2 },
        sourceEventSeqs: [1, 2], // 全在区间内
      }),
    ).rejects.toThrowError(/溯源依据在列/);

    // 合法路径：遮 [1,2] + 依据含区间外 seq0 → 落账 + 投影读面生效
    const carrier = await sessions.appendWithSurfaceOp({
      type: 'user/message',
      data: { content: '压缩摘要', source: 'app:compaction' },
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
        data: { content: 'x', source: 'app:t' },
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
      'skill_manage',
      'agent',
      'fetch',
      'apps_list',
      'events_query',
      'apps_install',
      'apps_mount',
      'apps_unmount',
      'apps_update',
      'apps_toggle',
      'apps_configure',
      'apps_reload',
      'apps_uninstall_inspect',
      'obs_query',
      'browser_navigate',
      'browser_back',
      'browser_forward',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_scroll',
      'browser_screenshot',
      'browser_console',
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
      'apps-quickstart',
      'commit-checklist',
      'skill-authoring',
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
      'skill_manage',
      'memory_write',
      'memory_forget',
      'memory_restore',
      'memory_read',
      'memory_search',
      'memory_freeze',
      'memory_unfreeze',
      'memory_ttl',
      'memory_access_log',
      'agent',
      'goal_get',
      'goal_set',
      'goal_update',
      'fetch',
      'apps_list',
      'events_query',
      'apps_install',
      'apps_mount',
      'apps_unmount',
      'apps_update',
      'apps_toggle',
      'apps_configure',
      'apps_reload',
      'apps_uninstall_inspect',
      'obs_query',
      'browser_navigate',
      'browser_back',
      'browser_forward',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_scroll',
      'browser_screenshot',
      'browser_console',
      'agent_hermes',
      'read',
      'write',
      'edit',
      'ls',
      'bash',
      'todo',
    ]);
    // request/header 载荷带应用域腿（血缘显式打标的证据面——契约篇 §5.4；
    // 组装批：无参 open 走默认应用解析（berrycode 带标在场）→ 首会话打标 berrycode 域）
    const header = runtime.session!.events.find((e) => e.type === 'request/header');
    expect((header?.data as { app?: string }).app).toBe('berrycode');
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

  it('桥帧 durable 落账不进前台聚焦会话（R1 复盘批二 11d——宁缺勿错位；修复前必红）', async () => {
    const runtime = await assemble();
    // 前台聚焦会话在位（boot 新建——durable 转发壳 routed() 的回退落点）
    const session = runtime.session!;
    const gateCount = () => session.events.filter((e) => e.type === 'gate/decision').length;
    const before = gateCount();
    // 最小管道探针 def（不注册——注册与否不改变 gate 落账接线，管道三段全真）
    const probe: ToolDefinition = {
      name: 'gate-ledger-probe',
      description: 'durable 落账路由探针',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    };
    // 桥帧形态（svc-invoke/tool-run 还帧同款）：caller 有帧、session 链无帧——
    // 修复前 routed() 回退前台聚焦 → gate/decision 落进不相干前台会话账本
    //（归因错位比零落账更糟——污染他人清算面，宪章八）
    await runInCallerChain('row-bridge-ledger', () =>
      runtime.tools.executor!(probe, 'bridge:ledger:1', {}, undefined, undefined, 'service'),
    );
    expect(gateCount()).toBe(before); // 桥帧 no-op——宁缺勿错位
    // 对照（宿主帧：无 caller 帧）：回退前台聚焦照旧生效——守卫只拦桥形态
    await runtime.tools.executor!(probe, 'host:ledger:2', {}, undefined, undefined, 'service');
    expect(gateCount()).toBe(before + 1);
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

    // 装配后动态注册（M2 应用挂载工具的同款路径）：tools_change → 活数组原位刷新
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
      'skill_manage',
      'memory_write',
      'memory_forget',
      'memory_restore',
      'memory_read',
      'memory_search',
      'memory_freeze',
      'memory_unfreeze',
      'memory_ttl',
      'memory_access_log',
      'agent',
      'goal_get',
      'goal_set',
      'goal_update',
      'fetch',
      'apps_list',
      'events_query',
      'apps_install',
      'apps_mount',
      'apps_unmount',
      'apps_update',
      'apps_toggle',
      'apps_configure',
      'apps_reload',
      'apps_uninstall_inspect',
      'obs_query',
      'browser_navigate',
      'browser_back',
      'browser_forward',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_scroll',
      'browser_screenshot',
      'browser_console',
      'agent_hermes',
      'echo',
      'read',
      'write',
      'edit',
      'ls',
      'bash',
      'todo',
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

describe('ctx.llm.complete 底账（P1-5 全桶入账 + model 口径统一）', () => {
  it('complete 写点：usage 四桶+上报桶原样落 llm/usage，model 拼全形（faux 真路径）', async () => {
    // faux 走真 pi-ai streamSimple 路径（mock 只停在模型层）；faux 会把路由
    // provider+model 盖章进响应——ledgerModel 拼全形 'faux-ledger/m1'
    const faux = fauxProvider({ provider: 'faux-ledger', models: [{ id: 'm1' }] });
    faux.setResponses([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input: 100,
          output: 50,
          cacheRead: 700,
          cacheWrite: 40,
          cacheWrite1h: 10,
          reasoning: 5,
          totalTokens: 195,
        },
        stopReason: 'stop',
        timestamp: 1,
      } as unknown as Parameters<typeof faux.setResponses>[0][number],
    ]);
    const runtime = await assemble({ providers: [faux.provider], model: 'faux-ledger/m1' });
    const llm = runtime.ctx.get<LlmService>('llm');
    const sessionId = runtime.session!.header.sessionId;
    // S1 键控：onUsage 落账只认调用链命中条目——包进 boot 会话链（生产同构）
    await runInSessionChain({ sessionId }, () =>
      llm.complete({ messages: [{ role: 'user', content: '问', timestamp: 1 }] }),
    );
    const events = runtime.session!.events.filter((e) => e.type === 'llm/usage');
    expect(events).toHaveLength(1);
    // faux 恒以自身估算覆盖 scripted usage（withUsageEstimate——必带 totalTokens/cost），
    // 恰好提供「供应商上报派生/折算桶」的真路径样本：断言键集 = 四桶恰好齐、
    // 派生（totalTokens）与折算（cost）滤除——值断言归 event-types/durable 两测试
    const data = events[0]!.data as { model: string; priority: string; usage: Record<string, number> };
    expect(data.model).toBe('faux-ledger/m1'); // 实录 provider+model 拼全形（口径由 ledgerModel 统一保证）
    expect(data.priority).toBe('foreground'); // 缺省前台道（canAfford 只闸 background）
    expect(Object.keys(data.usage).sort()).toEqual(['cacheRead', 'cacheWrite', 'input', 'output']);
    expect(data.usage.input!).toBeGreaterThan(0);
    expect(data.usage.output!).toBeGreaterThan(0);
  });

  it('E-3 接线锁（遗漏大扫 20260901 L-5）：onUsage 入账炸经 onUsageError 落 ctx.logger.warn——拆掉接线本测必红', async () => {
    // 机制半（onUsageError 收 {callId, model, error} 且不拖垮补全）已锁在
    // llm/complete.test.ts；本测锁**接线半**：组合根把 onUsageError 接到
    // ctx.logger.warn——llm/usage 是 backgroundSpentToday 预算投影唯一底账，
    // 拆线后丢账静默不可观测（实证红法：临时删 assembly.ts 的 onUsageError
    // 实参 → 本测 warn 断言先红）。入账失败注入：entry.session 与
    // runtime.session 是同一活对象（registry 单真相）——append 换成抛错即炸
    const faux = fauxProvider({ provider: 'faux-ledger', models: [{ id: 'm1' }] });
    faux.setResponses([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
        stopReason: 'stop',
        timestamp: 1,
      } as unknown as Parameters<typeof faux.setResponses>[0][number],
    ]);
    const runtime = await assemble({ providers: [faux.provider], model: 'faux-ledger/m1' });
    const llm = runtime.ctx.get<LlmService>('llm');
    const sessionId = runtime.session!.header.sessionId;
    // 记录 warn：拦截组合根接线目标（ctx.logger 同一对象——onUsageError 闭包
    // 运行期属性访问，补丁方法可见）
    const warns: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const logger = runtime.ctx.logger as unknown as {
      warn: (message: string, fields?: Record<string, unknown>) => void;
    };
    const origWarn = logger.warn.bind(logger);
    logger.warn = (message, fields) => warns.push({ message, fields });
    // 入账失败注入：append 抛错 → onUsage 炸 → onUsageError 接线面接住
    const session = runtime.session!;
    const origAppend = session.append.bind(session);
    session.append = (() => {
      throw new Error('底账写入炸了');
    }) as typeof session.append;
    try {
      const result = await runInSessionChain({ sessionId }, () =>
        llm.complete({ messages: [{ role: 'user', content: '问', timestamp: 1 }] }),
      );
      // 计量是观测面：入账炸不拖垮补全本身（E-3 主语义，机制面已锁——此处复核装配面）
      expect(result.message.content).toBeTruthy();
    } finally {
      session.append = origAppend;
      logger.warn = origWarn;
    }
    // 接线在岗：丢账可见——warn 文案 + callId/model/error 三字段随行
    const drop = warns.find((w) => w.message.includes('llm.complete 用量入账失败'));
    expect(drop).toBeDefined();
    expect((drop!.fields as { callId?: unknown }).callId).toBeTypeOf('string');
    expect(String(drop!.fields?.error)).toContain('底账写入炸了');
    // 入账炸未落任何 llm/usage 事件（失败即丢——不重试不重复入账）
    expect(runtime.session!.events.filter((e) => e.type === 'llm/usage')).toHaveLength(0);
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
    const runtime = await createRuntime({ dbPath: dbFile, workspace, streamFn });
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
    const runtime = await createRuntime({ dbPath: dbFile, workspace: makeWorkspace(), streamFn });
    try {
      expect(existsSync(dbFile)).toBe(true); // 父目录被组合根 ③ 建档，SQLite 落库成功
      // 建档即 0700（会话与存储篇 §6 文件权限三件——mkdir mode 是上界、chmod 追打
      // 绝对位设定，断言不受 umask 影响）
      expect(statSync(dirname(dbFile)).mode & 0o777).toBe(0o700);
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

  it('runOnceMain：首跑凭证失败给产品级可行动文案（成熟度扫描 20260901 P0-3——修前 pi-ai 原文裸透传）', async () => {
    // 错误终态消息工厂（scriptedStream 消费 result() 终值——stopReason='error' 即失败路）
    const errorTerminal = (errorMessage: string): AssistantMessage =>
      ({
        role: 'assistant',
        content: [],
        usage: NO_USAGE,
        stopReason: 'error',
        errorMessage,
        timestamp: 1,
      }) as AssistantMessage;
    // 静音 stderr 并捕获（run-main 失败路直写 process.stderr）
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // 形态一：provider 未配置（pi-ai ModelsError 原文）——须点名环境变量 + 文档指路
      const unconfigured = scriptedStream([errorTerminal('Provider is not configured: anthropic')]);
      const code1 = await runOnceMain('你好', {
        dbPath: ':memory:',
        workspace: makeWorkspace(),
        streamFn: unconfigured.streamFn,
      });
      expect(code1).toBe(1);
      const stderr1 = errSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(stderr1).toContain('ANTHROPIC_API_KEY'); // 点名该 provider 的凭证环境变量
      expect(stderr1).toContain('使用指南'); // 指凭证配置文档
      expect(stderr1).toContain('anthropic'); // 点名 provider 本尊

      // 形态二：鉴权被拒（401/403 上游原文）——正文给行动指引，上游原文降附注
      errSpy.mockClear();
      const rejected = scriptedStream([errorTerminal('403 {"error":{"message":"invalid x-api-key"}}')]);
      const code2 = await runOnceMain('你好', {
        dbPath: ':memory:',
        workspace: makeWorkspace(),
        streamFn: rejected.streamFn,
      });
      expect(code2).toBe(1);
      const stderr2 = errSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(stderr2).toContain('HTTP 403'); // 鉴权失败语义面（点名实际状态码）
      expect(stderr2).toContain('使用指南');
      expect(stderr2).toContain('附注'); // 上游原文在场（截断附注非正文）

      // 其余失败形态：原文直出（识别器不劫持非凭证失败；400 类不触发 turn 级重试）
      errSpy.mockClear();
      const other = scriptedStream([errorTerminal('400 your request is malformed')]);
      await runOnceMain('你好', { dbPath: ':memory:', workspace: makeWorkspace(), streamFn: other.streamFn });
      const stderr3 = errSpy.mock.calls.map((call) => String(call[0])).join('');
      // 原文直出（logger 行同走 stderr 属正常噪声——只断业务文案不劫持）
      expect(stderr3).toContain('400 your request is malformed');
      expect(stderr3).not.toContain('使用指南'); // 非凭证失败不被识别器劫持
    } finally {
      errSpy.mockRestore();
    }
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
    const first = await createRuntime({ dbPath: dbFile, workspace, streamFn: script1.streamFn });
    const firstId = first.session!.header.sessionId;
    await first.conversation!.submitOnce('第一问');
    // 模拟中断残形：敞开 turn（最后一个 turn/start 后无 turn/end）
    first.session!.append('turn/start', {});
    await first.shutdown();

    // 二次启动：同库同 cwd，按最新续接（恢复协议自动补齐闭合）
    const script2 = scriptedStream([textMessage('续答'), textMessage('再答')]);
    const second = await createRuntime({
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

/* ---------------- 组装批：默认应用键（解析 / 兜底态 / 归属改钉 / 披露） ---------------- */

describe('组装批默认应用键（契约篇 §5.4：无参 open 解析默认应用）', () => {
  it('兜底态全栈：带标与 chat 均缺场 → boot open 防御降级（无驱动壳照启 + appGaps 披露 + /app new 示因）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    // 禁 web+memory：berrycode 组件含两者 → 缺场；chat/hermes 组件含 memory → 同缺
    //（全官方清单都声明 memory——两跳全落空的真组合）；chat 件本身在场（boot
    // open 走得到默认解析位——测的是解析无果的降级，不是件缺位）
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      'rows:\n  - id: web\n    disabled: true\n  - id: memory\n    disabled: true\n',
    );
    const runtime = await assemble({ compositionDir });
    // 兜底态：无对话循环 + 零驱动（warn 已落根 logger；不认领任意在册应用）
    expect(runtime.conversation).toBeUndefined();
    expect(runtime.drivers.entries.size).toBe(0);
    // 缺场投影（gaps 值 = 清单声明序内的缺失清单——dump-config 披露同源）
    expect(runtime.appGaps.get('berrycode')).toEqual(['builtin:web', 'builtin:memory']);
    expect(runtime.appGaps.get('chat')).toEqual(['builtin:memory']);
    // 壳照启半边：命令面活——/app new 失败文案示明默认应用不可用（M7 链路读侧）
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);
    runtime.channels.commands.lookup('app')!.handler('new');
    expect(notifies.join('\n')).toContain('默认应用不可用');
    await runtime.shutdown();
    runtimes.pop(); // 已手动关停——让位登记表防二次关停
  });

  it('默认域续接含 NULL 存量（includeNullApp 随默认域）：无参启动认领 NULL 会话且投影 berrycode；显式 hermes 域不认领', async () => {
    const dbFile = join(realpathSync(tmpdir()), `app-null-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const workspace = makeWorkspace();
    // 首程：boot 建 berrycode 会话 + 手造 NULL 标签存量会话（打标机制落地前的旧世界）
    const first = await createRuntime({
      dbPath: dbFile,
      workspace,
      streamFn: scriptedStream([textMessage('答')]).streamFn,
    });
    const legacy = first.persistence!.createSession({ cwd: workspace }); // app 缺省 = NULL 标签
    legacy.append('sandbox/mode', { mode: 'workspace-write' }); // 落 sessions 行（write-behind 元数据随行）
    const legacyId = legacy.header.sessionId;
    await first.shutdown();

    // 二程：无参启动续接——默认域（berrycode ∪ NULL）最新 = legacy 会话；NULL 标签
    // → 保持默认投影（entry 打标 berrycode，会话标签不被改写）
    const second = await createRuntime({
      dbPath: dbFile,
      workspace,
      resumeSession: true,
      streamFn: scriptedStream([textMessage('续答')]).streamFn,
    });
    try {
      expect(second.session!.header.sessionId).toBe(legacyId); // NULL 存量被默认域认领续接
      expect(second.drivers.entries.get(legacyId)!.appId).toBe('berrycode'); // 默认投影打标（NULL → 默认应用）
    } finally {
      await second.shutdown();
    }

    // 三程：显式进入 hermes 域——严格域不认领 NULL（别家/无家的会话不投喂）
    const third = await createRuntime({
      dbPath: dbFile,
      workspace,
      app: 'hermes',
      resumeSession: true,
      streamFn: scriptedStream([textMessage('新答')]).streamFn,
    });
    try {
      expect(third.session!.header.sessionId).not.toBe(legacyId); // 回落新建（hermes 域无会话）
      expect([...third.drivers.entries.values()].at(-1)!.appId).toBe('hermes');
    } finally {
      await third.shutdown();
    }
  });

  it('string resume 归属改钉（m4）：目标会话标签在场且应用在场 → 改钉该域；标签在场但应用缺场 → 打标记血缘、装配面维持解析域', async () => {
    const dbFile = join(realpathSync(tmpdir()), `app-m4-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const workspace = makeWorkspace();
    // 首程：boot berrycode 会话 + 经 drivers.open 开 hermes 域会话（标签 hermes）
    const first = await createRuntime({
      dbPath: dbFile,
      workspace,
      streamFn: scriptedStream([textMessage('答')]).streamFn,
    });
    const berrycodeId = first.session!.header.sessionId;
    const hermesEntry = first.drivers.open({ app: first.apps.get('hermes')! })!;
    const hermesId = hermesEntry.session.header.sessionId;
    await first.shutdown();

    // 二程：string resume 到 hermes 会话 → m4 归属查表 → 改钉 hermes 域（非解析域）
    const second = await createRuntime({
      dbPath: dbFile,
      workspace,
      streamFn: scriptedStream([textMessage('答')]).streamFn,
    });
    try {
      const resumed = second.drivers.open({ resume: hermesId })!;
      expect(resumed.appId).toBe('hermes'); // 标签在场 + 应用在场 → 改钉（装配面同换）
    } finally {
      await second.shutdown();
    }

    // 三程：禁 web → berrycode 缺场、chat 回落为默认；string resume 到旧 berrycode 会话 →
    // 标签在场但应用缺场 → appId 打标血缘 berrycode、装配面维持解析域（chat 清单）
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    writeFileSync(join(compositionDir, 'overlay.yaml'), 'rows:\n  - id: web\n    disabled: true\n');
    const third = await createRuntime({
      dbPath: dbFile,
      workspace,
      compositionDir,
      streamFn: scriptedStream([textMessage('答')]).streamFn,
    });
    try {
      expect(third.appGaps.has('berrycode')).toBe(true); // 前置：berrycode 缺场成立
      expect([...third.drivers.entries.values()].at(-1)!.appId).toBe('chat'); // 前置：boot 默认位已回落 chat
      const resumed = third.drivers.open({ resume: berrycodeId })!;
      expect(resumed.appId).toBe('berrycode'); // 血缘标记如实（不谎称 chat 域）
    } finally {
      await third.shutdown();
    }
  });

  it('dump-config 默认应用披露（M7）：健康态「默认应用：berrycode」；兜底态披露回落原因链', async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write);
    try {
      // 健康态：默认层全在场 → 带标 berrycode 直取
      const emptyDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
      expect(await dumpConfigMain({ compositionDir: emptyDir })).toBe(0);
      expect(chunks.join('')).toContain('默认应用：berrycode\n');

      // 兜底态：禁 web+memory → 两跳全落空 → 披露无果 + 两缺场原因（诊断自助面）
      chunks.length = 0;
      const gapDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
      writeFileSync(
        join(gapDir, 'overlay.yaml'),
        'rows:\n  - id: web\n    disabled: true\n  - id: memory\n    disabled: true\n',
      );
      expect(await dumpConfigMain({ compositionDir: gapDir })).toBe(0);
      const out = chunks.join('');
      expect(out).toContain('默认应用：（无——默认解析无果');
      expect(out).toContain('berrycode 缺场（缺组件：builtin:web、builtin:memory）');
      expect(out).toContain('chat 缺场（缺组件：builtin:memory）');
    } finally {
      spy.mockRestore();
    }
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
  const headerPayload = (runtime: AppRuntime): { app?: string } =>
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
    expect(err.message).toContain('berrycode、chat、hermes'); // 在册清单随错披露（berrycode = 组装批新册应用）
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

  it('/new 透传聚焦条目 app（B 案，D1-d）：同应用新开——默认域恒 berrycode、hermes 域开在 hermes', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ streamFn });
    // 默认域聚焦（boot 缺省 = 默认应用 berrycode——组装批后默认位解析带标应用）：
    // /new 后新会话仍 berrycode 域（透传不改变缺省行为半边）
    runtime.channels.commands.lookup('new')!.handler('');
    let current = runtime.front.focus.sessionId!;
    expect(runtime.drivers.entries.get(current)!.appId).toBe('berrycode');
    // 进入 hermes → 聚焦切应用域 → /new 开在 hermes 域（恒默认域过渡态收口）
    runtime.channels.commands.lookup('app')!.handler('hermes');
    current = runtime.front.focus.sessionId!;
    expect(runtime.drivers.entries.get(current)!.appId).toBe('hermes');
    runtime.channels.commands.lookup('new')!.handler('');
    const renewed = runtime.front.focus.sessionId!;
    expect(renewed).not.toBe(current);
    expect(runtime.drivers.entries.get(renewed)!.appId).toBe('hermes'); // 同应用新开
    expect(runtime.drivers.entries.get(current)!.retired).toBe(true); // /new 旧条目退役（语义不变半边）
  });

  it('缺场应用 /app <id> 死防御支（D1-d）：在册即路由 enter——精确报组件缺场，不误落「无此会话」', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-enter-')));
    // 禁 goal 行 → chat/hermes 清单组件双双缺场（在场断言 → 应用级隔离不拒启）
    writeFileSync(join(compositionDir, 'overlay.yaml'), 'rows:\n  - id: goal\n    disabled: true\n');
    const { streamFn } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ streamFn, compositionDir });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);
    const focusBefore = runtime.front.focus.sessionId;
    runtime.channels.commands.lookup('app')!.handler('hermes');
    // 缺场报错精确到缺失身份串 + 隔离语义（此前误落会话寻址的「无此会话」）
    const lines = notifies.join('\n');
    expect(lines).toContain('进入失败');
    expect(lines).toContain('应用 hermes 组件缺场（builtin:goal）');
    expect(notifies.some((n) => n.includes('无此会话'))).toBe(false);
    expect(runtime.front.focus.sessionId).toBe(focusBefore); // 进入失败 focus 不动
  });

  it('裸调清单披露可用应用行；delegable 应用双注册（provider 表 + agent_<id> 静态工具）', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ streamFn });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);
    runtime.channels.commands.lookup('app')!.handler('');
    // 可用应用披露行（在册且组件齐备——chat/berrycode/hermes 默认树全在场；缺场应用
    // 不披露；组装批默认应用带标——berrycode 行缀「(默认)」）
    expect(notifies.join('\n')).toContain('可用应用：berrycode(默认)、chat、hermes');
    // delegable 自动注册（boot 组合根）：hermes 声明 entry.delegable → 双面
    const subagents = runtime.ctx.get<SubagentsServiceFace>('subagents');
    expect(subagents.list().map((info) => info.name)).toContain('hermes');
    expect(runtime.tools.get('agent_hermes')).toBeDefined();
  });
});

/* ---------------- S2 多驱动工具面（组合域分片全栈） ---------------- */

describe('S2 多驱动工具面（三层注册表：双驱动隔离零泄漏 + retire 拆层 + /new 冻结）', () => {
  /** fs 四名（驱动层恒在 compositionFor 尾部——chat 件 open 驱动层注册） */
  const FS_NAMES = ['read', 'write', 'edit', 'ls'];

  it('双驱动各层各套 fs：实例隔离（观察表 per-driver 投影）、全局层零泄漏、retire 拆层他层不动、/reload 后活层存续', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ streamFn });
    const entryA = runtime.drivers.focused()!;
    const aId = entryA.session.header.sessionId;
    // 直接 open（不走 /new——不退役 A）：双驱动并存形态（S3 /app 前台切换的目标面）
    const entryB = runtime.drivers.open()!;
    const bId = entryB.session.header.sessionId;
    expect(bId).not.toBe(aId);

    // 两驱动组成面各含 fs 四名；裸 list（全局层）零 fs——驱动层零泄漏
    const faceA = runtime.tools.compositionFor(aId);
    const faceB = runtime.tools.compositionFor(bId);
    expect(faceA.map((t) => t.name).filter((n) => FS_NAMES.includes(n))).toEqual(FS_NAMES);
    expect(faceB.map((t) => t.name).filter((n) => FS_NAMES.includes(n))).toEqual(FS_NAMES);
    expect(runtime.tools.list().some((t) => FS_NAMES.includes(t.name))).toBe(false);
    // 实例隔离：A/B 的 read 是两个 def 实例（观察态 per-driver 的注册面投影——读不过户）
    expect(faceA.find((t) => t.name === 'read')).not.toBe(faceB.find((t) => t.name === 'read'));

    // A retire（退役即停摆的工具面半边）：A 驱动层拆层 fs 消隐、B 面分毫不动
    expect(runtime.drivers.retire(aId)).toBe(true);
    expect(runtime.drivers.entries.get(aId)!.retired).toBe(true);
    expect(runtime.tools.compositionFor(aId).some((t) => FS_NAMES.includes(t.name))).toBe(false);
    expect(
      runtime.tools
        .compositionFor(bId)
        .map((t) => t.name)
        .filter((n) => FS_NAMES.includes(n)),
    ).toEqual(FS_NAMES);

    // /reload 后活层存续：注册表本体随 Ring 1 锚不回卷、驱动层条目挂 DriverEntry
    //（retire 已拆的 A 层不复活；B 层四名齐全）
    const reloaded = await runtime.reload();
    expect(reloaded.payload).toBeDefined();
    expect(
      runtime.tools
        .compositionFor(bId)
        .map((t) => t.name)
        .filter((n) => FS_NAMES.includes(n)),
    ).toEqual(FS_NAMES);
    expect(runtime.tools.compositionFor(aId).some((t) => FS_NAMES.includes(t.name))).toBe(false);
  });

  it('/new 冻结：旧条目退役（驱动层拆层、条目保留）、新条目新层新会话起步', async () => {
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
    // 旧驱动层已拆层（「冻结」的工具面半边——退役会话不再 run，工具面消隐防泄漏累积）
    expect(runtime.tools.compositionFor(oldId).some((t) => FS_NAMES.includes(t.name))).toBe(false);
    // 新层就位：新会话组成面 fs 四名齐全 + 聚焦已切新条目
    expect(
      runtime.tools
        .compositionFor(newId)
        .map((t) => t.name)
        .filter((n) => FS_NAMES.includes(n)),
    ).toEqual(FS_NAMES);
    expect(runtime.drivers.focused()!.session.header.sessionId).toBe(newId);
  });

  it('tools_change 三态路由（域键升级批）：driver 键刷单条目 / domain 键刷该应用全部 / 缺省刷全部；退役条目不刷', async () => {
    const { streamFn } = scriptedStream([textMessage('答'), textMessage('答二')]);
    const runtime = await assemble({ streamFn });
    const aId = runtime.session!.header.sessionId;
    // A 先跑一轮落 initial（writeHeader 差分化的对照锚——后续变更张才有 diff 基准）
    await runtime.conversation!.submitOnce('第一问');
    runtime.drivers.open(); // 双驱动（同属 chat 应用——boot 缺省 app）
    const bId = runtime.drivers.focused()!.session.header.sessionId;
    /** 某会话 request/header 张数（tools_change 即时落账的观测面——差分化：首张 initial，后续变更 change） */
    const headerCount = (id: string): number =>
      runtime.drivers.entries.get(id)!.session.events.filter((e) => e.type === 'request/header').length;
    /** 某会话末张 header 的工具名集 */
    const lastTools = (id: string): string[] =>
      (
        runtime.drivers.entries
          .get(id)!
          .session.events.filter((e) => e.type === 'request/header')
          .at(-1)!.data as { toolSchemas: Array<{ name: string }> }
      ).toolSchemas.map((t) => t.name);
    /** 最小合法 def（三态注册共用） */
    const def = (name: string): ToolDefinition => ({
      name,
      description: '三态路由测试工具',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    // 相对基线（open 时驱动层注册可能已落 header——只断言增量，不断言绝对数）
    const baseA = headerCount(aId);
    const baseB = headerCount(bId);
    const appKey = runtime.drivers.entries.get(bId)!.appId; // 双驱动同应用键
    expect(lastTools(aId)).not.toContain('drv-b'); // 前置锚：A 末张无 B 的驱动层工具

    // ① driver 键：B 驱动层注册 → 只 B 落新张（A 不动——chat 件 open 注册 fs+bash 同款路径）
    runtime.tools.register(def('drv-b'), { driver: bId, domain: appKey });
    expect(headerCount(aId)).toBe(baseA);
    expect(headerCount(bId)).toBe(baseB + 1);
    expect(lastTools(bId)).toContain('drv-b');

    // ② domain 键：应用域层注册 → 该应用全部非退役条目各落一张（A、B 同属 chat）
    runtime.tools.register(def('app-x'), { domain: appKey });
    expect(headerCount(aId)).toBe(baseA + 1);
    expect(headerCount(bId)).toBe(baseB + 2);
    expect(lastTools(aId)).toContain('app-x');
    expect(lastTools(bId)).toContain('app-x');

    // ③ 缺省：全局层注册 → 全部非退役条目各落一张
    runtime.tools.register(def('glob-1'));
    expect(headerCount(aId)).toBe(baseA + 2);
    expect(headerCount(bId)).toBe(baseB + 3);

    // ④ 退役条目不刷：retire A 后再全局注册 → 只 B 落（退役会话的 change 快照是纯噪声）
    runtime.drivers.retire(aId);
    runtime.tools.register(def('glob-2'));
    expect(headerCount(aId)).toBe(baseA + 2);
    expect(headerCount(bId)).toBe(baseB + 4);

    // B 末张快照已含四件新名（驱动层 + 应用域层 + 全局层两件）
    for (const n of ['drv-b', 'app-x', 'glob-1', 'glob-2']) {
      expect(lastTools(bId)).toContain(n);
    }
  });
});

/* ---------------- ⑨b 应用装载（组合树 + 加载器全栈） ---------------- */

/** 写一个目录形态的 fixture 应用（约定入口 index.ts），返回应用目录路径 */
function writeAppDir(compositionDir: string, source: string): string {
  const appDir = join(compositionDir, 'my-plugin');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'index.ts'), source);
  return appDir;
}

describe('⑨b 应用装载（组合树 + 加载器全栈）', () => {
  it('第三方技能提供方 ②×D1 联锁拒载：行挂 app（触发② 必填）→ registerProvider 装载期拒——行失败隔离降级', async () => {
    // D2 前形 = #17 回归锁（第三方 provider 装载即进渐进披露）；触发② 开闸后
    // 第三方行必挂 app，而 D1 裁死 app 行技能注册（provider 全局注入 systemPrompt
    // 无域层——契约篇 §5.1 注册面路由）→ 旧前提整体不可达，锁位换形为本联锁：
    // skills 域层落地批（挂账随首个真实第三方需求）回开时本锁必红即提示重写。
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-skill-')));
    // 物化技能正文（契约篇 §4.4 FS 假设钉死：filePath 必须真实可读——hub 类
    // provider「安装即落盘」的映像），provider 管发现
    const skillDir = join(compositionDir, 'installed-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: plug-probe-skill\ndescription: 应用提供方技能（联锁拒载回归锁）。\n---\n\n正文。\n',
    );
    const appDir = writeAppDir(
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
        '          description: "应用提供方技能（联锁拒载回归锁）。",',
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
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: skill-plugin\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );
    // registerProvider 拒绝经加载器收为行失败（APP_APPLY_FAILED 包原码）——
    // G1 后第三方行失败 = 隔离降级不拒启：执法面不变（行失败 + 原码文案进留账），
    // 进程级收场换为平台照启（与 D1 包声明面拒载锁同断言不同入口）
    const runtime = await assemble({ compositionDir });
    const failedRow = runtime.appsService.list().find((row) => row.id === 'skill-plugin');
    expect(failedRow?.status).toBe('failed');
    expect(failedRow?.message).toMatch(/技能来源注册被拒/);
  });

  it('overlay 应用全栈：工具经 ctx.effect 注册 → 装配后可见可执行；paths/apps 服务就位', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const appDir = writeAppDir(
      compositionDir,
      [
        'export const name = "tool-plugin";',
        'export default async function apply(ctx, config) {',
        '  const tools = ctx.get("tools");',
        '  // 契约篇 §3.2：注册即 effect——apply 回卷时注册随之撤销',
        '  ctx.effect(() =>',
        '    tools.register({',
        '      name: "plug-echo",',
        '      description: "应用注册的回声工具（装载全栈测试）",',
        '      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },',
        '      execute: async (args) => ({ content: [{ type: "text", text: `${config.tag}:${args.text}` }] }),',
        '    }),',
        '  );',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: tool-plugin\n    pkg: ${appDir}\n    apps: [berrycode]\n    sandbox: { carrier: main }\n    config:\n      tag: 装载\n`,
    );

    const { streamFn, contexts } = scriptedStream([
      toolCallMessage('plug-echo', { text: '回声' }),
      textMessage('完成'),
    ]);
    const runtime = await assemble({ streamFn, compositionDir });

    // 装载状态面：ctx.apps 与 runtime.appsService 同源（官方默认层 memory/subagent/
    // goal 三行 + scheduler 第五行 + mcp 第六行 + tools 第七行〔Ring 1 行树化——
    // boot 于 ring1Anchor 装载、状态同面可见〕 + overlay tool-plugin 行均
    // activated——list 状态行序 = 组合树序；applyMs 为装载计时（刀〇a 打点面）
    // 值不定，用 toMatchObject 不断言精确数）
    expect(runtime.appsService.list()).toMatchObject([
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
      { id: 'checkpoint', status: 'activated', name: 'checkpoint' },
      { id: 'lsp', status: 'activated', name: 'lsp' },
      { id: 'channels', status: 'activated', name: 'channels' },
      { id: 'webui', status: 'activated', name: 'webui' },
      { id: 'obs', status: 'activated', name: 'obs' },
      { id: 'browser', status: 'activated', name: 'browser' },
      { id: 'desktop', status: 'activated', name: 'desktop' },
      { id: 'tool-plugin', status: 'activated', name: 'tool-plugin' },
    ]);
    expect(runtime.ctx.tryGet<{ list(): unknown[] }>('apps')).toBeTruthy();
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
      'checkpoint',
      'lsp',
      'channels',
      'webui',
      'obs',
      'browser',
      'desktop',
      'tool-plugin',
    ]);
    // 应用工具已进注册表（域键升级批：全局层在前 + fs 驱动层在后——本会话组成面）
    expect(runtime.tools.compositionFor(runtime.session!.header.sessionId).map((t) => t.name)).toEqual([
      'find',
      'grep',
      'skill_manage',
      'memory_write',
      'memory_forget',
      'memory_restore',
      'memory_read',
      'memory_search',
      'memory_freeze',
      'memory_unfreeze',
      'memory_ttl',
      'memory_access_log',
      'agent',
      'goal_get',
      'goal_set',
      'goal_update',
      'fetch',
      'apps_list',
      'events_query',
      'apps_install',
      'apps_mount',
      'apps_unmount',
      'apps_update',
      'apps_toggle',
      'apps_configure',
      'apps_reload',
      'apps_uninstall_inspect',
      'obs_query',
      'browser_navigate',
      'browser_back',
      'browser_forward',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_scroll',
      'browser_screenshot',
      'browser_console',
      'agent_hermes', // delegable 注册在 ⑨ 装载后——全局层殿后一位
      'plug-echo', // D2 触发②：第三方行挂 app: berrycode（默认应用域——组装批后 boot 会话域）→ 隐式路由落 berrycode 应用域层（全局层之后、驱动层之前）
      'read',
      'write',
      'edit',
      'ls',
      'bash',
      'todo',
    ]);
    // 目录服务：ctx.paths 指向组合树目录、应用数据目录可取（首取即建）
    const paths = runtime.ctx.tryGet<{ dataDir(): string; appDataDir(id: string): string }>('paths');
    expect(paths!.dataDir()).toBe(compositionDir);
    expect(paths!.appDataDir('tool-plugin')).toBe(join(compositionDir, 'apps', 'tool-plugin'));

    // 首 run：工具对模型可见（⑨b 注册经 ⑧ 接线原位刷新了 loop 快照）+ 真走三段管道
    await runtime.conversation!.submitOnce('用应用工具');
    expect(contexts[0]?.tools?.map((t) => t.name)).toContain('plug-echo');
    expect(runtime.session!.events.some((e) => e.type === 'tool/result')).toBe(true);
    const projected = deriveMessages(runtime.session!.events);
    expect(projected.map((m) => m.type)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    // 装配期注册的 header：一张 initial、toolSchemas 已含应用工具（快照内容正确）
    const headers = runtime.session!.events.filter((e) => e.type === 'request/header');
    expect(headers).toHaveLength(1);
    expect((headers[0]!.data as { reason: string }).reason).toBe('initial');
    expect((headers[0]!.data as { toolSchemas: Array<{ name: string }> }).toolSchemas.map((t) => t.name)).toContain(
      'plug-echo',
    );
  });

  it('D1 app 行应用全栈：工具隐式路由落应用域层——chat 组合域独见、全局口径与别应用不可见', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const appDir = writeAppDir(
      compositionDir,
      [
        'export const name = "app-tool-plugin";',
        'export default async function apply(ctx) {',
        '  const tools = ctx.get("tools");',
        '  // 无显式键注册：装载器 apply 帧带行 id → 探针归因行 app 键 → 落应用域层',
        '  ctx.effect(() =>',
        '    tools.register({',
        '      name: "app-echo",',
        '      description: "应用行注册的回声工具（D1 清单投影回归锁）",',
        '      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },',
        '      execute: async (args) => ({ content: [{ type: "text", text: `app:${args.text}` }] }),',
        '    }),',
        '  );',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: app-tool-plugin\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );
    const runtime = await assemble({ compositionDir });
    try {
      // 行装载成功（app: chat = 在册应用 id——四触发拒绝式不触发）
      expect(runtime.appsService.list().at(-1)).toMatchObject({ id: 'app-tool-plugin', status: 'activated' });
      // 隐式路由落 chat 应用域层：该应用作用域域视角独见
      expect(runtime.tools.listFor('chat').map((t) => t.name)).toContain('app-echo');
      // 全局口径（诊断面/裸 list）不可见；别应用作用域域不可见（跨应用零泄漏
      //——berrycode = 默认应用域：boot 会话即此域，chat 挂载行对它同样不可见）
      expect(runtime.tools.list().map((t) => t.name)).not.toContain('app-echo');
      expect(runtime.tools.listFor('berrycode').map((t) => t.name)).not.toContain('app-echo');
      expect(runtime.tools.listFor('hermes').map((t) => t.name)).not.toContain('app-echo');
      // 正半边（断言 6 注册面码半边）：挂 chat 应用的行能力进 chat 应用组成面
      //——组装批后默认驱动 = berrycode 域（boot 会话不见 chat 挂载行），chat 域组成
      // 面经 /app 进入取聚焦会话验证（组成面 = 全局 ∪ 该应用域 ∪ 驱动层）
      runtime.channels.commands.lookup('app')!.handler('chat');
      const chatSessionId = runtime.front.focus.sessionId!;
      expect(runtime.drivers.entries.get(chatSessionId)!.appId).toBe('chat');
      const composition = runtime.tools.compositionFor(chatSessionId);
      expect(composition.map((t) => t.name)).toContain('app-echo');
    } finally {
      await runtime.shutdown();
    }
  });

  it('D1 app 行技能拒载全栈：包声明 skills + 行 app 键 → 行失败隔离降级（seam 还帧 → 服务面执法）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const appDir = writeAppDir(
      compositionDir,
      [
        'export const name = "app-skill-plugin";',
        'export const skills = ["./skills"];',
        'export default async function apply() {}',
      ].join('\n'),
    );
    // 包内技能目录物化（纯技能包最小形态——技能目录在应用包根下）
    const skillDir = join(appDir, 'skills');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: app-row-skill\ndescription: 应用行技能（D1 拒载回归锁）。\n---\n\n正文。\n',
    );
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: app-skill-plugin\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );
    // 技能 provider 全局注入 systemPrompt 无域层：app 行注册 = 装载期拒绝 →
    // 加载器收为行失败（APP_APPLY_FAILED 包原码）——G1 后隔离降级不拒启，
    // 拒载执法经失败行留账锁死（seam 还帧 → 服务面执法链路不变）
    const runtime = await assemble({ compositionDir });
    const failedRow = runtime.appsService.list().find((row) => row.id === 'app-skill-plugin');
    expect(failedRow?.status).toBe('failed');
    expect(failedRow?.message).toMatch(/技能来源注册被拒/);
  });

  it('提示词段全栈（宿主自留地）：registerSection → systemPrompt 含段内容（分节序固定）——应用行注册被 D3 裁死拒载（见 D3 单区 reload describe）、第三方行无 apps 被 D2 触发②拒，第三方 prompt 段 v1 无路即裁死语义；此处用 root 直注册（无行籍不拦）锁注册链与分节序', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    writeFileSync(join(compositionDir, 'overlay.yaml'), `rows: []\n`);

    const { streamFn } = scriptedStream([textMessage('收到')]);
    const runtime = await assemble({ streamFn, compositionDir });
    // 宿主自留地注册（chainCaller 无行籍帧 = 官方面，registerSection 不拦）
    const prompts = runtime.ctx.get<{
      registerSection(section: { id: string; render: () => string }): void;
      listSections(): string[];
    }>('prompts');
    prompts.registerSection({ id: 'demo/notice', render: () => '应用段内容：记住用中文注释' });

    // 段已进 systemPrompt：分节序固定 = 基座 → 技能 → 具名段（段在基座文案之后）
    expect(runtime.systemPrompt).toContain('应用段内容：记住用中文注释');
    expect(runtime.systemPrompt.indexOf('应用段内容：记住用中文注释')).toBeGreaterThan(
      runtime.systemPrompt.indexOf('terminal-based coding assistant'),
    );
    // 段 id 清单面（字典序；memory/core 简报段 + subagent/list 清单段为官方件
    // 注册——memory 空库物化为空串、subagent 单 provider 物化一行清单）
    // environment = 宿主自留地段（exec 纵切——无 / 单段 id 排应用域段之前，字典序）；
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
    expect((headers[0]!.data as { systemPrompt: string }).systemPrompt).toContain('应用段内容：记住用中文注释');
  });

  // B-1 回归锁（admin 刀，契约篇 §3.4 落码义务）：chat 件首会话 open() 的
  // systemPrompt 首物化早于 ⑨ 装载收口——无收口补物化时首物化点 appsService.list()
  // 恒空，environment 第五件计数在首请求快照里冻结为「应用 0 行」。锁：initial
  // header 的 systemPrompt 计数必须非零且 activated === total（默认层全激活）。
  // 修前必红验证法：注释掉 boot 收口的 rematerializeAll()（assembly ⑨ 尾）。
  it('boot 装载收口重物化：首 header 的应用计数非零（无收口补物化时恒 0 必红）', async () => {
    const { streamFn } = scriptedStream([textMessage('好')]);
    const runtime = await assemble({ streamFn });
    await runtime.conversation!.submitOnce('问');
    const header = runtime.session!.events.find((e) => e.type === 'request/header');
    const sp = (header!.data as { systemPrompt: string }).systemPrompt;
    const m = /应用 (\d+) 行：activated (\d+)/.exec(sp);
    expect(m).not.toBeNull();
    // total > 0（默认装配 = 十行——修前此处取到 0 即红）；activated === total（默认全激活）
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(Number(m![2])).toBe(Number(m![1]));
  });

  it('context_transform 桥接：应用挂瀑布注入消息 → 模型请求含注入、日志不含（瞬态面）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const appDir = writeAppDir(
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
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: inject-plugin\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );

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

  it('context_transform 桥钟：应用钩子挂起 → EVENT_HANDLER_TIMEOUT、run 按失败收尾（§1.6 时钟族，刀〇a）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const appDir = writeAppDir(
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
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: hang-transform\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );

    const { streamFn } = scriptedStream([textMessage('到不了的回答')]);
    // transformTimeoutMs 小钟（30ms）：生产缺省 5s——测试不等真钟
    const runtime = await assemble({ streamFn, compositionDir, transformTimeoutMs: 30 });
    const result = await runtime.conversation!.submitOnce('会挂起的问题');

    // loop 零 try/catch 纪律：钩子超时沿 transformContext 上抛进 runTurns 统一 catch
    expect(result?.status).toBe('failed');
    // 码进文本（describeError 统一口径 [CODE] 前缀——杜绝 app 兜底吞码）
    expect(result?.errorMessage).toContain('[EVENT_HANDLER_TIMEOUT]');
  });

  it('user_input 桥接（P1-2 增补 7②）：应用挂瀑布变换用户消息 → 模型请求含变换体、原文本不进请求', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const appDir = writeAppDir(
      compositionDir,
      [
        'export const name = "input-transform";',
        'export default async function apply(ctx) {',
        '  // user_input 瀑布双参 (message, sessionId)：变换后调 next 逐参透传',
        '  // （与 context_transform 的 S1 双参契约同款——单参调用丢归属键）',
        '  ctx.on("user_input", (m, s, next) =>',
        '    next({ ...m, content: "【已变换】" + String(m.content) }, s),',
        '  );',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: input-transform\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );

    const { streamFn, contexts } = scriptedStream([textMessage('好的')]);
    const runtime = await assemble({ streamFn, compositionDir });
    await runtime.conversation!.submitOnce('原始问题');

    // 变换体进模型请求（桥接生效——transformBatch → 总线瀑布）
    const flat = contexts[0]!.messages.map((m) => JSON.stringify(m)).join('\n');
    expect(flat).toContain('【已变换】原始问题');
    expect(flat).not.toContain('"原始问题"'); // 替换语义非追加：原文本不进请求
  });

  it('user_input 桥钟（§1.6 时钟族）：应用钩子挂起 → EVENT_HANDLER_TIMEOUT、run 按失败收尾', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const appDir = writeAppDir(
      compositionDir,
      [
        'export const name = "hang-input";',
        'export default async function apply(ctx) {',
        '  // 挂起与抛错同族（增补 7② 失败语义）：进瀑布后永不调 next——',
        '  // 竞速桥钟后 run 按失败收尾（响亮不吞）',
        '  ctx.on("user_input", () => new Promise(() => {}));',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: hang-input\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );

    const { streamFn } = scriptedStream([textMessage('到不了的回答')]);
    // inputTimeoutMs 小钟（30ms）：生产缺省 5s——测试不等真钟
    const runtime = await assemble({ streamFn, compositionDir, inputTimeoutMs: 30 });
    const result = await runtime.conversation!.submitOnce('会挂起的问题');

    expect(result?.status).toBe('failed');
    expect(result?.errorMessage).toContain('[EVENT_HANDLER_TIMEOUT]');
  });

  it('turn_stopping 桥钟（增补 7① 失败语义）：serial 挂起 → 超时不拖死停机、run 结果不被改写', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const appDir = writeAppDir(
      compositionDir,
      [
        'export const name = "hang-stopping";',
        'export default async function apply(ctx) {',
        '  // 征询器挂起：run 已结算——驱动侧吞 + onCallbackError 上报，不改写历史结果',
        '  ctx.on("turn_stopping", () => new Promise(() => {}));',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: hang-stopping\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );

    const { streamFn } = scriptedStream([textMessage('答')]);
    // stoppingTimeoutMs 小钟（30ms）：生产缺省 5s
    const runtime = await assemble({ streamFn, compositionDir, stoppingTimeoutMs: 30 });
    const result = await runtime.conversation!.submitOnce('问');

    // run 正常完成（completed）——turn_stopping 桥超时 reject 被驱动吞掉，
    // 不拖死 run 收尾、不改写已结算的结果
    expect(result?.status).toBe('completed');
  });

  it('composition/reloaded boot 路（增补 1/7④）：装载收口后派发——apply 期订阅可听到、无 ring1RestartRequired', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const markPath = join(compositionDir, 'boot-reloaded.json');
    const appDir = writeAppDir(
      compositionDir,
      [
        'import { writeFileSync } from "node:fs";',
        'export const name = "boot-signal";',
        `const MARK_PATH = ${JSON.stringify(markPath)};`,
        'export default async function apply(ctx) {',
        '  // apply 期订阅（装载器激活序 = apply 先于装载收口）：boot 派发时已在听——',
        '  // 「订阅晚于事件」空窗不存在，这是 boot 路可派发的时序依据',
        '  ctx.on("composition/reloaded", (payload) => writeFileSync(MARK_PATH, JSON.stringify(payload)));',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: boot-signal\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );

    const { streamFn } = scriptedStream([textMessage('好')]);
    await assemble({ streamFn, compositionDir });

    // boot 路派发已到达（收口即派发——assemble 返回时事件已过）
    expect(existsSync(markPath)).toBe(true);
    const payload = JSON.parse(readFileSync(markPath, 'utf8')) as {
      activated: string[];
      failed: string[];
      skipped: string[];
      ring1RestartRequired?: string[];
    };
    // 三清单合并自 Ring 1 + Ring 2/3 两批：默认层全行 + 本应用行在场
    expect(payload.activated).toContain('boot-signal');
    expect(payload.activated).toContain('memory');
    expect(payload.failed).toEqual([]);
    // boot 即 Ring 1 生效时点——无 ring1RestartRequired 键（与 /reload 路的唯一差异）
    expect(payload.ring1RestartRequired).toBeUndefined();
  });

  it('G1 失败降级（修复前必红——旧语义全量拒启）：第三方行 apply 抛错 → 平台照启 + 诊断文件落盘 + 失败行留账', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const appDir = writeAppDir(
      compositionDir,
      'export const name = "bad";\nexport default async function apply() {\n  throw new Error("第三方 apply 炸了");\n}\n',
    );
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: bad\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );

    // 钉独立数据目录（boot-failures.json 落盘点——不污染真实数据目录）
    const dataRoot = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-data-')));
    const prev = process.env['APP_DATA_DIR'];
    process.env['APP_DATA_DIR'] = dataRoot;
    try {
      const { streamFn } = scriptedStream([textMessage('好')]);
      // 修复前此处必红：第三方行失败 = 启动断言拒启抛 APP_LOAD_FAILED
      const runtime = await assemble({ streamFn, compositionDir });
      // 平台照启：默认层官方行照常激活（隔离不拖死宿主启动）
      expect(runtime.appsService.list().find((row) => row.id === 'memory')?.status).toBe('activated');
      // 失败行留账（ctx.apps.list 唯一事实源）
      const bad = runtime.appsService.list().find((row) => row.id === 'bad');
      expect(bad?.status).toBe('failed');
      expect(bad?.code).toBe(APP_APPLY_FAILED);
      // 诊断文件：boot 批整替写聚合 JSON——栈（apply 抛错族在场）+ pkg/apps
      // 影响面归因 + boot 时点（隔离 ≠ 静默的落盘半边）
      const diag = JSON.parse(readFileSync(join(dataRoot, 'boot-failures.json'), 'utf8')) as {
        bootTime: string;
        failures: Array<{ id: string; code: string; message: string; stack?: string; pkg?: string; apps?: string[] }>;
      };
      expect(typeof diag.bootTime).toBe('string');
      expect(diag.failures).toHaveLength(1);
      expect(diag.failures[0]).toMatchObject({ id: 'bad', code: APP_APPLY_FAILED, pkg: appDir, apps: ['chat'] });
      expect(typeof diag.failures[0]!.stack).toBe('string');
    } finally {
      if (prev === undefined) delete process.env['APP_DATA_DIR'];
      else process.env['APP_DATA_DIR'] = prev;
    }
  });

  it('全绿 boot 清账（基建大扫 #24）：degraded 为空时删除旧 boot-failures.json——零失败不冒陈年记录', async () => {
    // 钉独立数据目录 + 预写一份「陈年失败」文件（模拟上次 boot 的第三方失败残留）
    const dataRoot = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-data-')));
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    writeFileSync(
      join(dataRoot, 'boot-failures.json'),
      JSON.stringify({ bootTime: '2020-01-01T00:00:00Z', failures: [{ id: 'stale', code: 'X', message: '旧失败' }] }),
    );
    const prev = process.env['APP_DATA_DIR'];
    process.env['APP_DATA_DIR'] = dataRoot;
    try {
      const { streamFn } = scriptedStream([textMessage('好')]);
      await assemble({ streamFn, compositionDir }); // 全绿 boot（空 overlay 零第三方行）
      // 修前红：旧文件原样留盘（只在下次 degraded 时才被覆盖）→ exists true
      expect(existsSync(join(dataRoot, 'boot-failures.json'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env['APP_DATA_DIR'];
      else process.env['APP_DATA_DIR'] = prev;
    }
  });

  it('降级横幅双通道（基建大扫 #45）：degraded 投影进 runtime.bootDegraded——TUI 腿补发的数据源', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const appDir = writeAppDir(
      compositionDir,
      'export const name = "bad";\nexport default async function apply() {\n  throw new Error("横幅面探针");\n}\n',
    );
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: bad\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );
    const dataRoot = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-data-')));
    const prev = process.env['APP_DATA_DIR'];
    process.env['APP_DATA_DIR'] = dataRoot;
    try {
      const { streamFn } = scriptedStream([textMessage('好')]);
      const runtime = await assemble({ streamFn, compositionDir });
      // 修前红：AppRuntime 无此键 → undefined 上 toHaveLength 必炸
      expect(runtime.bootDegraded).toHaveLength(1);
      expect(runtime.bootDegraded[0]).toMatchObject({ id: 'bad', code: APP_APPLY_FAILED });
    } finally {
      if (prev === undefined) delete process.env['APP_DATA_DIR'];
      else process.env['APP_DATA_DIR'] = prev;
    }
  });

  it('G1 官方行拒启维持：builtin: 引用形失败（typo 官方件）→ 工厂抛 APP_LOAD_FAILED 聚合清单（不带病运行）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    writeFileSync(join(compositionDir, 'overlay.yaml'), `rows:\n  - id: memory\n    pkg: builtin:nonexistent\n`);
    // 不经 assemble 登记（工厂抛出即无 runtime 可关停）
    const attempt = createRuntime({
      dbPath: ':memory:',
      workspace: makeWorkspace(),
      compositionDir,
    });
    await expect(attempt).rejects.toMatchObject({ code: APP_LOAD_FAILED });
    await expect(attempt).rejects.toThrowError(/memory/); // 行 id 进聚合清单（归因）
  });

  it('dump-config 失败路径：打印合成树 + 失败清单退出码 1；空树成功路径退出码 0', async () => {
    const badDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const appDir = writeAppDir(badDir, 'export const name = "bad";\nexport default 42;\n');
    writeFileSync(
      join(badDir, 'overlay.yaml'),
      `rows:\n  - id: bad\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );
    // 钉独立数据目录（G1 降级后 boot 照启成功 → boot-failures.json 会落数据目录，
    // 不钉会写进真实数据目录）
    const dataRoot = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-data-')));
    const prev = process.env['APP_DATA_DIR'];
    process.env['APP_DATA_DIR'] = dataRoot;
    // 不传 persist——:memory: 全装配同构（P0-3）：显式 persist:false 会绕开持久层
    // 全真跑，正是诊断面要禁的侧门（P0-3 批主请求，2026-08-26）
    try {
      // G1 语义接续：boot 照启（第三方行隔离降级），诊断面自立「失败行在场 →
      // 退 1」规则——退出码语义与旧拒启态连续，触发面改为自查
      expect(await dumpConfigMain({ compositionDir: badDir })).toBe(1);
      expect(existsSync(join(dataRoot, 'boot-failures.json'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['APP_DATA_DIR'];
      else process.env['APP_DATA_DIR'] = prev;
    }

    const emptyDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    expect(await dumpConfigMain({ compositionDir: emptyDir })).toBe(0);
  });

  it('dump-config 挂载分组（D1 清单投影 F13）：应用行进「应用合成 chat」组、树行带 → 归属标记', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const appDir = writeAppDir(
      compositionDir,
      'export const name = "app-tool-plugin";\nexport default async function apply() {}\n',
    );
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: app-tool-plugin\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );
    // 捕获 stdout（dumpConfigMain 全输出经 process.stdout.write——诊断面无别名流）
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write);
    try {
      expect(await dumpConfigMain({ compositionDir })).toBe(0);
      const out = chunks.join('');
      // 树行标记：装载序视角下挂应用行显式标注归属（系统行缺省零标记零噪声）
      expect(out).toContain('app-tool-plugin：activated');
      expect(out).toContain('→ chat');
      // 分组分两类（F13）：官方默认层十七行全挂系统 + 应用合成按在册应用逐组打印
      expect(out).toContain('挂载分组（系统合成 + 各在册应用合成，契约篇 §5.1 两档）：');
      expect(out).toContain(
        '系统合成（17 行）：chat、memory、subagent、goal、scheduler、mcp、tools、web、compaction、admin、checkpoint、lsp、channels、webui、obs、browser、desktop',
      );
      expect(out).toContain('应用合成 chat（1 行）：app-tool-plugin');
      expect(out).toContain('应用合成 hermes（0 行）：（空——纯系统合成）');
    } finally {
      spy.mockRestore();
    }
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

/* ---------------- D3 装载分面分区全栈（契约篇 §5.1 装载律，2026-08-29） ---------------- */

/** 写独立行目录（writeAppDir 固定子目录名——分区用例多行并存需各自目录） */
function writeRowDir(compositionDir: string, rowId: string, source: string): string {
  const dir = join(compositionDir, `row-${rowId}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.ts'), source);
  return dir;
}

describe('D3 装载分面分区全栈（装载律①③ + 撞名域矩阵）', () => {
  it('装载律①扇出 + 装载序：跨区行挂系统相位恰一次，provide 扇出两应用区表——两区消费者 inject 命中（overlay 序在消费者之后也照常：系统相位先行于应用区）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-zone-')));
    // 两区消费者（各 inject 跨区行扇出面——装载成功的本身即证明系统相位先行：
    // 应用区装载在系统相位收口之后，扇出面若不在其读链内即 APP_INJECT_UNRESOLVED）
    const chatDir = writeRowDir(
      compositionDir,
      'chat-consumer',
      [
        'export const name = "chat-consumer";',
        'export const inject = ["acme/share"];',
        'export default async function apply(ctx) {',
        '  ctx.provide("acme/chat-ok", ctx.get("acme/share"));',
        '}',
      ].join('\n'),
    );
    const hermesDir = writeRowDir(
      compositionDir,
      'hermes-consumer',
      [
        'export const name = "hermes-consumer";',
        'export const inject = ["acme/share"];',
        'export default async function apply(ctx) {',
        '  ctx.provide("acme/hermes-ok", ctx.get("acme/share"));',
        '}',
      ].join('\n'),
    );
    // 跨区行（apps 双元素 → 挂系统相位装载恰一次 + provide 扇出两应用区表）
    // ——刻意排在 overlay 最后：分区装载序不随行序漂移
    const shareDir = writeRowDir(
      compositionDir,
      'x-share',
      [
        'export const name = "x-share";',
        'export default async function apply(ctx) {',
        '  ctx.provide("acme/share", { v: 42 });',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n` +
        `  - id: chat-consumer\n    pkg: ${chatDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n` +
        `  - id: hermes-consumer\n    pkg: ${hermesDir}\n    apps: [hermes]\n    sandbox: { carrier: main }\n` +
        `  - id: x-share\n    pkg: ${shareDir}\n    apps: [chat, hermes]\n    sandbox: { carrier: main }\n`,
    );

    const runtime = await assemble({ compositionDir });
    const byId = new Map(runtime.appsService.list().map((row) => [row.id, row]));
    // 恰一次：跨区行在状态面恰一行且激活；两消费者激活（boot 断言面已拒 failed）
    expect(byId.get('x-share')).toMatchObject({ status: 'activated' });
    expect(byId.get('chat-consumer')).toMatchObject({ status: 'activated' });
    expect(byId.get('hermes-consumer')).toMatchObject({ status: 'activated' });
    // 分区读链矩阵（tryResolveService 按区身份探测——宿主侧测试出口）
    const chatZone = appZoneId('chat');
    const hermesZone = appZoneId('hermes');
    expect(tryResolveService(runtime.ctx, chatZone, 'acme/share')).toMatchObject({ v: 42 }); // 扇出落 app:chat
    expect(tryResolveService(runtime.ctx, hermesZone, 'acme/share')).toMatchObject({ v: 42 }); // 扇出落 app:hermes
    expect(tryResolveService(runtime.ctx, 'system', 'acme/share')).toBeUndefined(); // 扇出不回流系统区表
    expect(tryResolveService(runtime.ctx, undefined, 'acme/share')).toBeUndefined(); // 宿主面亦不可见
    expect(tryResolveService(runtime.ctx, chatZone, 'acme/chat-ok')).toMatchObject({ v: 42 }); // 消费者注入值正确
    expect(tryResolveService(runtime.ctx, hermesZone, 'acme/chat-ok')).toBeUndefined(); // 跨应用视同缺失
  });

  it('装载律③负向：应用区行 inject 别应用独占服务 → APP_INJECT_UNRESOLVED 行失败隔离降级（区际依赖同拒——读链收窄结构性执法）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-zone-')));
    const chatDir = writeRowDir(
      compositionDir,
      'chat-provider',
      [
        'export const name = "chat-provider";',
        'export default async function apply(ctx) {',
        '  ctx.provide("acme/chat-only", 1);',
        '}',
      ].join('\n'),
    );
    const hermesDir = writeRowDir(
      compositionDir,
      'hermes-cross',
      [
        'export const name = "hermes-cross";',
        'export const inject = ["acme/chat-only"];',
        'export default async function apply() {}',
      ].join('\n'),
    );
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n` +
        `  - id: chat-provider\n    pkg: ${chatDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n` +
        `  - id: hermes-cross\n    pkg: ${hermesDir}\n    apps: [hermes]\n    sandbox: { carrier: main }\n`,
    );
    // 行失败留账带 APP_INJECT_UNRESOLVED（缺失名 = chat 独占词——hermes 读链
    // 恒看不见，Kahn 零进展即无解；旧单表形此处会误激活〔tryGet 全表可见〕）——
    // G1 后第三方行失败 = 隔离降级不拒启，读链收窄执法经留账面锁死
    const runtime = await assemble({ compositionDir });
    const failedRow = runtime.appsService.list().find((row) => row.id === 'hermes-cross');
    expect(failedRow?.status).toBe('failed');
    expect(failedRow?.code).toBe(APP_INJECT_UNRESOLVED);
    expect(failedRow?.message).toMatch(/acme\/chat-only/);
  });

  it('撞名域矩阵·异表并存：chat 行与 hermes 行 provide 同名词 → 两区各值并存合法（旧单表形此处必红——CONTEXT_SERVICE_EXISTS 回归锁）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-zone-')));
    const chatDir = writeRowDir(
      compositionDir,
      'dup-chat',
      [
        'export const name = "dup-chat";',
        'export default async function apply(ctx) {',
        '  ctx.provide("acme/dup", "chat值");',
        '}',
      ].join('\n'),
    );
    const hermesDir = writeRowDir(
      compositionDir,
      'dup-hermes',
      [
        'export const name = "dup-hermes";',
        'export default async function apply(ctx) {',
        '  ctx.provide("acme/dup", "hermes值");',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n` +
        `  - id: dup-chat\n    pkg: ${chatDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n` +
        `  - id: dup-hermes\n    pkg: ${hermesDir}\n    apps: [hermes]\n    sandbox: { carrier: main }\n`,
    );
    const runtime = await assemble({ compositionDir });
    const byId = new Map(runtime.appsService.list().map((row) => [row.id, row]));
    expect(byId.get('dup-chat')).toMatchObject({ status: 'activated' });
    expect(byId.get('dup-hermes')).toMatchObject({ status: 'activated' });
    expect(tryResolveService(runtime.ctx, appZoneId('chat'), 'acme/dup')).toBe('chat值');
    expect(tryResolveService(runtime.ctx, appZoneId('hermes'), 'acme/dup')).toBe('hermes值');
  });
});

/** 单区 reload fixture 源：provide 版本化服务 + 声明版本化事件词（卸词集差集的可观测面） */
function zoneWidgetSource(mark: string, evt: string): string {
  return [
    `export const name = "zone-widget";`,
    `export const events = [{ name: "${evt}", mode: "emit", note: "版本化事件词（D3 卸词集测试）" }];`,
    `export default async function apply(ctx) {`,
    `  ctx.provide("acme/${mark}-widget", { mark: ${JSON.stringify(mark)} });`,
    `}`,
  ].join('\n');
}

describe('D3 单区 reload（per-app reload 全栈——契约篇 §1.3 落码形态）', () => {
  it('换 chat 行不动 hermes 运行时：载荷 app 腿 + 卸词集警示 + 他区服务同实例（运行时真值沿用）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-zone-reload-')));
    const chatDir = writeRowDir(compositionDir, 'chat-widget', zoneWidgetSource('chat', 'acme/evt-v1'));
    const hermesDir = writeRowDir(compositionDir, 'hermes-widget', zoneWidgetSource('hermes', 'acme/h-evt'));
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n` +
        `  - id: chat-widget\n    pkg: ${chatDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n` +
        `  - id: hermes-widget\n    pkg: ${hermesDir}\n    apps: [hermes]\n    sandbox: { carrier: main }\n`,
    );
    const runtime = await assemble({ compositionDir });
    // composition/reloaded 观察哨（root 订阅——单区 dispose 只动该区锚）
    const reloadedPayloads: unknown[] = [];
    runtime.ctx.on('composition/reloaded', (payload: unknown) => {
      reloadedPayloads.push(payload);
    });
    const hermesBefore = tryResolveService(runtime.ctx, appZoneId('hermes'), 'acme/hermes-widget');

    // 换件：chat 行同路径改码（mark 换值 + 事件词改名——旧词进卸词集）
    writeFileSync(join(chatDir, 'index.ts'), zoneWidgetSource('chat', 'acme/evt-v2'));
    const result = await runtime.reload('chat');
    expect(result.payload).toEqual({
      activated: ['chat-widget'],
      failed: [],
      skipped: [],
      app: 'chat',
      droppedEvents: ['acme/evt-v1'], // 卸词集 = 该区旧词 ∖ 新词（真值基准，改名即旧词消失）
    });
    // 该区新码生效：新词进表、旧词消亡
    expect(tryResolveService(runtime.ctx, appZoneId('chat'), 'acme/chat-widget')).toMatchObject({ mark: 'chat' });
    // 他区运行时不动：hermes 服务**同一实例**（未被 dispose 未被重装载）
    expect(tryResolveService(runtime.ctx, appZoneId('hermes'), 'acme/hermes-widget')).toBe(hermesBefore);
    // applyLoad 状态面：他区行沿用旧装载结果（activated）、该区行新结果
    const byId = new Map(runtime.appsService.list().map((row) => [row.id, row]));
    expect(byId.get('hermes-widget')).toMatchObject({ status: 'activated' });
    expect(byId.get('chat-widget')).toMatchObject({ status: 'activated' });
    // 事件载荷 app 腿路由面（消费者按腿分辨单区/全量）
    expect(reloadedPayloads).toEqual([
      { activated: ['chat-widget'], failed: [], skipped: [], app: 'chat', droppedEvents: ['acme/evt-v1'] },
    ]);
  });

  it('空区卸载正路：overlay 删光该应用行 → 单区 reload = 纯回卷（载荷空清单 + 旧词全进卸词集）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-zone-empty-')));
    const chatDir = writeRowDir(compositionDir, 'chat-widget', zoneWidgetSource('chat', 'acme/evt-v1'));
    const hermesDir = writeRowDir(compositionDir, 'hermes-widget', zoneWidgetSource('hermes', 'acme/h-evt'));
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n` +
        `  - id: chat-widget\n    pkg: ${chatDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n` +
        `  - id: hermes-widget\n    pkg: ${hermesDir}\n    apps: [hermes]\n    sandbox: { carrier: main }\n`,
    );
    const runtime = await assemble({ compositionDir });
    expect(tryResolveService(runtime.ctx, appZoneId('chat'), 'acme/chat-widget')).toMatchObject({ mark: 'chat' });

    // 删光 chat 区行 → 单区 reload：锚出袋 + 空装载（= 该应用第三方件的卸载路径）
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: hermes-widget\n    pkg: ${hermesDir}\n    apps: [hermes]\n    sandbox: { carrier: main }\n`,
    );
    const result = await runtime.reload('chat');
    expect(result.payload).toEqual({
      activated: [],
      failed: [],
      skipped: [],
      app: 'chat',
      droppedEvents: ['acme/evt-v1'], // 区内唯一词随回卷消失——全量如实点名
    });
    // 该区表已清（回卷即卸载）；他区不受牵连
    expect(tryResolveService(runtime.ctx, appZoneId('chat'), 'acme/chat-widget')).toBeUndefined();
    expect(tryResolveService(runtime.ctx, appZoneId('hermes'), 'acme/hermes-widget')).toMatchObject({ mark: 'hermes' });
  });

  it('未知/不在册 appId = error 面（COMPOSITION_ROW_INVALID 同族拒绝式——命令面报错退出）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-zone-unknown-')));
    writeFileSync(join(compositionDir, 'overlay.yaml'), `rows: []\n`);
    const runtime = await assemble({ compositionDir });
    const bad = await runtime.reload('no-such-app');
    expect(bad.error).toContain('不在册');
    expect(bad.error).toContain('no-such-app');
  });

  it('registerSection app 行装载期拒载→隔离降级留账（注册面同族收口——prompt 段全局物化无域层）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-zone-prompt-')));
    const chatDir = writeRowDir(
      compositionDir,
      'prompt-row',
      [
        'export const name = "prompt-row";',
        'export default async function apply(ctx) {',
        '  ctx.get("prompts").registerSection({ id: "acme/sec", render: () => "x" });',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: prompt-row\n    pkg: ${chatDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );
    // 行 failed → G1 后隔离降级不拒启，拒载执法经失败行留账锁死（聚合清单带拒载词）
    const runtime = await assemble({ compositionDir });
    const failedRow = runtime.appsService.list().find((row) => row.id === 'prompt-row');
    expect(failedRow?.status).toBe('failed');
    expect(failedRow?.message).toMatch(/COMPOSITION_ROW_INVALID/);
    expect(failedRow?.message).toMatch(/提示词段注册被拒/);
  });
});

/* ---------------- /reload 组合树重载（M2 纵切收口） ---------------- */

/** 版本化应用源：工具执行回显 `<版本标记>:<入参>`——同路径改码后 reload 应换版本（jiti 驱逐） */
function versionedAppSource(mark: string): string {
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
function lastEchoText(runtime: AppRuntime): string {
  const toolResults = deriveMessages(runtime.session!.events).filter((m) => m.type === 'toolResult');
  const last = toolResults.at(-1)!;
  // 投影条目载荷经 convert 合成——content 文本在 message 字段族里，直接断整段 JSON 太脆，
  // 取 block 化文本（toolResult 投影含 content blocks）
  return JSON.stringify(last);
}

describe('/reload 组合树重载', () => {
  it('jiti 驱逐纪律全栈：同路径改码 → reload → 新代码生效（moduleCache:false 不吃旧模块）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-reload-')));
    const appDir = writeAppDir(compositionDir, versionedAppSource('v1'));
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: tool-plugin\n    pkg: ${appDir}\n    apps: [berrycode]\n    sandbox: { carrier: main }\n`,
    );
    // 脚本两轮齐全：每轮 toolCall+text（scriptedStream 只前进不回绕——缺项会钳在末条）
    const { streamFn } = scriptedStream([
      toolCallMessage('plug-echo', { text: '回声' }),
      textMessage('完成'),
      toolCallMessage('plug-echo', { text: '回声' }),
      textMessage('完成'),
    ]);
    const runtime = await assemble({ streamFn, compositionDir });
    // composition/reloaded 观察哨（root ctx 订阅——reload 只 dispose 应用锚，哨不动）
    const reloadedPayloads: unknown[] = [];
    runtime.ctx.on('composition/reloaded', (payload: unknown) => {
      reloadedPayloads.push(payload);
    });

    await runtime.conversation!.submitOnce('第一问');
    expect(lastEchoText(runtime)).toContain('v1:回声');

    // 同路径改码（版本标记换 v2）→ reload → 激活行照旧、代码是新求值的
    //（memory/subagent 为官方默认层两行，每次 reload 照常激活——恒在）
    writeFileSync(join(appDir, 'index.ts'), versionedAppSource('v2'));
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
        'checkpoint',
        'lsp',
        'webui',
        'obs',
        'browser',
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
          'checkpoint',
          'lsp',
          'webui',
          'obs',
          'browser',
          'tool-plugin',
        ],
        failed: [],
        skipped: [],
      },
    ]);

    await runtime.conversation!.submitOnce('第二问');
    expect(lastEchoText(runtime)).toContain('v2:回声'); // 新代码已生效
    // appsService 同实例就地更新（§1.3 服务集恒定——reload 前后 ctx 拿到同一个）
    expect(runtime.ctx.tryGet('apps')).toBe(runtime.appsService);
  });

  it('禁用行 reload：工具摘除 + writeHeader 落 change 快照 + loop 快照同步刷新', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-reload-')));
    const appDir = writeAppDir(compositionDir, versionedAppSource('v1'));
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: tool-plugin\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );
    const { streamFn, contexts } = scriptedStream([textMessage('首答'), textMessage('纯文本应答')]);
    const runtime = await assemble({ streamFn, compositionDir });
    // D2 触发②：行挂 app: chat → 工具落 chat 应用域层——全局口径不可见，应用域视角可见
    expect(runtime.tools.listFor('chat').map((t) => t.name)).toContain('plug-echo');
    // 首请求先落 initial（装载窗口语义：首张 header 由首 run 落——reload 的
    // change 快照才有 diff 基线）
    await runtime.conversation!.submitOnce('首问');

    // overlay 置 disabled → reload → 行变 skipped、工具摘除
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: tool-plugin\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n    disabled: true\n`,
    );
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
        'checkpoint',
        'lsp',
        'webui',
        'obs',
        'browser',
      ],
      failed: [],
      skipped: ['tool-plugin'],
    });
    // 应用工具已摘除（memory 五件 + agent 为默认装配成员——不受 overlay 禁用影响）。
    // 域键升级批：fs 驱动层挂活驱动 DriverEntry——跨 /reload 存续（本会话组成面
    // 照旧含 fs 四件）。agent_hermes 前移到 grep 后：/reload 重装载应用工具重新
    // 追加在其后（Map 注册序——幸存者在前），delegable 注册只在 boot、跨 /reload
    // 存续（应用注册表不动）
    expect(runtime.tools.compositionFor(runtime.session!.header.sessionId).map((t) => t.name)).toEqual([
      'find',
      'grep',
      'skill_manage',
      'agent_hermes',
      'memory_write',
      'memory_forget',
      'memory_restore',
      'memory_read',
      'memory_search',
      'memory_freeze',
      'memory_unfreeze',
      'memory_ttl',
      'memory_access_log',
      'agent',
      'goal_get',
      'goal_set',
      'goal_update',
      'fetch',
      'apps_list',
      'events_query',
      'apps_install',
      'apps_mount',
      'apps_unmount',
      'apps_update',
      'apps_toggle',
      'apps_configure',
      'apps_reload',
      'apps_uninstall_inspect',
      'obs_query',
      // browser 十件（第十六行——同上批）
      'browser_navigate',
      'browser_back',
      'browser_forward',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_scroll',
      'browser_screenshot',
      'browser_console',
      'read',
      'write',
      'edit',
      'ls',
      'bash',
      'todo',
    ]);
    expect(runtime.appsService.list().map((r) => [r.id, r.status])).toEqual([
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
      ['checkpoint', 'activated'],
      ['lsp', 'activated'],
      ['channels', 'activated'],
      ['webui', 'activated'],
      ['obs', 'activated'],
      ['browser', 'activated'],
      ['desktop', 'activated'],
      ['tool-plugin', 'skipped'],
    ]);

    // tools_change 即时刷新：后续 run 的模型可见工具集已无应用工具
    await runtime.conversation!.submitOnce('再问');
    expect(contexts.at(-1)?.tools?.map((t) => t.name)).not.toContain('plug-echo');

    // header 内建 diff：工具面变了 → 第二张快照 reason=change 且不含应用工具
    const headers = runtime.session!.events.filter((e) => e.type === 'request/header');
    expect(headers).toHaveLength(2);
    expect((headers[1]!.data as { reason: string }).reason).toBe('change');
    expect((headers[1]!.data as { toolSchemas: Array<{ name: string }> }).toolSchemas.map((t) => t.name)).not.toContain(
      'plug-echo',
    );
  });

  it('失败行两面语义的 reload 半边：逐行报告、进程存活、成功行照常运行', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-reload-')));
    const appDir = writeAppDir(compositionDir, versionedAppSource('v1'));
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: tool-plugin\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );
    const { streamFn } = scriptedStream([textMessage('活着')]);
    const runtime = await assemble({ streamFn, compositionDir });

    // overlay 加坏行（default 42 非 apply 函数 → 形状失败）→ reload 不抛、两态并报
    const badDir = join(compositionDir, 'bad-plugin');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'index.ts'), 'export const name = "bad";\nexport default 42;\n');
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: tool-plugin\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n  - id: bad\n    pkg: ${badDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
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
      'checkpoint',
      'lsp',
      'webui',
      'obs',
      'browser',
      'tool-plugin',
    ]);
    expect(result.payload?.failed).toEqual(['bad']);
    // 状态面：失败行带着错误码可见（「没生效」不静默）
    const badRow = runtime.appsService.list().find((r) => r.id === 'bad')!;
    expect(badRow.status).toBe('failed');
    expect(badRow.code).toMatch(/^APP_/);
    expect(runtime.tools.listFor('chat').map((t) => t.name)).toContain('plug-echo'); // 成功行照常（应用域层口径）
    // 进程存活：会话还能继续跑
    const answer = await runtime.conversation!.submitOnce('还活着吗');
    expect(answer?.status).toBe('completed');
  });

  it('overlay 树坏：error 面、原装配纹丝不动（预检后拆——旧锚不可逆动作先验）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-reload-')));
    const appDir = writeAppDir(compositionDir, versionedAppSource('v1'));
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: tool-plugin\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );
    const runtime = await assemble({ compositionDir });
    const rowsBefore = runtime.composition.rows;

    // 未知字段 → 拒绝式校验抛 COMPOSITION_ROW_INVALID；reload 返回 error 不动旧装配
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: tool-plugin\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n    bogus: 未知字段\n`,
    );
    const result = await runtime.reload();
    expect(result.error).toBeDefined();
    expect(result.payload).toBeUndefined();
    expect(runtime.tools.listFor('chat').map((t) => t.name)).toContain('plug-echo'); // 旧工具仍在（应用域层口径）
    expect(runtime.composition.rows).toEqual(rowsBefore); // 树报告未换
  });

  it('run 进行中排队重载（刀 2：结算后自动排水；串行链防双装载竞态）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-reload-')));
    const appDir = writeAppDir(compositionDir, versionedAppSource('v1'));
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: tool-plugin\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );
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
        'checkpoint',
        'lsp',
        'webui',
        'obs',
        'browser',
        'tool-plugin',
      ],
      failed: [],
      skipped: [],
    }); // run 结束后放行
  });

  /* ---- D3 分槽排队四分支（R2 测试补课批 2026-08-29，复盘 P1-3 #3）----
   * FULL_RELOAD_SLOT 分槽语义的零覆盖面：单区 busy 判定只看本 app 域（他应用
   * 在跑不阻断——D3 存在理由）、全量槽跨应用扣住（任意域 run 在跑即排队）、
   * 排水竞速静默重排（排水瞬间新 run 起跑 → reloadOnce 落回 queued 留待下次
   * 结算）。双应用域 busy 态经 drivers.open({ app: hermes 清单 }) 造第二驱动
   * 条目——anyRunActive 判据键 = 条目 appId（boot 缺省 chat 域 + hermes 域两分）。 */

  /** 多闸门脚本流：第 i 次模型调用等第 i 道闸（逐 run 独立放行——时序编排用） */
  const gatedStream = (count: number): { streamFn: StreamFn; release: (index: number) => void } => {
    const gates = Array.from({ length: count }, () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    });
    let calls = 0;
    const streamFn: StreamFn = () => {
      const index = Math.min(calls, count - 1);
      calls += 1;
      const answer = textMessage(`闸${index}答`);
      const gate = gates[index]!.promise;
      return {
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
      };
    };
    return { streamFn, release: (index: number) => gates[index]!.resolve() };
  };

  /** 轮询等待谓词成真（排水链含真实装载 IO——宏任务轮询，5s 上限防挂死） */
  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 250 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(check()).toBe(true);
  };

  /** 双区 fixture：chat/hermes 各一行独占件 + 跨区行一件（busy 态/排水/跨区行
   * 单区不动三观测面共用——跨区行 apps 枚举两应用，provide 扇出两区表、效果
   * 链挂系统锚〔装载律①〕，单区 reload 的行→区谓词对它是 undefined 不卷入） */
  const slotFixture = async (streamFn: StreamFn): Promise<AppRuntime> => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-slot-')));
    const chatDir = writeRowDir(compositionDir, 'chat-widget', zoneWidgetSource('chat', 'acme/evt-v1'));
    const hermesDir = writeRowDir(compositionDir, 'hermes-widget', zoneWidgetSource('hermes', 'acme/h-evt'));
    const crossDir = writeRowDir(compositionDir, 'cross-widget', zoneWidgetSource('cross', 'acme/x-evt'));
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n` +
        `  - id: chat-widget\n    pkg: ${chatDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n` +
        `  - id: hermes-widget\n    pkg: ${hermesDir}\n    apps: [hermes]\n    sandbox: { carrier: main }\n` +
        `  - id: cross-widget\n    pkg: ${crossDir}\n    apps: [chat, hermes]\n    sandbox: { carrier: main }\n`,
    );
    return assemble({ streamFn, compositionDir });
  };

  it('分槽分支①②：他应用 run 在跑不阻断本应用单区 reload——busy 判定只看本 app 域（D3 存在理由）', async () => {
    const { streamFn, release } = gatedStream(1);
    const runtime = await slotFixture(streamFn);
    const hermesBefore = tryResolveService(runtime.ctx, appZoneId('hermes'), 'acme/hermes-widget');

    // hermes 域第二驱动起 gated run（busy 态落他应用域——条目 appId = hermes）
    const hermesEntry = runtime.drivers.open({ app: runtime.apps.get('hermes')! })!;
    expect(hermesEntry.appId).toBe('hermes');
    const slow = hermesEntry.driver.submitOnce('慢问');
    expect(hermesEntry.driver.isRunning).toBe(true);

    // 单区 reload('chat')：chat 域闲 → 即时执行（不进槽、不返 queued）——D3 之前的
    // 全局 busy 闸此刻会排队，分槽后他应用在跑与本应用换件互不相干
    const result = await runtime.reload('chat');
    expect(result.queued).toBeUndefined();
    expect(result.payload).toEqual({ activated: ['chat-widget'], failed: [], skipped: [], app: 'chat' });
    expect(result.payload?.droppedEvents).toBeUndefined(); // 同词重载零卸词
    expect(tryResolveService(runtime.ctx, appZoneId('hermes'), 'acme/hermes-widget')).toBe(hermesBefore); // 他区实例不动

    release(0);
    await slow;
  });

  it('分槽分支③：全量槽跨应用扣住——他应用 run 在跑全量 reload 排队，其结算自动排水恰一次（载荷无 app 腿）', async () => {
    const { streamFn, release } = gatedStream(1);
    const runtime = await slotFixture(streamFn);
    const reloaded: unknown[] = [];
    runtime.ctx.on('composition/reloaded', (payload: unknown) => {
      reloaded.push(payload);
    });

    const hermesEntry = runtime.drivers.open({ app: runtime.apps.get('hermes')! })!;
    const slow = hermesEntry.driver.submitOnce('慢问');
    // 全量 busy 判定全域——跨应用扣住 '*' 槽（busy 态在 hermes 域仍扣住全量）
    expect(await runtime.reload()).toEqual({ queued: true });

    release(0);
    await slow;
    // run 结算回调自动排水：排队的全量 reload 落地（真实装载 + composition/reloaded）
    await until(() => reloaded.length === 1);
    const payload = reloaded[0] as { activated: string[]; app?: string };
    expect(payload.activated).toEqual(expect.arrayContaining(['chat-widget', 'hermes-widget']));
    expect(payload.app).toBeUndefined(); // 无 app 腿 = 全量
    expect(reloaded).toHaveLength(1); // 槽先清再执行——恰一次
  });

  it('分槽分支④：排水竞速静默重排——排水瞬间新 run 起跑，reloadOnce 落回 queued 留待下次结算（零丢弃零双跑）', async () => {
    const { streamFn, release } = gatedStream(2);
    const runtime = await slotFixture(streamFn);
    const reloaded: unknown[] = [];
    runtime.ctx.on('composition/reloaded', (payload: unknown) => {
      reloaded.push(payload);
    });
    const run1 = runtime.conversation!.submitOnce('第一问');
    expect(await runtime.reload()).toEqual({ queued: true });

    // 竞速装填：本订阅注册序晚于 boot 武装的排水钩子——run1 结算 dispatch 时钩子
    // 先行清槽并经串行链（微任务）排 reloadOnce，本订阅随即同步起 run2（launch 在
    // 首个 await 前同步置 isRunning）；微任务轮到 reloadOnce 时 busy 命中 → 静默
    // 重排 '*' 槽（无通知无丢弃），留待 run2 结算再排
    let relayRun: Promise<unknown> | undefined;
    let relayStarted = false;
    runtime.ctx.get<AgentServiceFace>('agent').onRunSettled(() => {
      if (relayStarted) return;
      relayStarted = true;
      relayRun = runtime.conversation!.submitOnce('第二问');
    });

    release(0);
    await run1;
    await new Promise((resolve) => setTimeout(resolve, 50)); // 排水尝试 + 竞速重排落定
    expect(relayStarted).toBe(true);
    expect(reloaded).toEqual([]); // 排水被竞速扣回——重载零执行零丢弃

    release(1);
    await relayRun;
    await until(() => reloaded.length === 1); // run2 结算二次排水恰一次执行
    expect((reloaded[0] as { app?: string }).app).toBeUndefined();
    expect(reloaded).toHaveLength(1);
  });

  it('跨区行单区 reload 不动（R2 测试小项④）：apps:[chat,hermes] 系统相位行——reload(chat) 后两区扇出绑定同实例仍可解析（行→区谓词的全栈兑现）', async () => {
    const { streamFn } = scriptedStream([textMessage('好')]);
    const runtime = await slotFixture(streamFn);
    const crossChat = tryResolveService(runtime.ctx, appZoneId('chat'), 'acme/cross-widget');
    const crossHermes = tryResolveService(runtime.ctx, appZoneId('hermes'), 'acme/cross-widget');
    expect(crossChat).toMatchObject({ mark: 'cross' }); // 前置：跨区行 provide 扇出两区表
    expect(crossHermes).toBe(crossChat); // 同键同实例——「一值各归各区」语义

    const result = await runtime.reload('chat');
    // 载荷不含跨区行：单区谓词只收独占行（apps 恰一元素）——跨区行若被误卷入
    // activated 即 ['chat-widget','cross-widget'] 双元素，toEqual 即红。fleet 层
    // 谓词单测已锁（bridge-fleet.test.ts terminateZone 用例），本面补全栈合成锁
    expect(result.payload).toEqual({ activated: ['chat-widget'], failed: [], skipped: [], app: 'chat' });
    // 扇出绑定不动：两区表内同键仍同实例（效果链挂 apps:system 锚——chat 区
    // 锚 dispose 只回卷本区注册链，跨区行的区表写入按作用域归属存活）
    expect(tryResolveService(runtime.ctx, appZoneId('chat'), 'acme/cross-widget')).toBe(crossChat);
    expect(tryResolveService(runtime.ctx, appZoneId('hermes'), 'acme/cross-widget')).toBe(crossChat);
  });

  it('命令薄壳链全栈：/apps 清单 + /apps-toggle 链 reload + install 仓库态 → /apps-mount 生效（D2 新链）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-reload-')));
    const appDir = writeAppDir(compositionDir, versionedAppSource('v1'));
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: tool-plugin\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );
    const { streamFn } = scriptedStream([textMessage('好')]);
    const runtime = await assemble({ streamFn, compositionDir });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);

    // /apps：状态行可见
    expect(await runtime.channels.commands.dispatch('/apps')).toBe('ok');
    expect(notifies.some((n) => n.includes('tool-plugin') && n.includes('✓'))).toBe(true);

    // /apps-toggle：翻转 + 自动链 reload（对账与组合正交——壳负责串两步）
    expect(await runtime.channels.commands.dispatch('/apps-toggle tool-plugin')).toBe('ok');
    expect(notifies.some((n) => n.includes('已禁用'))).toBe(true);
    expect(notifies.some((n) => n.includes('已重载：组合激活'))).toBe(true);
    expect(runtime.tools.listFor('chat').map((t) => t.name)).not.toContain('plug-echo');

    // /apps-install local 源（零子进程）：D2 仓库态——只入账本零行零生效，
    // 不链 reload（install→reload 旧链废止）；/apps ◇ 差集行可见挂载指引
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
        '      description: "第二件应用工具（install 仓库态→mount 生效链测试）",',
        '      parameters: { type: "object", properties: {} },',
        '      execute: async () => ({ content: [{ type: "text", text: "twin" }] }),',
        '    }),',
        '  );',
        '}',
      ].join('\n'),
    );
    expect(await runtime.channels.commands.dispatch(`/apps-install ${twinDir}`)).toBe('ok');
    expect(notifies.some((n) => n.includes('已入仓库态') && n.includes('local'))).toBe(true);
    expect(runtime.tools.listFor('chat').map((t) => t.name)).not.toContain('plug-twin'); // 装了没挂 = 零生效
    // /apps ◇ 差集行：装了没挂必须可见 + 挂载指引（装机面不是断头路）
    expect(await runtime.channels.commands.dispatch('/apps')).toBe('ok');
    expect(notifies.some((n) => n.includes('◇ twin-plugin') && n.includes('已装未挂'))).toBe(true);

    // /apps-mount：写组合行 + 壳链 /reload → 新工具经 chat 应用域层可见（D2 生效链）
    expect(await runtime.channels.commands.dispatch('/apps-mount twin-plugin --apps chat --carrier main')).toBe('ok');
    expect(notifies.some((n) => n.includes('已挂载 twin-plugin') && n.includes('chat'))).toBe(true);
    expect(notifies.some((n) => n.includes('已重载：组合激活'))).toBe(true);
    expect(runtime.tools.listFor('chat').map((t) => t.name)).toContain('plug-twin');
    expect(runtime.appsService.list().map((r) => [r.id, r.status])).toEqual([
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
      ['checkpoint', 'activated'],
      ['lsp', 'activated'],
      ['channels', 'activated'],
      ['webui', 'activated'],
      ['obs', 'activated'],
      ['browser', 'activated'],
      ['desktop', 'activated'],
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
    const err = await createRuntime({
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
          'checkpoint',
          'lsp',
          'webui',
          'obs',
          'browser',
        ],
        failed: [],
        skipped: [],
        ring1RestartRequired: ['tools'],
      },
    ]);
    // 不回卷语义：ring1Anchor 不在 reload dispose 面——tools 服务同一实例、工具面原样。
    // 序不敏感比对（sort 双侧）：/reload 重装载使应用工具重注册到 agent_hermes
    // 之后（Map 注册序漂移），工具面集合不变才是本断言的本体
    expect(runtime.ctx.get('tools')).toBe(toolsBefore);
    expect([...runtime.tools.list().map((t) => t.name)].sort()).toEqual([...namesBefore].sort());
    // 行状态面：tools 行仍 activated（沿用 boot 装载结果 = 运行时真值）
    expect(runtime.appsService.list().find((r) => r.id === 'tools')).toMatchObject({ status: 'activated' });
  });

  it('对照面：/reload 无 Ring 1 行变更 → 载荷不带 ring1RestartRequired 字段（不虚报）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-ring1-noop-')));
    const appDir = writeAppDir(compositionDir, versionedAppSource('v1'));
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: tool-plugin\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );
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
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false, context: false },
      start(_request) {
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

    // durable 双事件：llm/usage 折叠（background 道，callId = 'delegation:' 前缀 +
    // 子运行 id——复盘 R-1 判别式同源）+ user/message 带归因。
    // 底账统一（契约篇 §5.4）：主循环 turn 先自折 foreground 道，结算再折 background 道——
    // 两道并存不冲突，find 只认 background 的折叠才是结算产物
    const usageEvents = runtime.session!.events.filter((e) => e.type === 'llm/usage');
    const foreground = usageEvents.find((e) => (e.data as { priority: string }).priority === 'foreground');
    expect(foreground?.data).toMatchObject({
      callId: expect.stringMatching(/^turn:/),
      priority: 'foreground',
      // NO_USAGE 夹具零 cache——四桶齐落（P1-5 全桶入账后 usage 恒四桶起）
      usage: { input: NO_USAGE.input, output: NO_USAGE.output, cacheRead: 0, cacheWrite: 0 },
    });
    const background = usageEvents.find((e) => (e.data as { priority: string }).priority === 'background');
    expect(background?.data).toEqual({
      callId: 'delegation:stub-sub-run',
      model: expect.any(String),
      priority: 'background',
      // 结算折叠腿同归一函数：四桶齐落 + totalTokens（夹具 150）滤除
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
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

/* ---------------- 生命周期两时点（二十九批 P1-6：装载收口补播 + shutdown bounded） ---------------- */

describe('session_start 装载收口补播（二十九批增补 8①）', () => {
  /** 补播探针应用：订阅 session_start 落袋 + plug-starts 工具读袋（测试资产） */
  function writeStartProbe(compositionDir: string): void {
    const appDir = writeAppDir(
      compositionDir,
      [
        'export const name = "start-probe";',
        'export const inject = ["tools"];',
        'export default async function apply(ctx) {',
        '  const starts = [];',
        '  const tools = ctx.get("tools");',
        '  ctx.effect(() => ctx.on("session_start", (payload) => starts.push(payload)));',
        '  ctx.effect(() =>',
        '    tools.register({',
        '      name: "plug-starts",',
        '      description: "session_start 探针读袋（测试资产——装载收口补播回归锁）",',
        '      parameters: { type: "object", properties: {} },',
        '      execute: async () => ({ content: [{ type: "text", text: JSON.stringify(starts) }] }),',
        '    }),',
        '  );',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: start-probe\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );
  }

  /** 读探针袋（经真工具面——应用侧记录的 session_start 载荷清单）。探针行挂
   * app: chat（触发② 必填）→ 工具落 chat 应用域层，get 全局面取不到——按
   * 应用域视角按名取（D1 域层路由口径） */
  async function readStarts(runtime: AppRuntime): Promise<{ sessionId?: string; origin?: string; replay?: boolean }[]> {
    const def = runtime.tools.listFor('chat').find((t) => t.name === 'plug-starts');
    if (def === undefined) throw new Error('探针工具未注册：plug-starts');
    const result = await runtime.tools.toAgentTool(def).execute('tc-replay', {});
    return JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
  }

  it('boot 收口补播：晚装载应用收到恰一枚 {sessionId, origin, replay:true}——活体（chat 首行 apply 期发射）它结构性收不到', async () => {
    // 修复前必红：boot 无补播，晚装载应用 starts 袋恒空
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-replay-')));
    writeStartProbe(compositionDir);
    const runtime = await assemble({ compositionDir });
    try {
      const starts = await readStarts(runtime);
      expect(starts).toHaveLength(1);
      // 载荷两维分离：origin = 建会事实（新库新会话 = initial）、replay = 投递标记
      expect(starts[0]!.sessionId).toBe(runtime.session!.header.sessionId);
      expect(starts[0]!.origin).toBe('initial');
      expect(starts[0]!.replay).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  });

  it('/reload 收口同型补播：锚回卷后重挂的监听器再收一枚 replay:true（次序先于 composition/reloaded）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-replay-reload-')));
    writeStartProbe(compositionDir);
    const runtime = await assemble({ compositionDir });
    try {
      expect(await readStarts(runtime)).toHaveLength(1); // boot 补播一枚
      // /reload：锚 dispose 回卷旧监听 → 重装载（jiti 逐次求值，starts 袋全新）
      // → 收口补播再达。修复前必红：重挂监听器收不到任何 session_start
      const reloaded = await runtime.reload();
      expect(reloaded.payload?.activated).toContain('start-probe');
      const starts = await readStarts(runtime);
      expect(starts).toHaveLength(1);
      expect(starts[0]!.sessionId).toBe(runtime.session!.header.sessionId);
      expect(starts[0]!.origin).toBe('initial');
      expect(starts[0]!.replay).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  });
});

describe('session_shutdown parallel bounded（二十九批增补 8②）', () => {
  it('慢清理器（200ms）被等待完成且先于关停返回——emit 时代必红（fire-and-forget 吞清理 Promise）', async () => {
    const runtime = await assemble({ streamFn: scriptedStream([textMessage('答')]).streamFn });
    let cleaned = false;
    runtime.ctx.on('session_shutdown', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      cleaned = true;
    });
    const start = Date.now();
    await runtime.shutdown();
    // 真等待了清理器（elapsed ≥ 200ms）且完成先于返回（close 不再先行）
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
    expect(cleaned).toBe(true);
  });

  it('挂死清理器：单条目 2s 预算到点放弃等待继续关停——shutdown 不挂死（bounded 上限回归锁）', async () => {
    const runtime = await assemble({ streamFn: scriptedStream([textMessage('答')]).streamFn });
    runtime.ctx.on('session_shutdown', () => new Promise<never>(() => {})); // 永不决议
    const start = Date.now();
    await runtime.shutdown(); // 无上限时代本行挂死 → 测试超时红
    expect(Date.now() - start).toBeLessThan(5_000); // 2s 预算 + flush/close 余量
  }, 10_000);
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
  runtime: AppRuntime,
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
  it('小桶注入：容量耗尽后两面同桶 fail-loud（APP_EVENT_RATE 一码三面之三）', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const runtime = await assemble({ sessionSpawnRateLimit: { capacity: 1, perMinute: 1 } });
      const sessions = runtime.ctx.tryGet<SessionsSpawnFace>('sessions')!;
      // 第一发过（容量 1）
      await sessions.createSession({ seed: closedSeed() });
      // 第二发 fork 撞桶：同桶不同面——message 带面名（fork）可分辨
      await expect(sessions.fork()).rejects.toMatchObject({
        code: APP_EVENT_RATE,
        message: expect.stringContaining('fork'),
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('exec 命令进程孤儿清扫（契约篇 §6.6 exec 腿，2026-08-29 critic #1）', () => {
  /** pid 判活（signal 0 探测——EPERM 也算活） */
  function pidAlive(pid: number | undefined): boolean {
    if (pid === undefined) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  /** 轮询直到谓词真（进程死是异步到达面） */
  async function until(predicate: () => boolean, ms = 10_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect.unreachable(`轮询超时（${ms}ms）`);
  }

  it('boot 扫登记簿：宿主猝死遗留命令进程被树杀、簿面归零（修前无清扫——遗留永活）', { timeout: 30_000 }, async () => {
    // 隔离数据目录（路径面统一走 APP_DATA_DIR——dumpConfig 用例同款钉法；
    // 自管生命周期：关停须在 env 复原前完成）
    const dataRoot = mkdtempSync(join(realpathSync(tmpdir()), 'app-exec-sweep-'));
    const prev = process.env['APP_DATA_DIR'];
    process.env['APP_DATA_DIR'] = dataRoot;
    let runtime: AppRuntime | undefined;
    try {
      // 伪造「上一宿主猝死」形态：hostPid 已死 + 活命令进程（长命 sleep）在簿。
      // zombie 必须同 runArgv 形态建组（POSIX detached = 自成组长——killTree
      // 负 pid 组杀的射程前提；非建组 spawn 组杀 ESRCH 静默空手）
      const zombie = spawn('sleep', ['25'], {
        stdio: 'ignore',
        ...(process.platform === 'win32' ? {} : { detached: true }),
      });
      const deadHost = spawn('true');
      await new Promise<void>((resolve) => deadHost.on('exit', () => resolve()));
      expect(pidAlive(zombie.pid)).toBe(true); // 前置：遗留命令进程活着
      mkdirSync(join(dataRoot, 'exec'), { recursive: true });
      writeFileSync(
        join(dataRoot, 'exec', 'children.json'),
        `${JSON.stringify([{ hostPid: deadHost.pid, childPid: zombie.pid, server: 'exec', command: 'sleep 25' }])}\n`,
        'utf8',
      );
      // 真库 boot（:memory: 诊断路零副作用不动手——本用例必须走真库触发清扫）
      const { streamFn } = scriptedStream([textMessage('回执')]);
      runtime = await createRuntime({
        dbPath: join(dataRoot, 'sessions.db'),
        workspace: makeWorkspace(),
        streamFn,
      });
      // 装配期清扫：hostPid 不活 = 猝死遗留 → ps 验命令行含 'sleep 25'（PID
      // 复用防护）→ killTree 树杀；条目随杀随删（簿面归零）
      await until(() => !pidAlive(zombie.pid));
      const ledger = JSON.parse(readFileSync(join(dataRoot, 'exec', 'children.json'), 'utf8')) as unknown[];
      expect(ledger).toEqual([]);
      await runtime.shutdown();
      runtime = undefined;
    } finally {
      if (runtime !== undefined) await runtime.shutdown().catch(() => undefined);
      if (prev === undefined) delete process.env['APP_DATA_DIR'];
      else process.env['APP_DATA_DIR'] = prev;
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

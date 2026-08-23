/**
 * L5 app — 组合根全栈测试（scripted streamFn + 真实装配，mock 只停在模型层）。
 *
 * 验证接线而非各模块行为（各模块有 1-to-1 测试）：事件落库、投影回读、
 * carve-out 全栈链（审批 → 守门 → durable 三事件齐）、持久化 round-trip、
 * 多轮续跑、命令面注册。
 */

import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
// 重开库须带与组合根同链迁移（memory 表族 v2 + session_fts v3——宿主裸开只识 v1，
// 高版本库拒绝打开是持久层纪律，此处镜像装配面真链）
// 重开库须带与组合根同链迁移（memory 表族 v2 + session_fts v3 + goals v5——
// 宿主裸开只识 v1，少一段即拒开；此处镜像装配面真链）
import { MEMORY_MIGRATION, SESSION_FTS_MIGRATION } from '../memory/index.js';
import { GOAL_MIGRATION } from '../goal/index.js';
import { createBerryRuntime, ConversationDriver } from './assembly.js';
import type { BerryRuntime } from './assembly.js';
import { defaultConvertToLlm } from './convert.js';
import { runOnceMain } from './run-main.js';
import { dumpConfigMain } from './dump-config.js';
import { PLUGIN_LOAD_FAILED } from '../contracts/errors.js';
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
    // agent + goal 第三行工具三件（goal 纵切二起为默认装配现实）
    expect(runtime.tools.list().map((t) => t.name)).toEqual([
      'read',
      'write',
      'edit',
      'ls',
      'memory_write',
      'memory_forget',
      'memory_restore',
      'memory_read',
      'memory_search',
      'agent',
      'goal_get',
      'goal_set',
      'goal_update',
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

  it('persist:false 不开库不建会话（dump-config 姿态）', async () => {
    const runtime = await assemble({ persist: false });
    expect(runtime.persistence).toBeUndefined();
    expect(runtime.session).toBeUndefined();
    expect(runtime.tools.list()).toHaveLength(5); // fs 四件 + agent（memory/goal 空转；subagent 无持久层照常）
  });

  it('技能发现注入：SKILL.md 落临时位置后进系统提示词 + /skill 命令注册', async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'app-skill-'));
    mkdirSync(join(home, '.berry', 'skills', 'demo'), { recursive: true });
    writeFileSync(
      join(home, '.berry', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: 演示技能\n---\n\n演示指令体\n',
    );
    const runtime = await assemble({ homeDir: home });
    expect(runtime.skills.list().map((s) => s.name)).toEqual(['demo']);
    expect(runtime.systemPrompt).toContain('<name>demo</name>');
    expect(runtime.channels.commands.lookup('skill:demo')).toBeDefined();
  });
});

/* ---------------- 会话驱动全栈 ---------------- */

describe('ConversationDriver + durable 接线', () => {
  it('submitOnce 单轮：request/header + turn + 消息全落库；投影回读两条', async () => {
    const { streamFn, contexts } = scriptedStream([textMessage('你好，完成')]);
    const runtime = await assemble({ streamFn });
    const result = await runtime.conversation.submitOnce('做点什么');
    expect(result?.status).toBe('completed');
    expect(types(runtime)).toEqual([
      'sandbox/mode',
      'request/header',
      'turn/start',
      'user/message',
      'assistant/message',
      'turn/end',
    ]);
    // LLM 请求上下文含系统提示词与工具面（装配接线证据；memory 五件 + agent +
    // goal 三件为默认装配成员）
    expect(contexts[0]?.systemPrompt).toContain('terminal-based coding assistant');
    expect(contexts[0]?.tools?.map((t) => t.name)).toEqual([
      'read',
      'write',
      'edit',
      'ls',
      'memory_write',
      'memory_forget',
      'memory_restore',
      'memory_read',
      'memory_search',
      'agent',
      'goal_get',
      'goal_set',
      'goal_update',
    ]);
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

    const result = await runtime.conversation.submitOnce('改 git 配置');
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

    const result = await runtime.conversation.submitOnce('改 git 配置');
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
    await runtime.conversation.submitOnce('问');
    // 镜像与 durable 同序同量（sandbox/mode 在订阅前已落，不重播——历史不是活体）
    expect(mirrored.map((m) => m.event.type)).toEqual([
      'request/header',
      'turn/start',
      'user/message',
      'assistant/message',
      'turn/end',
    ]);
    // 信封归属：全部事件带同一 sessionId（dsh-11——多会话并存可分辨）
    const id = runtime.session!.header.sessionId;
    expect(mirrored.every((m) => m.sessionId === id)).toBe(true);
    // 事件本体即 SessionEvent（seq 连续递增，非重制副本）
    expect(mirrored.map((m) => m.event.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('tools_change 接线（骨架篇 §9.2 装配层义务）：注册即刷新 loop 工具快照 + 即时落 header change 快照', async () => {
    const { streamFn, contexts } = scriptedStream([
      textMessage('首轮'),
      toolCallMessage('echo', { text: '回声' }),
      textMessage('完成'),
    ]);
    const runtime = await assemble({ streamFn });
    await runtime.conversation.submitOnce('第一问');
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

    // 第二轮：loop 每次模型请求读 context.tools（活数组已刷新）——新工具对模型可见可调用
    await runtime.conversation.submitOnce('用 echo');
    expect(contexts[1]?.tools?.map((t) => t.name)).toEqual([
      'read',
      'write',
      'edit',
      'ls',
      'memory_write',
      'memory_forget',
      'memory_restore',
      'memory_read',
      'memory_search',
      'agent',
      'goal_get',
      'goal_set',
      'goal_update',
      'echo',
    ]);
    expect(executions).toBe(1); // 真走了三段管道执行（非仅 schema 可见）
    expect(runtime.session!.events.some((e) => e.type === 'tool/result')).toBe(true);
  });

  it('多轮续跑：第二个 run 复用同一活数组时间线', async () => {
    const { streamFn, contexts } = scriptedStream([textMessage('第一答'), textMessage('第二答')]);
    const runtime = await assemble({ streamFn });
    await runtime.conversation.submitOnce('第一问');
    await runtime.conversation.submitOnce('第二问');
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
    runtime.conversation.addDisplay((event) => {
      if (event.type === 'message_end' && !violated) {
        violated = true;
        throw new Error('展示回调炸了');
      }
    });

    const result = await runtime.conversation.submitOnce('会炸的问题');
    expect(result?.status).toBe('failed');
    // 修 b 前缺 turn/end：日志留敞开 turn，恢复协议对「孤儿+后续正常 turn」失据
    expect(types(runtime)).toEqual([
      'sandbox/mode',
      'request/header',
      'turn/start',
      'user/message',
      'assistant/message',
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
    await runtime.conversation.submitOnce('要持久化的问题');
    await runtime.shutdown();

    const reopened = Persistence.open({
      path: dbFile,
      migrations: [MEMORY_MIGRATION, SESSION_FTS_MIGRATION, GOAL_MIGRATION],
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
    await first.conversation.submitOnce('第一问');
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
      await second.conversation.submitOnce('第二问');
      expect(script2.contexts[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      // header 序列：首程 initial + 续程首快照 resume——组装参数未变不多落
      const headers = second.session!.events.filter((e) => e.type === 'request/header');
      expect(headers.map((e) => (e.data as { reason: string }).reason)).toEqual(['initial', 'resume']);
      // sandbox/mode 同档不重复（全日志仅首程一条——fold 取最后，重复只污染日志）
      expect(second.session!.events.filter((e) => e.type === 'sandbox/mode')).toHaveLength(1);
      // 第二 run 同 config：不落新快照（会话篇 §1.3 仅变化时落）
      await second.conversation.submitOnce('第三问');
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
    const result = await runtime.conversation.submitOnce('问');
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
    await runtime.conversation.submitOnce('旧问');
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
    await runtime.conversation.submitOnce('新问');
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

    const pending = runtime.conversation.submitOnce('慢问');
    expect(runtime.conversation.isRunning).toBe(true); // launch 同步置位——run 已在跑
    runtime.channels.commands.lookup('new')!.handler(''); // 热切换被拒
    expect(notifies.some((n) => n.includes('不能开新会话'))).toBe(true);
    const idBefore = runtime.session!.header.sessionId;

    release();
    const result = await pending;
    expect(result?.status).toBe('completed'); // 拒切换不影响在跑 run
    expect(runtime.session!.header.sessionId).toBe(idBefore); // 会话未变
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
    // goal 三行 + overlay tool-plugin 行均 activated——list 状态行序 = 组合树序）
    expect(runtime.plugins.list()).toEqual([
      { id: 'memory', status: 'activated', name: 'memory' },
      { id: 'subagent', status: 'activated', name: 'subagent' },
      { id: 'goal', status: 'activated', name: 'goal' },
      { id: 'tool-plugin', status: 'activated', name: 'tool-plugin' },
    ]);
    expect(runtime.ctx.tryGet<{ list(): unknown[] }>('plugins')).toBeTruthy();
    // 组合树报告带行（官方默认层打底在前）
    expect(runtime.composition.rows.map((row) => row.id)).toEqual(['memory', 'subagent', 'goal', 'tool-plugin']);
    // 插件工具已进注册表（fs 四件 + memory 五件 + agent + goal 三件之后）
    expect(runtime.tools.list().map((t) => t.name)).toEqual([
      'read',
      'write',
      'edit',
      'ls',
      'memory_write',
      'memory_forget',
      'memory_restore',
      'memory_read',
      'memory_search',
      'agent',
      'goal_get',
      'goal_set',
      'goal_update',
      'plug-echo',
    ]);
    // 目录服务：ctx.paths 指向组合树目录、插件数据目录可取（首取即建）
    const paths = runtime.ctx.tryGet<{ dataDir(): string; pluginDataDir(id: string): string }>('paths');
    expect(paths!.dataDir()).toBe(compositionDir);
    expect(paths!.pluginDataDir('tool-plugin')).toBe(join(compositionDir, 'plugins', 'tool-plugin'));

    // 首 run：工具对模型可见（⑨b 注册经 ⑧ 接线原位刷新了 loop 快照）+ 真走三段管道
    await runtime.conversation.submitOnce('用插件工具');
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
    // 段 id 清单面（字典序；memory/core 简报段 + subagent/list 清单段为官方内置件
    // 注册——memory 空库物化为空串、subagent 单 provider 物化一行清单）
    const prompts = runtime.ctx.get<{ listSections(): string[] }>('prompts');
    expect(prompts.listSections()).toEqual(['demo/notice', 'memory/core', 'subagent/list']);

    // 首 run 落的 header initial 快照含段内容（模型可见即落日志）
    await runtime.conversation.submitOnce('看提示词');
    const headers = runtime.session!.events.filter((e) => e.type === 'request/header');
    expect((headers[0]!.data as { systemPrompt: string }).systemPrompt).toContain('插件段内容：记住用中文注释');
  });

  it('context_transform 桥接：插件挂瀑布注入消息 → 模型请求含注入、日志不含（瞬态面）', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    const pluginDir = writePluginDir(
      compositionDir,
      [
        'export const name = "inject-plugin";',
        'export default async function apply(ctx) {',
        '  // 按需检索注入形态（记忆篇 §6 通道 2）：瀑布收到 (messages, next)，',
        '  // 变换后必须调 next 传播——不调即短路（拒改链路语义同样合法）',
        '  ctx.on("context_transform", (messages, next) =>',
        '    next([...messages, { role: "user", content: "【检索注入】用户偏好 pnpm", timestamp: 1 }]),',
        '  );',
        '}',
      ].join('\n'),
    );
    writeFileSync(join(compositionDir, 'overlay.yaml'), `rows:\n  - id: inject-plugin\n    plugin: ${pluginDir}\n`);

    const { streamFn, contexts } = scriptedStream([textMessage('好的')]);
    const runtime = await assemble({ streamFn, compositionDir });
    await runtime.conversation.submitOnce('装包');

    // 模型请求含注入消息（桥接生效——loop transformContext → 总线瀑布）
    const flat = contexts[0]!.messages.map((m) => JSON.stringify(m)).join('\n');
    expect(flat).toContain('【检索注入】用户偏好 pnpm');
    // 瞬态面纪律（记忆篇 §6）：注入只进请求不落日志——事件日志无注入文本
    const logText = JSON.stringify(runtime.session!.events);
    expect(logText).not.toContain('【检索注入】');
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
    expect(await dumpConfigMain({ compositionDir: badDir, persist: false })).toBe(1);

    const emptyDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plug-')));
    expect(await dumpConfigMain({ compositionDir: emptyDir, persist: false })).toBe(0);
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

    await runtime.conversation.submitOnce('第一问');
    expect(lastEchoText(runtime)).toContain('v1:回声');

    // 同路径改码（版本标记换 v2）→ reload → 激活行照旧、代码是新求值的
    //（memory/subagent 为官方默认层两行，每次 reload 照常激活——恒在）
    writeFileSync(join(pluginDir, 'index.ts'), versionedPluginSource('v2'));
    const result = await runtime.reload();
    expect(result.payload).toEqual({
      activated: ['memory', 'subagent', 'goal', 'tool-plugin'],
      failed: [],
      skipped: [],
    });
    expect(reloadedPayloads).toEqual([
      { activated: ['memory', 'subagent', 'goal', 'tool-plugin'], failed: [], skipped: [] },
    ]);

    await runtime.conversation.submitOnce('第二问');
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
    await runtime.conversation.submitOnce('首问');

    // overlay 置 disabled → reload → 行变 skipped、工具摘除
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: tool-plugin\n    plugin: ${pluginDir}\n    disabled: true\n`,
    );
    const result = await runtime.reload();
    expect(result.payload).toEqual({ activated: ['memory', 'subagent', 'goal'], failed: [], skipped: ['tool-plugin'] });
    // 插件工具已摘除（memory 五件 + agent 为默认装配成员——不受 overlay 禁用影响）
    expect(runtime.tools.list().map((t) => t.name)).toEqual([
      'read',
      'write',
      'edit',
      'ls',
      'memory_write',
      'memory_forget',
      'memory_restore',
      'memory_read',
      'memory_search',
      'agent',
      'goal_get',
      'goal_set',
      'goal_update',
    ]);
    expect(runtime.plugins.list().map((r) => [r.id, r.status])).toEqual([
      ['memory', 'activated'],
      ['subagent', 'activated'],
      ['goal', 'activated'],
      ['tool-plugin', 'skipped'],
    ]);

    // tools_change 即时刷新：后续 run 的模型可见工具集已无插件工具
    await runtime.conversation.submitOnce('再问');
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
    expect(result.payload?.activated).toEqual(['memory', 'subagent', 'goal', 'tool-plugin']);
    expect(result.payload?.failed).toEqual(['bad']);
    // 状态面：失败行带着错误码可见（「没生效」不静默）
    const badRow = runtime.plugins.list().find((r) => r.id === 'bad')!;
    expect(badRow.status).toBe('failed');
    expect(badRow.code).toMatch(/^PLUGIN_/);
    expect(runtime.tools.list().map((t) => t.name)).toContain('plug-echo'); // 成功行照常
    // 进程存活：会话还能继续跑
    const answer = await runtime.conversation.submitOnce('还活着吗');
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

  it('run 进行中拒绝重载（与 /new 同准入判据）', async () => {
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

    const pending = runtime.conversation.submitOnce('慢问');
    expect(runtime.conversation.isRunning).toBe(true);
    expect(await runtime.reload()).toEqual({ busy: true }); // run 中拒绝

    release();
    await pending;
    expect((await runtime.reload()).payload).toEqual({
      activated: ['memory', 'subagent', 'goal', 'tool-plugin'],
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
      ['memory', 'activated'],
      ['subagent', 'activated'],
      ['goal', 'activated'],
      ['tool-plugin', 'skipped'],
      ['twin-plugin', 'activated'],
    ]);
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

    await runtime.conversation.submitOnce('首问');
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
    await runtime.conversation.settle();
    expect(contexts).toHaveLength(2);
    const lastUser = contexts[1]!.messages.at(-1) as { role: string; source?: string; content: string };
    expect(lastUser.role).toBe('user');
    expect(lastUser.source).toBe('subagent-settled');
    expect(lastUser.content).toContain('委派-审读');

    // durable 双事件：llm/usage 折叠（background 道，callId = 子运行 id）+ user/message 带归因
    const usage = runtime.session!.events.find((e) => e.type === 'llm/usage');
    expect(usage?.data).toEqual({
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
    await runtime.conversation.submitOnce('问');
    /** 活体事件采集（ctx.on——装配期 emit 先于测试订阅，/new 半边可观测） */
    const starts: { sessionId?: string; origin?: string }[] = [];
    runtime.ctx.on('session_start', (data) => starts.push(data as { sessionId?: string; origin?: string }));
    runtime.channels.commands.lookup('new')!.handler('');
    expect(starts).toHaveLength(1);
    expect(starts[0]!.sessionId).toBe(runtime.session!.header.sessionId);
    expect(starts[0]!.origin).toBe('initial');
  });
});

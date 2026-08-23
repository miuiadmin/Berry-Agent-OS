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
import { createBerryRuntime, ConversationDriver } from './assembly.js';
import type { BerryRuntime } from './assembly.js';
import { defaultConvertToLlm } from './convert.js';
import { runOnceMain } from './run-main.js';
import { dumpConfigMain } from './dump-config.js';
import { PLUGIN_LOAD_FAILED } from '../contracts/errors.js';

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
    expect(runtime.tools.list().map((t) => t.name)).toEqual(['read', 'write', 'edit', 'ls']);
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
    expect(runtime.tools.list()).toHaveLength(4); // 装配照常完整
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
    // LLM 请求上下文含系统提示词与工具面（装配接线证据）
    expect(contexts[0]?.systemPrompt).toContain('terminal-based coding assistant');
    expect(contexts[0]?.tools?.map((t) => t.name)).toEqual(['read', 'write', 'edit', 'ls']);
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
    expect(contexts[1]?.tools?.map((t) => t.name)).toEqual(['read', 'write', 'edit', 'ls', 'echo']);
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

    const reopened = Persistence.open({ path: dbFile });
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

    // 装载状态面：ctx.plugins 与 runtime.plugins 同源（list 状态 = activated）
    expect(runtime.plugins.list()).toEqual([{ id: 'tool-plugin', status: 'activated', name: 'tool-plugin' }]);
    expect(runtime.ctx.tryGet<{ list(): unknown[] }>('plugins')).toBeTruthy();
    // 组合树报告带行
    expect(runtime.composition.rows.map((row) => row.id)).toEqual(['tool-plugin']);
    // 插件工具已进注册表（fs 四件之后）
    expect(runtime.tools.list().map((t) => t.name)).toEqual(['read', 'write', 'edit', 'ls', 'plug-echo']);
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

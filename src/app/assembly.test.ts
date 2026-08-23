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
import { deriveMessages } from '../session/derive.js';
import { interruptedTurnClosers } from '../session/index.js';
import { Persistence } from '../persist/index.js';
import { createBerryRuntime, ConversationDriver } from './assembly.js';
import type { BerryRuntime } from './assembly.js';
import { defaultConvertToLlm } from './convert.js';
import { runOnceMain } from './run-main.js';

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

/** 装配 + 登记（全部用例经此入口——统一 options 缺省） */
function assemble(overrides: Parameters<typeof createBerryRuntime>[0] = {}): BerryRuntime {
  const runtime = createBerryRuntime({
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
  it('fs 四件 + 内置命令注册；sandbox/mode 落库；系统提示词含基座', () => {
    const runtime = assemble();
    expect(runtime.tools.list().map((t) => t.name)).toEqual(['read', 'write', 'edit', 'ls']);
    const commands = runtime.channels.commands.list().map((c) => c.name);
    for (const expected of ['help', 'quit', 'skills']) {
      expect(commands).toContain(expected);
    }
    expect(runtime.session?.events.map((e) => e.type)).toEqual(['sandbox/mode']);
    expect(runtime.systemPrompt).toContain('terminal-based coding assistant');
  });

  it('persist:false 不开库不建会话（dump-config 姿态）', () => {
    const runtime = assemble({ persist: false });
    expect(runtime.persistence).toBeUndefined();
    expect(runtime.session).toBeUndefined();
    expect(runtime.tools.list()).toHaveLength(4); // 装配照常完整
  });

  it('技能发现注入：SKILL.md 落临时位置后进系统提示词 + /skill 命令注册', () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'app-skill-'));
    mkdirSync(join(home, '.berry', 'skills', 'demo'), { recursive: true });
    writeFileSync(
      join(home, '.berry', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: 演示技能\n---\n\n演示指令体\n',
    );
    const runtime = assemble({ homeDir: home });
    expect(runtime.skills.list().map((s) => s.name)).toEqual(['demo']);
    expect(runtime.systemPrompt).toContain('<name>demo</name>');
    expect(runtime.channels.commands.lookup('skill:demo')).toBeDefined();
  });
});

/* ---------------- 会话驱动全栈 ---------------- */

describe('ConversationDriver + durable 接线', () => {
  it('submitOnce 单轮：request/header + turn + 消息全落库；投影回读两条', async () => {
    const { streamFn, contexts } = scriptedStream([textMessage('你好，完成')]);
    const runtime = assemble({ streamFn });
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
    const runtime = assemble({ streamFn, workspace });

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
    const runtime = assemble({ streamFn, workspace, interactive: true });
    runtime.ui.attach(approveAllBackend());

    const result = await runtime.conversation.submitOnce('改 git 配置');
    expect(result?.status).toBe('completed');
    expect(readFileSync(join(workspace, '.git', 'config'), 'utf8')).toBe('新内容\n');
    const decided = runtime.session!.events.find((e) => e.type === 'approval/decided');
    expect((decided!.data as { decision: string }).decision).toBe('approve');
  });

  it('多轮续跑：第二个 run 复用同一活数组时间线', async () => {
    const { streamFn, contexts } = scriptedStream([textMessage('第一答'), textMessage('第二答')]);
    const runtime = assemble({ streamFn });
    await runtime.conversation.submitOnce('第一问');
    await runtime.conversation.submitOnce('第二问');
    // 第二次 LLM 调用可见完整历史（活数组单一时间线）
    expect(contexts[1]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const projected = deriveMessages(runtime.session!.events);
    expect(projected.map((m) => m.type)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('emit 回调违约：catch 补 turn_end，durable 日志无敞开 turn（#9 修复 b）', async () => {
    const { streamFn } = scriptedStream([textMessage('永远到不了的回答')]);
    const runtime = assemble({ streamFn });
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
    const runtime = createBerryRuntime({ dbPath: dbFile, workspace, streamFn });
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

/**
 * L1 agent — loop 骨架 / 消息角色注册 / 待注入队列 单元测试（骨架篇 §2/§3/§4）。
 *
 * 测试策略：StreamFn 全部走脚本化合成流（「错误编码为数据」契约由合成流兑现），
 * 零真实 LLM 依赖。事件序断言采用精确全序列（start → update* → end 严格序）。
 */
import { describe, expect, it } from 'vitest';
import { AGENT_CONTINUE_INVALID, AppError } from '../contracts/errors.js';
import type {
  AssistantMessage,
  AssistantStream,
  AssistantStreamEvent,
  LlmContext,
  Message,
  ToolResultMessage,
  UserMessage,
} from '../contracts/llm.js';
import {
  continueRun,
  startRun,
  type AgentContext,
  type AgentEvent,
  type AgentEventSink,
  type AgentLoopConfig,
  type AgentTool,
  type StreamFn,
  type StreamFnOptions,
} from './index.js';
import type { AgentMessage, CustomMessage } from '../contracts/messages.js';
import { PendingMessageQueue } from './queue.js';

/* ---------------- 测试基建：消息 / 合成流 / 脚本化 StreamFn ---------------- */

/** 零用量（测试消息组装用） */
const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

/** 用户消息工厂 */
function userMsg(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: 1 };
}

/** 纯文本 assistant 终值（stopReason=stop） */
function assistantText(text: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], usage: NO_USAGE, stopReason: 'stop', timestamp: 2 };
}

/** 单工具调用 assistant 终值（stopReason=toolUse） */
function assistantToolCalls(name = 'echo', args: Record<string, unknown> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'call-1', name, arguments: args }],
    usage: NO_USAGE,
    stopReason: 'toolUse',
    timestamp: 2,
  };
}

/** 双工具调用 assistant 终值（terminate 语义 / 执行策略测试用） */
function assistantTwoToolCalls(firstName: string, secondName: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'call-1', name: firstName, arguments: {} },
      { type: 'toolCall', id: 'call-2', name: secondName, arguments: {} },
    ],
    usage: NO_USAGE,
    stopReason: 'toolUse',
    timestamp: 2,
  };
}

/** 终态错误 assistant（stopReason=error/aborted + errorMessage） */
function assistantTerminal(stopReason: 'error' | 'aborted', errorMessage: string): AssistantMessage {
  return { role: 'assistant', content: [], usage: NO_USAGE, stopReason, errorMessage, timestamp: 2 };
}

/** 截断 assistant（stopReason=length 且带工具调用——截断防御触发态） */
function assistantTruncated(name = 'echo'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'call-1', name, arguments: { broken: true } }],
    usage: NO_USAGE,
    stopReason: 'length',
    timestamp: 2,
  };
}

/** 合成流：start → text_delta → done/error；result() 恒返回最终消息（契约兑现） */
function syntheticStream(message: AssistantMessage): AssistantStream {
  const partial: AssistantMessage = { ...message, content: [] };
  const isTerminal = message.stopReason === 'error' || message.stopReason === 'aborted';
  const events: AssistantStreamEvent[] = [
    { type: 'start', partial },
    { type: 'text_delta', contentIndex: 0, delta: '', partial },
    isTerminal
      ? { type: 'error', reason: message.stopReason as 'error' | 'aborted', error: message }
      : { type: 'done', reason: message.stopReason as 'stop' | 'toolUse' | 'length', message },
  ];
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: (): Promise<IteratorResult<AssistantStreamEvent>> =>
          index < events.length
            ? Promise.resolve({ value: events[index++] as AssistantStreamEvent, done: false })
            : Promise.resolve({ value: undefined, done: true }),
      };
    },
    result: async () => message,
  };
}

/** 脚本化 StreamFn：按调用序取响应（耗尽后重复末条），记录每次请求上下文与选项 */
function scriptedStream(responses: AssistantMessage[]) {
  const calls: Array<{ context: LlmContext; options: StreamFnOptions }> = [];
  const streamFn: StreamFn = (context, options) => {
    calls.push({ context, options });
    const message =
      responses[Math.min(calls.length - 1, responses.length - 1)] ?? responses.at(-1) ?? assistantText('（耗尽）');
    return syntheticStream(message);
  };
  return { streamFn, calls };
}

/** 窄化取 toolResult（CustomMessage.role 是 string，联合不可判别——测试断言统一走此助手） */
function asToolResult(message: AgentMessage | undefined): ToolResultMessage {
  expect(message?.role).toBe('toolResult');
  return message as ToolResultMessage;
}

/** 标准角色直通转换（装配层最小实现；slice 产新数组——请求快照不被后续追加污染） */
const passthroughConvert = (messages: AgentMessage[]): Message[] => messages.slice() as Message[];

/** 最小可用配置（model-a 起步，可覆盖任意回调） */
function baseConfig(streamFn: StreamFn, overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
  return { streamFn, model: 'model-a', convertToLlm: passthroughConvert, ...overrides };
}

/** 空上下文工厂 */
function makeContext(tools: AgentTool[] = []): AgentContext {
  return { messages: [], tools };
}

/** 工具工厂（execute 缺省返回文本结果） */
function makeTool(name: string, overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name,
    description: `${name} 测试工具`,
    parameters: { type: 'object' },
    execute: async () => ({ content: [{ type: 'text', text: `${name} 结果` }] }),
    ...overrides,
  };
}

/** 活体事件收集器 */
function collector() {
  const events: AgentEvent[] = [];
  const emit: AgentEventSink = (event) => {
    events.push(event);
  };
  return { events, emit };
}

/** 事件类型序列 */
const types = (events: AgentEvent[]) => events.map((event) => event.type);

/** 微任务轮询等待（并发测试的确定性同步） */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i++) {
    await Promise.resolve();
  }
  expect(condition()).toBe(true);
}

/** 捕获 reject 的错误（repo 惯例：instanceof AppError + code 判等） */
async function captureError(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

/* ---------------- startRun：基础与事件序 ---------------- */

describe('startRun 基础流', () => {
  it('单轮文本：completed 终值 + 事件精确全序列', async () => {
    const { streamFn } = scriptedStream([assistantText('你好')]);
    const { events, emit } = collector();
    const result = await startRun([userMsg('hi')], makeContext(), baseConfig(streamFn), { emit });

    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('stop');
    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(types(events)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_end', // user
      'message_start',
      'message_update',
      'message_end', // assistant 流式
      'turn_end',
      'agent_end',
    ]);
    const end = events.at(-1);
    expect(end?.type === 'agent_end' && end.status).toBe('completed');
    expect(end?.type === 'agent_end' && end.messages).toBe(result.messages);
  });

  it('无 emit（headless）：不抛错，RunResult 正常', async () => {
    const { streamFn } = scriptedStream([assistantText('静默')]);
    const result = await startRun([userMsg('hi')], makeContext(), baseConfig(streamFn));
    expect(result.status).toBe('completed');
  });

  it('工具调用两轮：执行 → 结果消息入上下文 → 第二轮收口', async () => {
    const { streamFn, calls } = scriptedStream([assistantToolCalls('echo', { q: '词' }), assistantText('完成')]);
    const executions: Array<{ id: string; args: Record<string, unknown> }> = [];
    const echo = makeTool('echo', {
      execute: async (toolCallId, args) => {
        executions.push({ id: toolCallId, args });
        return { content: [{ type: 'text', text: '回声' }] };
      },
    });
    const { events, emit } = collector();
    const context = makeContext([echo]);
    const result = await startRun([userMsg('查')], context, baseConfig(streamFn), { emit });

    expect(executions).toEqual([{ id: 'call-1', args: { q: '词' } }]);
    expect(result.status).toBe('completed');
    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    const toolResult = asToolResult(result.messages[2]);
    expect(toolResult.isError).toBe(false);
    expect(toolResult.content[0]).toMatchObject({ type: 'text', text: '回声' });
    // 上下文（调用方持有面）与 LLM 第二轮请求都应看到工具结果
    expect(context.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    expect(calls[1]?.context.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult']);
    expect(types(events)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_end', // user
      'message_start',
      'message_update',
      'message_end', // assistant（工具调用）
      'tool_execution_start',
      'tool_execution_end',
      'message_start',
      'message_end', // toolResult
      'turn_end',
      'turn_start',
      'message_start',
      'message_update',
      'message_end', // assistant 第二轮
      'turn_end',
      'agent_end',
    ]);
  });

  it('工具执行抛错：编码为 isError 结果，run 照常完成', async () => {
    const { streamFn } = scriptedStream([assistantToolCalls('boom'), assistantText('恢复')]);
    const boom = makeTool('boom', {
      execute: async () => {
        throw new Error('炸了');
      },
    });
    const result = await startRun([userMsg('go')], makeContext([boom]), baseConfig(streamFn));
    expect(result.status).toBe('completed');
    const toolResult = asToolResult(result.messages[2]);
    expect(toolResult.isError).toBe(true);
    expect(JSON.stringify(toolResult.content)).toContain('炸了');
  });

  it('工具不存在：immediate 错误结果', async () => {
    const { streamFn } = scriptedStream([assistantToolCalls('ghost'), assistantText('好')]);
    const result = await startRun([userMsg('go')], makeContext(), baseConfig(streamFn));
    const toolResult = asToolResult(result.messages[2]);
    expect(toolResult.isError).toBe(true);
    expect(JSON.stringify(toolResult.content)).toContain('工具不存在');
  });

  it('prepareArguments 整形：execute 收到整形后参数，LLM 面参数不受影响', async () => {
    const { streamFn, calls } = scriptedStream([assistantToolCalls('shape'), assistantText('好')]);
    let received: Record<string, unknown> | undefined;
    const shape = makeTool('shape', {
      prepareArguments: (args) => ({ ...(args as Record<string, unknown>), shaped: true }),
      execute: async (_id, args) => {
        received = args;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    await startRun([userMsg('go')], makeContext([shape]), baseConfig(streamFn));
    expect(received).toEqual({ shaped: true });
    // 原始调用参数（assistant 消息内）保持未整形——第二轮请求可见该消息
    expect(calls[1]?.context.messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'toolCall', name: 'shape', arguments: {} }],
    });
  });

  it('onUpdate 进度：tool_execution_update 严格位于 start 与 end 之间', async () => {
    const { streamFn } = scriptedStream([assistantToolCalls('progress'), assistantText('好')]);
    const progress = makeTool('progress', {
      execute: async (_id, _args, _signal, onUpdate) => {
        onUpdate?.({ content: [{ type: 'text', text: '进行中' }] });
        return { content: [{ type: 'text', text: '完成' }] };
      },
    });
    const { events, emit } = collector();
    await startRun([userMsg('go')], makeContext([progress]), baseConfig(streamFn), { emit });
    const sequence = types(events);
    const start = sequence.indexOf('tool_execution_start');
    const update = sequence.indexOf('tool_execution_update');
    const end = sequence.indexOf('tool_execution_end');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(update).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(update);
    const updateEvent = events[update];
    expect(updateEvent?.type === 'tool_execution_update' && updateEvent.partialResult.content[0]).toMatchObject({
      type: 'text',
      text: '进行中',
    });
  });
});

/* ---------------- 终态三值与截断防御 ---------------- */

describe('终态与截断防御', () => {
  it('stopReason=error → failed + errorMessage 透传', async () => {
    const { streamFn } = scriptedStream([assistantTerminal('error', '上游 529')]);
    const { events, emit } = collector();
    const result = await startRun([userMsg('go')], makeContext(), baseConfig(streamFn), { emit });
    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBe('上游 529');
    const end = events.at(-1);
    expect(end?.type === 'agent_end' && end.status).toBe('failed');
  });

  it('stopReason=aborted → aborted 终值', async () => {
    const { streamFn } = scriptedStream([assistantTerminal('aborted', '用户取消')]);
    const result = await startRun([userMsg('go')], makeContext(), baseConfig(streamFn));
    expect(result.status).toBe('aborted');
    expect(result.stopReason).toBe('aborted');
  });

  it('length 截断：整批工具不执行，直接 fail 并继续下一轮', async () => {
    const { streamFn } = scriptedStream([assistantTruncated('echo'), assistantText('重试成功')]);
    let executed = 0;
    const echo = makeTool('echo', {
      execute: async () => {
        executed += 1;
        return { content: [{ type: 'text', text: 'x' }] };
      },
    });
    const result = await startRun([userMsg('go')], makeContext([echo]), baseConfig(streamFn));
    expect(executed).toBe(0); // 截断批永不执行
    const toolResult = asToolResult(result.messages[2]);
    expect(toolResult.isError).toBe(true);
    expect(JSON.stringify(toolResult.content)).toContain('截断');
    expect(result.status).toBe('completed'); // 失败结果回给模型后重试成功
  });
});

/* ---------------- steering / followUp 双队列 ---------------- */

describe('steering 与 followUp', () => {
  it('steering：turn 边界注入，进入下一轮 LLM 请求', async () => {
    const { streamFn, calls } = scriptedStream([assistantText('一'), assistantText('二')]);
    const polls: AgentMessage[][] = [[], [userMsg('插话')], []];
    let pollIndex = 0;
    const result = await startRun(
      [userMsg('go')],
      makeContext(),
      baseConfig(streamFn, {
        getSteeringMessages: async () => polls[pollIndex++] ?? [],
      }),
    );
    expect(calls.length).toBe(2);
    expect(calls[1]?.context.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(result.status).toBe('completed');
  });

  it('followUp：run 将停时捞起续跑', async () => {
    const { streamFn, calls } = scriptedStream([assistantText('一'), assistantText('二')]);
    const queue: AgentMessage[][] = [[userMsg('追问')], []];
    let followIndex = 0;
    const result = await startRun(
      [userMsg('go')],
      makeContext(),
      baseConfig(streamFn, {
        getFollowUpMessages: async () => queue[followIndex++] ?? [],
      }),
    );
    expect(calls.length).toBe(2);
    expect(calls[1]?.context.messages.at(-1)).toMatchObject({ role: 'user', content: '追问' });
    expect(result.status).toBe('completed');
  });

  it('两队列皆空：单轮自然收口', async () => {
    const { streamFn, calls } = scriptedStream([assistantText('一')]);
    const result = await startRun(
      [userMsg('go')],
      makeContext(),
      baseConfig(streamFn, {
        getSteeringMessages: async () => [],
        getFollowUpMessages: async () => [],
      }),
    );
    expect(calls.length).toBe(1);
    expect(result.status).toBe('completed');
  });
});

/* ---------------- terminate 语义与批级拦截 ---------------- */

describe('terminate 与批级拦截', () => {
  it('整批全部 terminate=true 才早停：不再发下一次 LLM 请求', async () => {
    const { streamFn, calls } = scriptedStream([assistantToolCalls('done')]);
    const done = makeTool('done', {
      execute: async () => ({ content: [{ type: 'text', text: '收工' }], terminate: true }),
    });
    const result = await startRun([userMsg('go')], makeContext([done]), baseConfig(streamFn));
    expect(calls.length).toBe(1); // 早停：无第二轮
    expect(result.status).toBe('completed');
    expect(result.messages.at(-1)?.role).toBe('toolResult');
  });

  it('批内仅部分 terminate：不早停，继续下一轮', async () => {
    const { streamFn, calls } = scriptedStream([assistantTwoToolCalls('done', 'cont'), assistantText('收口')]);
    const done = makeTool('done', {
      execute: async () => ({ content: [{ type: 'text', text: 'a' }], terminate: true }),
    });
    const cont = makeTool('cont', {
      execute: async () => ({ content: [{ type: 'text', text: 'b' }] }),
    });
    const result = await startRun([userMsg('go')], makeContext([done, cont]), baseConfig(streamFn));
    expect(calls.length).toBe(2);
    expect(result.status).toBe('completed');
  });

  it('beforeToolCall block：结果带 reason 且 isError', async () => {
    const { streamFn } = scriptedStream([assistantToolCalls('blocked'), assistantText('好')]);
    const blocked = makeTool('blocked');
    const result = await startRun(
      [userMsg('go')],
      makeContext([blocked]),
      baseConfig(streamFn, {
        beforeToolCall: async () => ({ block: true, reason: '策略拒绝' }),
      }),
    );
    const toolResult = asToolResult(result.messages[2]);
    expect(toolResult.isError).toBe(true);
    expect(JSON.stringify(toolResult.content)).toContain('策略拒绝');
  });

  it('beforeToolCall block+terminate：单工具批早停', async () => {
    const { streamFn, calls } = scriptedStream([assistantToolCalls('blocked')]);
    const blocked = makeTool('blocked');
    const result = await startRun(
      [userMsg('go')],
      makeContext([blocked]),
      baseConfig(streamFn, {
        beforeToolCall: async () => ({ block: true, reason: '策略拒绝', terminate: true }),
      }),
    );
    expect(calls.length).toBe(1);
    expect(result.status).toBe('completed');
  });

  it('afterToolCall：字段级改写 content / isError', async () => {
    const { streamFn } = scriptedStream([assistantToolCalls('edit'), assistantText('好')]);
    const edit = makeTool('edit');
    const result = await startRun(
      [userMsg('go')],
      makeContext([edit]),
      baseConfig(streamFn, {
        afterToolCall: async () => ({ content: [{ type: 'text', text: '已改写' }], isError: true }),
      }),
    );
    const toolResult = asToolResult(result.messages[2]);
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0]).toMatchObject({ type: 'text', text: '已改写' });
  });
});

/* ---------------- 执行策略三态 ---------------- */

describe('工具批执行策略', () => {
  it('默认 sequential：逐个 start→end', async () => {
    const { streamFn } = scriptedStream([assistantTwoToolCalls('a', 'b'), assistantText('好')]);
    const log: string[] = [];
    const trace = (name: string) =>
      makeTool(name, {
        execute: async () => {
          log.push(`${name}:start`);
          await Promise.resolve();
          log.push(`${name}:end`);
          return { content: [{ type: 'text', text: name }] };
        },
      });
    await startRun([userMsg('go')], makeContext([trace('a'), trace('b')]), baseConfig(streamFn));
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('parallel：全部预检后并发，end 按完成序', async () => {
    const { streamFn } = scriptedStream([assistantTwoToolCalls('a', 'b'), assistantText('好')]);
    const log: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const toolA = makeTool('a', {
      execute: async () => {
        log.push('a:start');
        await gateA; // a 挂起，等 b 完成后放行 → 证明并发
        log.push('a:end');
        return { content: [{ type: 'text', text: 'A' }] };
      },
    });
    const toolB = makeTool('b', {
      execute: async () => {
        log.push('b:start');
        log.push('b:end');
        return { content: [{ type: 'text', text: 'B' }] };
      },
    });
    const running = startRun(
      [userMsg('go')],
      makeContext([toolA, toolB]),
      baseConfig(streamFn, { toolExecution: 'parallel' }),
    );
    await until(() => log.includes('b:end'));
    releaseA();
    const result = await running;
    expect(log).toEqual(['a:start', 'b:start', 'b:end', 'a:end']);
    expect(result.status).toBe('completed');
  });

  it('工具级 executionMode=sequential 强制整批串行（覆盖批配置 parallel）', async () => {
    const { streamFn } = scriptedStream([assistantTwoToolCalls('a', 'b'), assistantText('好')]);
    const log: string[] = [];
    const trace = (name: string, force?: 'sequential') =>
      makeTool(name, {
        executionMode: force,
        execute: async () => {
          log.push(`${name}:start`);
          await Promise.resolve();
          log.push(`${name}:end`);
          return { content: [{ type: 'text', text: name }] };
        },
      });
    await startRun(
      [userMsg('go')],
      makeContext([trace('a'), trace('b', 'sequential')]),
      baseConfig(streamFn, { toolExecution: 'parallel' }),
    );
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });
});

/* ---------------- 批中段中止余量收尾（全面复盘 20260903 #6） ---------------- */

describe('批中段中止余量收尾（全面复盘 20260903 #6）', () => {
  it('串行批：a 执行中打断——余下 b 必须补 tool_result（已中止，工具未执行）', async () => {
    // 第二轮脚本响应 = aborted 终值（打断后 convertToLlm 载荷必须已配对干净，模型层不再收到悬空 tool_use）
    const { streamFn } = scriptedStream([assistantTwoToolCalls('a', 'b'), assistantTerminal('aborted', '中止')]);
    const controller = new AbortController();
    const a = makeTool('a', {
      // a 自己执行时打断：a 正常返回、b 还没轮到——修前 b 的 toolCall 悬空（裸 break）
      execute: async () => {
        controller.abort();
        return { content: [{ type: 'text', text: 'a 完成' }] };
      },
    });
    const b = makeTool('b');
    const result = await startRun([userMsg('go')], makeContext([a, b]), baseConfig(streamFn), {
      signal: controller.signal,
    });
    // messages 序：user → assistant(双 toolCall) → toolResult(a) → toolResult(b 余量收尾)
    // 修前 messages[3] 是 aborted 终值 assistant（b 悬空直达下轮）——asToolResult 的 role 断言即红
    const leftover = asToolResult(result.messages[3]);
    expect(leftover.toolCallId).toBe('call-2');
    expect(leftover.isError).toBe(true);
    expect(JSON.stringify(leftover.content)).toContain('已中止，工具未执行');
    // b 从未执行（余量收尾是记账补对，不是执行）
    expect(result.messages[2] && result.messages[2].role).toBe('toolResult');
  });

  it('并行批：prep 循环中打断——余下 b 必须补 tool_result（已中止，工具未执行）', async () => {
    const { streamFn } = scriptedStream([assistantTwoToolCalls('a', 'b'), assistantTerminal('aborted', '中止')]);
    const controller = new AbortController();
    const log: string[] = [];
    // 门闩：beforeToolCall 挂起，直到我们放行——打断必须落在 prep 循环窗内（执行段
    // 打断不进 break：preps 在 Promise.all 前已全部完成，无余量可言）
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = makeTool('a');
    const b = makeTool('b');
    const config = baseConfig(streamFn, {
      toolExecution: 'parallel',
      beforeToolCall: async () => {
        log.push('before');
        await gate; // 挂起首个 prep——打断窗可控
      },
    });
    const running = startRun([userMsg('go')], makeContext([a, b]), config, { signal: controller.signal });
    await until(() => log.includes('before')); // 首个 prep 已进 beforeToolCall
    controller.abort(); // 此刻 a 的 prep 返回 immediate-aborted、b 还在待 prep——修前 b 悬空
    release!();
    const result = await running;
    const leftover = asToolResult(result.messages[3]);
    expect(leftover.toolCallId).toBe('call-2');
    expect(leftover.isError).toBe(true);
    expect(JSON.stringify(leftover.content)).toContain('已中止，工具未执行');
  });
});

/* ---------------- prepareNextTurn / shouldStopAfterTurn / 边界回调 ---------------- */

describe('turn 边界回调', () => {
  it('prepareNextTurn 换 model：第二轮请求即用新模型', async () => {
    const { streamFn, calls } = scriptedStream([assistantText('一'), assistantText('二')]);
    const polls: AgentMessage[][] = [[], [userMsg('继续')], []];
    let pollIndex = 0;
    await startRun(
      [userMsg('go')],
      makeContext(),
      baseConfig(streamFn, {
        getSteeringMessages: async () => polls[pollIndex++] ?? [],
        prepareNextTurn: () => ({ model: 'model-b' }),
      }),
    );
    expect(calls[0]?.options.model).toBe('model-a');
    expect(calls[1]?.options.model).toBe('model-b');
  });

  it('prepareNextTurn 换 context：压缩后第二轮只见新上下文', async () => {
    const { streamFn, calls } = scriptedStream([assistantText('一'), assistantText('二')]);
    const polls: AgentMessage[][] = [[], [userMsg('继续')], []];
    let pollIndex = 0;
    const compacted = makeContext();
    compacted.messages.push(userMsg('压缩保留'));
    await startRun(
      [userMsg('go')],
      makeContext(),
      baseConfig(streamFn, {
        getSteeringMessages: async () => polls[pollIndex++] ?? [],
        prepareNextTurn: () => ({ context: compacted }),
      }),
    );
    expect(calls[1]?.context.messages.map((message) => message.role)).toEqual(['user', 'user']);
    expect(calls[1]?.context.messages[0]).toMatchObject({ role: 'user', content: '压缩保留' });
  });

  it('shouldStopAfterTurn=true：单轮优雅停', async () => {
    const { streamFn, calls } = scriptedStream([assistantText('一')]);
    const result = await startRun(
      [userMsg('go')],
      makeContext(),
      baseConfig(streamFn, {
        shouldStopAfterTurn: () => true,
      }),
    );
    expect(calls.length).toBe(1);
    expect(result.status).toBe('completed');
    expect(result.messages.at(-1)?.role).toBe('assistant');
  });

  it('transformContext：裁剪只影响 LLM 请求面，不改运行上下文', async () => {
    const { streamFn, calls } = scriptedStream([assistantText('一')]);
    const context = makeContext();
    const noise = { role: 'noise', content: '旧噪音', timestamp: 0 } satisfies CustomMessage;
    context.messages.push(noise, userMsg('go'));
    await startRun(
      [userMsg('新指令')],
      context,
      baseConfig(streamFn, {
        transformContext: async (messages) => messages.filter((message) => message.role !== 'noise'),
      }),
    );
    expect(calls[0]?.context.messages.map((message) => message.role)).toEqual(['user', 'user']);
    expect(context.messages[0]).toBe(noise); // 运行上下文原样保留
  });

  it('getApiKey：凭证透传到 StreamFn 选项', async () => {
    const { streamFn, calls } = scriptedStream([assistantText('一')]);
    await startRun([userMsg('go')], makeContext(), baseConfig(streamFn, { getApiKey: () => 'sk-test' }));
    expect(calls[0]?.options.apiKey).toBe('sk-test');
  });

  it('convertToLlm 关口：自定义角色过滤后不进 LLM 请求，但留在时间线', async () => {
    const { streamFn, calls } = scriptedStream([assistantText('一')]);
    const note = { role: 'note', content: '内部注记', timestamp: 3 } satisfies CustomMessage;
    const result = await startRun(
      [userMsg('go'), note],
      makeContext(),
      baseConfig(streamFn, {
        convertToLlm: (messages) => messages.filter((message) => message.role !== 'note') as Message[],
      }),
    );
    expect(calls[0]?.context.messages.map((message) => message.role)).toEqual(['user']);
    expect(result.messages.map((message) => message.role)).toEqual(['user', 'note', 'assistant']);
  });

  it('LLM 面工具描述降维：label/executionMode 等执行件字段不进模型视野', async () => {
    const { streamFn, calls } = scriptedStream([assistantText('一')]);
    const fancy = makeTool('fancy', { label: '花哨', executionMode: 'sequential' });
    await startRun([userMsg('go')], makeContext([fancy]), baseConfig(streamFn));
    expect(calls[0]?.context.tools).toEqual([
      { name: 'fancy', description: 'fancy 测试工具', parameters: { type: 'object' } },
    ]);
  });
});

/* ---------------- continueRun 续入校验 ---------------- */

describe('beforeModelStep 进模型步护栏（刀三 §6.8）', () => {
  it('首迭代短路：零 LLM 调用，合成 turn_end 锚闭对 + completed 收场', async () => {
    const { streamFn, calls } = scriptedStream([assistantText('不应被调用')]);
    const { events, emit } = collector();
    const result = await startRun(
      [userMsg('跑')],
      makeContext(),
      baseConfig(streamFn, { beforeModelStep: async () => ({ stop: true }) }),
      { emit },
    );
    expect(calls).toHaveLength(0); // 模型调用一次都没发
    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('stop');
    expect(result.messages).toHaveLength(1); // 只有 prompt——合成锚不进时间线
    expect(types(events)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_end',
      'turn_end',
      'agent_end',
    ]);
    // 合成锚形状：空 content assistant、stopReason 'stop'（durable turn/end 只读 stopReason）
    const anchor = events.at(-2) as { type: 'turn_end'; message: AssistantMessage };
    expect(anchor.message.content).toEqual([]);
    expect(anchor.message.stopReason).toBe('stop');
  });

  it('后续迭代短路：首迭代工具照常执行，第二轮模型步前收场（「跑完为止」不破）', async () => {
    const { streamFn, calls } = scriptedStream([assistantToolCalls('echo'), assistantText('不应被调用')]);
    const { events, emit } = collector();
    const result = await startRun(
      [userMsg('跑')],
      makeContext([makeTool('echo')]),
      baseConfig(streamFn, {
        // 首轮放行（0 次调用时）；首轮真发后第二轮拦（calls 已 1）
        beforeModelStep: async () => (calls.length >= 1 ? { stop: true } : undefined),
      }),
      { emit },
    );
    expect(calls).toHaveLength(1); // 只有首轮模型调用真发了
    expect(result.status).toBe('completed');
    // 首轮产物在时间线：prompt + assistant(toolCall) + toolResult；合成锚不在
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult']);
    const sequence = types(events);
    // 两次 turn_start（startRun 预发 + 第二迭代顶）——拦停前 turn_start 已发，
    // 锚 turn_end 闭对；段尾三事件即收场序
    expect(sequence.filter((t) => t === 'turn_start')).toHaveLength(2);
    expect(sequence.slice(-3)).toEqual(['turn_start', 'turn_end', 'agent_end']);
  });

  it('回调返回 undefined：放行如常（每模型调用前恰一次）', async () => {
    const { streamFn, calls } = scriptedStream([assistantText('好')]);
    let invoked = 0;
    const result = await startRun(
      [userMsg('跑')],
      makeContext(),
      baseConfig(streamFn, {
        beforeModelStep: async () => {
          invoked++;
          return undefined;
        },
      }),
    );
    expect(invoked).toBe(1);
    expect(calls).toHaveLength(1);
    expect(result.status).toBe('completed');
  });

  it('回调抛错照常上抛（loop 零 try/catch——挂起钟在装配层桥上）', async () => {
    const { streamFn } = scriptedStream([assistantText('不应被调用')]);
    const boom = new AppError(AGENT_CONTINUE_INVALID, '回调违约');
    const thrown = await startRun(
      [userMsg('跑')],
      makeContext(),
      baseConfig(streamFn, {
        beforeModelStep: async () => {
          throw boom;
        },
      }),
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(thrown).toBe(boom); // 非 failed 收场——异常路径原样传播
  });
});

describe('continueRun 续跑', () => {
  it('末消息为 toolResult：合法续跑', async () => {
    const { streamFn, calls } = scriptedStream([assistantText('续')]);
    const context = makeContext();
    context.messages.push(
      userMsg('go'),
      { role: 'assistant', content: [], usage: NO_USAGE, stopReason: 'toolUse', timestamp: 2 },
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'echo',
        content: [{ type: 'text', text: 'r' }],
        isError: false,
        timestamp: 3,
      },
    );
    const result = await continueRun(context, baseConfig(streamFn));
    expect(result.status).toBe('completed');
    expect(calls.length).toBe(1);
    expect(result.messages.map((message) => message.role)).toEqual(['assistant']); // 续跑不重复计入既有上下文
  });

  it('末消息为 assistant：拒绝（AGENT_CONTINUE_INVALID）', async () => {
    const { streamFn } = scriptedStream([assistantText('x')]);
    const context = makeContext();
    context.messages.push(userMsg('go'), assistantText('旧答'));
    const error = await captureError(continueRun(context, baseConfig(streamFn)));
    expect(error.code).toBe(AGENT_CONTINUE_INVALID);
  });

  it('空上下文：拒绝', async () => {
    const { streamFn } = scriptedStream([]);
    const error = await captureError(continueRun(makeContext(), baseConfig(streamFn)));
    expect(error.code).toBe(AGENT_CONTINUE_INVALID);
  });

  it('自定义角色经 convertToLlm 映射为 user：合法续跑（转换后判定语义）', async () => {
    const { streamFn, calls } = scriptedStream([assistantText('续')]);
    const context = makeContext();
    context.messages.push({ role: 'note', content: '注入指令', timestamp: 1 } satisfies CustomMessage);
    const result = await continueRun(
      context,
      baseConfig(streamFn, {
        convertToLlm: (messages) =>
          messages.map((message) =>
            message.role === 'note' ? userMsg(String((message as CustomMessage).content)) : message,
          ) as Message[],
      }),
    );
    expect(result.status).toBe('completed');
    expect(calls[0]?.context.messages.at(-1)).toMatchObject({ role: 'user', content: '注入指令' });
  });
});

/* ---------------- 待注入队列 ---------------- */

describe('PendingMessageQueue', () => {
  it('one-at-a-time（默认）：只取最旧一条，其余留队', () => {
    const queue = new PendingMessageQueue();
    const first = userMsg('一');
    const second = userMsg('二');
    const third = userMsg('三');
    queue.enqueue(first);
    queue.enqueue(second);
    queue.enqueue(third);
    expect(queue.drain()).toEqual([first]);
    expect(queue.hasItems()).toBe(true);
    expect(queue.drain()).toEqual([second]);
    expect(queue.drain()).toEqual([third]);
    expect(queue.hasItems()).toBe(false);
    expect(queue.drain()).toEqual([]);
  });

  it('all：一次排空全部', () => {
    const queue = new PendingMessageQueue('all');
    const first = userMsg('一');
    const second = userMsg('二');
    queue.enqueue(first);
    queue.enqueue(second);
    expect(queue.drain()).toEqual([first, second]);
    expect(queue.hasItems()).toBe(false);
  });

  it('clear：丢弃全部排队消息', () => {
    const queue = new PendingMessageQueue();
    queue.enqueue(userMsg('一'));
    queue.clear();
    expect(queue.hasItems()).toBe(false);
    expect(queue.drain()).toEqual([]);
  });
});

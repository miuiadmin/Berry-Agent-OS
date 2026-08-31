/**
 * llm 模块 — StreamFn 一致性套件（契约篇 §6.3 seam 清单落码形态细化，
 * 2026-08-31 第四十一批——Ring 3 前置行动 7 销账批）。
 *
 * 目的：单实现 seam 的「第二实现验证」——createStreamFn（pi-ai 适配 × faux
 * provider）× replay 手写发射器（不借 pi-ai）跑**同一共享断言族**：
 * 协议纪律（start 先行 / 收尾恰一 done|error / partial 累计 = 终消息）、
 * 错误是数据（流内 error 事件 + stopReason='error' 终消息，调用永不抛）、
 * done 消息 usage 面（在场/形状断言——faux 估算覆盖坑在案，不断值）。
 *
 * abort 分实现专节：适配侧义务 = signal 透传（pi-ai 拥有 abort 语义）；
 * replay 侧义务 = aborted 收尾。发射器为仓内第二份手写协议知识拷贝
 * （loop.test.ts syntheticStream 先例——测试面 import 纪律各测各模块，被迫成本）。
 */
import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { AssistantMessage as PiAssistantMessage } from '@earendil-works/pi-ai';
import type {
  AssistantMessage,
  AssistantStream,
  AssistantStreamEvent,
  LlmContext,
  Message,
  StreamFn,
  Usage,
} from '../contracts/llm.js';
import { createLlmRuntime, createStreamFn } from './index.js';

/* ---------------- 公共零件 ---------------- */

/** 零用量（replay 侧合成消息基线） */
const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

/** 合成用户消息（请求上下文最小件——timestamp 必填） */
function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: 1 };
}

/** 收集流事件全序列 + 终值（排空迭代器——done/error 后流自然结束） */
async function drainStream(stream: AssistantStream): Promise<AssistantStreamEvent[]> {
  const events: AssistantStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/** 取消息内拼接文本（partial/终消息同用——累计一致性断言的读值口） */
function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('');
}

/* ---------------- replay 第二实现（手写 12 型协议发射器） ---------------- */

/** 剧本三型：text 主链 / toolcall 链（loop 消费的最重路径）/ error 收尾 */
type ReplayScript =
  | { kind: 'text'; text: string }
  | { kind: 'toolCall'; name: string; args: Record<string, unknown> }
  | { kind: 'error'; errorMessage: string };

/** 事件数组 → AssistantStream（异步迭代 + result() 终值口——契约两成员） */
function makeStream(events: AssistantStreamEvent[], finalMessage: AssistantMessage): AssistantStream {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: (): Promise<IteratorResult<AssistantStreamEvent>> =>
          index < events.length
            ? Promise.resolve({ value: events[index++]!, done: false })
            : Promise.resolve({ value: undefined, done: true }),
      };
    },
    result: async () => finalMessage,
  };
}

/**
 * replay StreamFn（第二实现）：按剧本手写发射事件序列。
 * 协议纪律自持：start 先行（partial 空内容起步）、各块 start/delta/end 交错、
 * partial 携带累计快照（delta 逐条拼接后的内容前缀）、done 收尾恰一。
 * signal 已 abort → start 后即 error(aborted) 收尾（abort 专节用）。
 */
function replayStreamFn(script: ReplayScript): StreamFn {
  return (_context, _options, signal): AssistantStream => {
    // 预先 abort：start 先行后 aborted 收尾（协议纪律在取消路同样成立）
    if (signal?.aborted) {
      const abortedMessage: AssistantMessage = {
        role: 'assistant',
        content: [],
        usage: NO_USAGE,
        stopReason: 'aborted',
        errorMessage: '取消',
        timestamp: 9,
      };
      return makeStream(
        [
          { type: 'start', partial: { ...abortedMessage, content: [] } },
          { type: 'error', reason: 'aborted', error: abortedMessage },
        ],
        abortedMessage,
      );
    }
    if (script.kind === 'error') {
      const errorMessage: AssistantMessage = {
        role: 'assistant',
        content: [],
        usage: NO_USAGE,
        stopReason: 'error',
        errorMessage: script.errorMessage,
        timestamp: 9,
      };
      return makeStream(
        [
          { type: 'start', partial: { ...errorMessage, content: [] } },
          { type: 'error', reason: 'error', error: errorMessage },
        ],
        errorMessage,
      );
    }
    if (script.kind === 'toolCall') {
      // toolcall 链：partial 累计 arguments（先半包后整包）、toolcall_end 终块 = done 消息内块
      const block = { type: 'toolCall', id: 'tc-1', name: script.name, arguments: script.args } as const;
      const finalMessage: AssistantMessage = {
        role: 'assistant',
        content: [block],
        usage: NO_USAGE,
        stopReason: 'toolUse',
        timestamp: 9,
      };
      const partialArgs = Object.fromEntries(Object.entries(script.args).slice(0, 1));
      return makeStream(
        [
          { type: 'start', partial: { ...finalMessage, content: [] } },
          { type: 'toolcall_start', contentIndex: 0, partial: { ...finalMessage, content: [] } },
          {
            type: 'toolcall_delta',
            contentIndex: 0,
            delta: JSON.stringify(partialArgs),
            partial: { ...finalMessage, content: [{ ...block, arguments: partialArgs }] },
          },
          { type: 'toolcall_end', contentIndex: 0, toolCall: block, partial: finalMessage },
          { type: 'done', reason: 'toolUse', message: finalMessage },
        ],
        finalMessage,
      );
    }
    // text 主链：delta 二分发射（累计快照逐条进 partial）
    const finalMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: script.text }],
      usage: NO_USAGE,
      stopReason: 'stop',
      timestamp: 9,
    };
    const half = script.text.slice(0, Math.ceil(script.text.length / 2));
    const rest = script.text.slice(half.length);
    const withText = (text: string): AssistantMessage => ({ ...finalMessage, content: [{ type: 'text', text }] });
    return makeStream(
      [
        { type: 'start', partial: withText('') },
        { type: 'text_start', contentIndex: 0, partial: withText('') },
        { type: 'text_delta', contentIndex: 0, delta: half, partial: withText(half) },
        { type: 'text_delta', contentIndex: 0, delta: rest, partial: withText(script.text) },
        { type: 'text_end', contentIndex: 0, content: script.text, partial: withText(script.text) },
        { type: 'done', reason: 'stop', message: finalMessage },
      ],
      finalMessage,
    );
  };
}

/* ---------------- 双跑接线 ---------------- */

/** 断言族入参：剧本 → {streamFn, model, marker}（model = 调用用标识；marker = 错误文案锚） */
interface ConformanceSide {
  (script: ReplayScript): { streamFn: StreamFn; model: string; marker: string };
}

/** 适配侧（第一实现）：faux provider 注入 runtime，createStreamFn 全链（pi-ai 真代码路径） */
const adapterSide: ConformanceSide = (script) => {
  const faux = fauxProvider({ provider: 'faux-conf', models: [{ id: 'm1' }] });
  const runtime = createLlmRuntime({ providers: [faux.provider] });
  if (script.kind === 'error') {
    // 错误路 = 模型查无（适配层「永不抛错」的招牌路径：AppError 转流内数据）
    return { streamFn: createStreamFn(runtime), model: 'ghost/nope', marker: 'ghost/nope' };
  }
  // 注 pi-ai 侧消息类型：字面量上下文收窄（role/stopReason 等字面量位不宽化）
  const response: PiAssistantMessage =
    script.kind === 'text'
      ? fauxAssistantMessage(script.text)
      : {
          // pi-ai 侧消息面：api/provider/model 必填（faux 回放不校验取值，形状须全）；
          // usage 借官方工厂代造——pi-ai Usage 的 cost 等必填位免手拼
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc-1', name: script.name, arguments: script.args }],
          usage: fauxAssistantMessage('u').usage,
          stopReason: 'toolUse',
          timestamp: 9,
          api: 'anthropic-messages',
          provider: 'faux-conf',
          model: 'm1',
        };
  faux.setResponses([() => response]);
  return { streamFn: createStreamFn(runtime), model: 'faux-conf/m1', marker: '' };
};

/** replay 侧（第二实现）：手写发射器直供（model 位对 replay 无语义——占位串） */
const replaySide: ConformanceSide = (script) => ({
  streamFn: replayStreamFn(script),
  model: 'replay/any',
  marker: script.kind === 'error' ? script.errorMessage : '',
});

/* ---------------- 共享断言族（两实现同跑同一份代码） ---------------- */

function runStreamFnConformance(sideName: string, side: ConformanceSide) {
  it('text 主链：start 先行 + 收尾恰一 done；终文本可由流内事件重组；partial 累计=前缀', async () => {
    const { streamFn, model } = side({ kind: 'text', text: '一致性证词' });
    const stream = await streamFn({ messages: [userMsg('hi')] }, { model });
    const events = await drainStream(stream);
    // 协议纪律：start 先行、终态恰一且居尾
    expect(events[0]?.type).toBe('start');
    const terminals = events.filter((event) => event.type === 'done' || event.type === 'error');
    expect(terminals).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('done');
    // 终文本重组：delta 拼接（发射粒度实现自由——delta 在场则必须拼得回）
    const deltas = events
      .filter((event) => event.type === 'text_delta')
      .map((event) => (event as { delta: string }).delta)
      .join('');
    if (deltas !== '') expect(deltas).toBe('一致性证词');
    // partial 累计一致性：每个 text_delta 后 partial 文本 = 已拼接前缀
    let acc = '';
    for (const event of events) {
      if (event.type !== 'text_delta') continue;
      acc += (event as { delta: string }).delta;
      expect(textOf((event as { partial: AssistantMessage }).partial)).toBe(acc);
    }
    // result() 终值 = done 消息（两取值口同源）
    const final = await stream.result();
    expect(final.stopReason).toBe('stop');
    expect(textOf(final)).toBe('一致性证词');
  });

  it('toolcall 链：done.reason=toolUse + 终消息含 ToolCallBlock；toolcall_end 在场则终块一致', async () => {
    const { streamFn, model } = side({ kind: 'toolCall', name: 'echo', args: { q: '词', n: 1 } });
    const stream = await streamFn({ messages: [userMsg('hi')] }, { model });
    const events = await drainStream(stream);
    expect(events.at(-1)?.type).toBe('done');
    const done = events.at(-1) as { type: 'done'; message: AssistantMessage };
    expect(done.message.stopReason).toBe('toolUse');
    const block = done.message.content.find((b) => b.type === 'toolCall') as {
      name: string;
      arguments: Record<string, unknown>;
    };
    expect(block?.name).toBe('echo');
    expect(block?.arguments).toMatchObject({ q: '词' });
    // toolcall_end 终块（在场时）= done 消息内同块——块组装两路同源
    const ends = events.filter((event) => event.type === 'toolcall_end') as Array<{ toolCall: { name: string } }>;
    if (ends.length > 0) expect(ends[0]?.toolCall.name).toBe('echo');
    await expect(stream.result()).resolves.toBe(done.message);
  });

  it('错误是数据：流内 error 终止事件 + stopReason=error 终消息 + errorMessage 载锚——调用不抛', async () => {
    const { streamFn, model, marker } = side({ kind: 'error', errorMessage: 'replay 故障锚' });
    // 调用本身不抛（永不抛错契约——错误在流内不在异常里）
    const stream = await streamFn({ messages: [userMsg('hi')] }, { model });
    const events = await drainStream(stream);
    expect(events.at(-1)?.type).toBe('error');
    const final = await stream.result();
    expect(final.stopReason).toBe('error');
    expect(final.errorMessage).toContain(marker);
  });

  it('usage 面：done 消息 usage 在场且数值型（不断值——估算覆盖坑在案）', async () => {
    const { streamFn, model } = side({ kind: 'text', text: '用量' });
    const stream = await streamFn({ messages: [userMsg('hi')] }, { model });
    const final = await stream.result();
    expect(final.usage).toBeTruthy();
    expect(typeof final.usage.totalTokens).toBe('number');
  });
}

describe('StreamFn 一致性套件 × createStreamFn（第一实现——pi-ai 适配 × faux）', () => {
  runStreamFnConformance('adapter', adapterSide);
});

describe('StreamFn 一致性套件 × replay 手写（第二实现——不借 pi-ai）', () => {
  runStreamFnConformance('replay', replaySide);
});

/* ---------------- abort 专节（各实现义务分置） ---------------- */

describe('abort 专节', () => {
  it('适配侧义务 = signal 透传到 pi-ai 请求面（abort 语义归 pi-ai）', async () => {
    const faux = fauxProvider({ provider: 'faux-abort', models: [{ id: 'm1' }] });
    const runtime = createLlmRuntime({ providers: [faux.provider] });
    /** 捕获 pi-ai 请求面 options（signal 断言素材） */
    let captured: { signal?: AbortSignal } | undefined;
    faux.setResponses([
      (_ctx, options) => {
        captured = { signal: options?.signal };
        return fauxAssistantMessage('ok');
      },
    ]);
    const streamFn = createStreamFn(runtime);
    const signal = new AbortController().signal;
    await (await streamFn({ messages: [userMsg('hi')] }, { model: 'faux-abort/m1' }, signal)).result();
    expect(captured?.signal).toBe(signal); // 同一引用透传——非复制非重建
  });

  it('replay 侧义务 = 预 abort → start 先行后 error(aborted) 收尾', async () => {
    const controller = new AbortController();
    controller.abort();
    const streamFn = replayStreamFn({ kind: 'text', text: '不会发出' });
    const stream = await streamFn({ messages: [userMsg('hi')] }, { model: 'replay/any' }, controller.signal);
    const events = await drainStream(stream);
    expect(events[0]?.type).toBe('start');
    expect(events.at(-1)?.type).toBe('error');
    expect((events.at(-1) as { reason: string }).reason).toBe('aborted');
    const final = await stream.result();
    expect(final.stopReason).toBe('aborted');
  });
});

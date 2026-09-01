/**
 * L1 llm — 模型标识解析 / Models 宿主 / StreamFn 适配 / 会话层恢复零件 单元测试。
 *
 * 测试策略：pi-ai faux provider（零网络的真实 pi-ai 代码路径）注入 runtime；
 * 超集兼容子集直通以「引用相等」断言钉死（零拷贝是设计承诺）。
 */
import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { Context as PiContext } from '@earendil-works/pi-ai';
import { LLM_INFLIGHT_LIMIT, LLM_MODEL_NOT_FOUND, LLM_MODEL_SPEC_INVALID, AppError } from '../contracts/errors.js';
import type { AssistantMessage, AssistantStreamEvent, LlmContext, Message, UserMessage } from '../contracts/llm.js';
import {
  classifyAssistantError,
  describeProviderFailure,
  createLlmRuntime,
  createStreamFn,
  formatModelId,
  InFlightTracker,
  isContextOverflow,
  isRetryableAssistantError,
  parseModelSpec,
  resolveModel,
  retryAssistantCall,
} from './index.js';

/* ---------------- 测试基建 ---------------- */

/** 零用量（错误/断言消息组装用） */
const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

/** 用户消息工厂 */
function userMsg(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: 1 };
}

/** 建一个 faux 测试运行时（两模型 m1/m2；响应脚本可后置） */
function makeFauxRuntime(providerName = 'faux-test') {
  const faux = fauxProvider({ provider: providerName, models: [{ id: 'm1' }, { id: 'm2' }] });
  const runtime = createLlmRuntime({ providers: [faux.provider] });
  return { faux, runtime };
}

/** 捕获型响应工厂：记录每次调用的 pi-ai 请求面（context/options），恒回固定文本 */
function capturingFactory(
  captures: Array<{ context: PiContext; options: SimpleStreamOptions | undefined }>,
  text = 'ok',
) {
  return (context: PiContext, options: SimpleStreamOptions | undefined) => {
    captures.push({ context, options });
    return fauxAssistantMessage(text);
  };
}

/** 收集流事件类型序列 + 终值 */
async function drainStream(stream: AsyncIterable<AssistantStreamEvent>) {
  const events: AssistantStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/* ---------------- 模型标识解析 ---------------- */

describe('parseModelSpec / resolveModel', () => {
  it('合法：provider/model-id（含 openrouter 路径式 id——首斜杠分割）', () => {
    expect(parseModelSpec('anthropic/claude-sonnet-4-5')).toEqual({ provider: 'anthropic', id: 'claude-sonnet-4-5' });
    expect(parseModelSpec('openrouter/qwen/qwen3-coder')).toEqual({ provider: 'openrouter', id: 'qwen/qwen3-coder' });
    expect(formatModelId('openrouter', 'qwen/qwen3-coder')).toBe('openrouter/qwen/qwen3-coder');
  });

  it('非法格式：无斜杠 / 空 provider / 空 id → LLM_MODEL_SPEC_INVALID', () => {
    for (const bad of ['gpt4', '/model', 'provider/', '/']) {
      let error: unknown;
      try {
        parseModelSpec(bad);
      } catch (reason) {
        error = reason;
      }
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(LLM_MODEL_SPEC_INVALID);
    }
  });

  it('resolveModel：命中返回 Model；provider 查无 / 模型查无 → LLM_MODEL_NOT_FOUND', () => {
    const { runtime, faux } = makeFauxRuntime();
    expect(runtime.resolveModel('faux-test/m1')).toBe(faux.getModel('m1'));
    // 独立函数路径同样两态 fail-loud
    let standaloneError: unknown;
    try {
      resolveModel(runtime.models, 'ghost/m1');
    } catch (reason) {
      standaloneError = reason;
    }
    expect((standaloneError as AppError).code).toBe(LLM_MODEL_NOT_FOUND);
    let error: unknown;
    try {
      runtime.resolveModel('ghost/m1');
    } catch (reason) {
      error = reason;
    }
    expect((error as AppError).code).toBe(LLM_MODEL_NOT_FOUND);
    try {
      runtime.resolveModel('faux-test/nope');
    } catch (reason) {
      expect((reason as AppError).code).toBe(LLM_MODEL_NOT_FOUND);
    }
  });
});

/* ---------------- Models 宿主 ---------------- */

describe('createLlmRuntime 宿主包装', () => {
  it('默认注册内置全家桶（含 anthropic——Anthropic-first 落地面）', () => {
    const runtime = createLlmRuntime();
    const providerIds = runtime.models.getProviders().map((provider) => provider.id);
    expect(providerIds).toContain('anthropic');
    expect(providerIds.length).toBeGreaterThan(5); // 全家桶而非单 provider
    expect(runtime.listModels('anthropic').length).toBeGreaterThan(0);
  });

  it('registerProvider：upsert 生效，注销函数移除', () => {
    const { runtime } = makeFauxRuntime('faux-a');
    expect(runtime.resolveModel('faux-a/m1')).toBeDefined();
    const dispose = runtime.registerProvider(fauxProvider({ provider: 'faux-b', models: [{ id: 'x' }] }).provider);
    expect(runtime.resolveModel('faux-b/x')).toBeDefined();
    dispose();
    try {
      runtime.resolveModel('faux-b/x');
      expect.unreachable('注销后模型应不可解析');
    } catch (reason) {
      expect((reason as AppError).code).toBe(LLM_MODEL_NOT_FOUND);
    }
    // 其他 provider 不受影响
    expect(runtime.resolveModel('faux-a/m1')).toBeDefined();
  });
});

/* ---------------- StreamFn 适配 ---------------- */

describe('createStreamFn 适配层', () => {
  it('基础流：faux 响应 → start 首事件 + done 终止 + result() 终值（直通真成立）', async () => {
    const { faux, runtime } = makeFauxRuntime();
    faux.setResponses([capturingFactory([], '你好')]);
    const streamFn = createStreamFn(runtime);
    const context: LlmContext = { messages: [userMsg('hi')] };
    const stream = await streamFn(context, { model: 'faux-test/m1' });
    const events = await drainStream(stream);
    expect(events[0]?.type).toBe('start');
    expect(events.at(-1)?.type).toBe('done');
    const final = await stream.result();
    expect(final.stopReason).toBe('stop');
    expect(final.content[0]).toMatchObject({ type: 'text', text: '你好' });
  });

  it('模型查无：不抛错，编码为流内 error 终止 + stopReason=error（永不抛错契约）', async () => {
    const { faux, runtime } = makeFauxRuntime();
    faux.setResponses([capturingFactory([], '不应被消费')]);
    const streamFn = createStreamFn(runtime);
    const stream = await streamFn({ messages: [userMsg('hi')] }, { model: 'ghost/nope' });
    const events = await drainStream(stream);
    expect(events.at(-1)?.type).toBe('error');
    const final = await stream.result();
    expect(final.stopReason).toBe('error');
    expect(final.errorMessage).toContain('ghost/nope');
  });

  it('格式非法的模型标识同样走错误流（解析失败前置环节编码为数据）', async () => {
    const { runtime } = makeFauxRuntime();
    const streamFn = createStreamFn(runtime);
    const stream = await streamFn({ messages: [] }, { model: '没有斜杠' });
    const final = await stream.result();
    expect(final.stopReason).toBe('error');
    expect(final.errorMessage).toContain('没有斜杠');
  });

  it('thinkingLevel：off → reasoning undefined；high → reasoning high', async () => {
    const captures: Array<{ context: PiContext; options: SimpleStreamOptions | undefined }> = [];
    const { faux, runtime } = makeFauxRuntime();
    faux.setResponses([capturingFactory(captures), capturingFactory(captures)]);
    const streamFn = createStreamFn(runtime);
    const context: LlmContext = { messages: [userMsg('hi')] };
    await (await streamFn(context, { model: 'faux-test/m1', thinkingLevel: 'off' })).result();
    await (await streamFn(context, { model: 'faux-test/m1', thinkingLevel: 'high' })).result();
    expect(captures[0]?.options?.reasoning).toBeUndefined();
    expect(captures[1]?.options?.reasoning).toBe('high');
  });

  it('apiKey / signal 透传到 pi-ai 请求面', async () => {
    const captures: Array<{ context: PiContext; options: SimpleStreamOptions | undefined }> = [];
    const { faux, runtime } = makeFauxRuntime();
    faux.setResponses([capturingFactory(captures)]);
    const streamFn = createStreamFn(runtime);
    const signal = new AbortController().signal;
    await (await streamFn({ messages: [userMsg('hi')] }, { model: 'faux-test/m1', apiKey: 'sk-x' }, signal)).result();
    expect(captures[0]?.options?.apiKey).toBe('sk-x');
    expect(captures[0]?.options?.signal).toBe(signal);
  });

  it('messages 引用直通（零拷贝）+ tools 字段收口', async () => {
    const captures: Array<{ context: PiContext; options: SimpleStreamOptions | undefined }> = [];
    const { faux, runtime } = makeFauxRuntime();
    faux.setResponses([capturingFactory(captures)]);
    const streamFn = createStreamFn(runtime);
    const messages: Message[] = [userMsg('直通')];
    const context: LlmContext = {
      systemPrompt: '系统提示',
      messages,
      tools: [{ name: 'echo', description: '回声工具', parameters: { type: 'object' } }],
    };
    await (await streamFn(context, { model: 'faux-test/m1' })).result();
    expect(captures[0]?.context.messages).toBe(messages); // 同一数组引用——超集兼容子集直通
    expect(captures[0]?.context.systemPrompt).toBe('系统提示');
    expect(captures[0]?.context.tools?.[0]).toMatchObject({ name: 'echo', description: '回声工具' });
  });

  it('defaults 透传：SDK 级重试/延迟帽经闭包注入', async () => {
    const captures: Array<{ context: PiContext; options: SimpleStreamOptions | undefined }> = [];
    const { faux, runtime } = makeFauxRuntime();
    faux.setResponses([capturingFactory(captures)]);
    const streamFn = createStreamFn(runtime, { maxRetries: 5, maxRetryDelayMs: 1234, temperature: 0.2 });
    await (await streamFn({ messages: [userMsg('hi')] }, { model: 'faux-test/m1' })).result();
    expect(captures[0]?.options?.maxRetries).toBe(5);
    expect(captures[0]?.options?.maxRetryDelayMs).toBe(1234);
    expect(captures[0]?.options?.temperature).toBe(0.2);
  });
});

/* ---------------- 会话层恢复零件（pi-ai 复用包装） ---------------- */

describe('恢复零件包装', () => {
  /** 组装 berry 类型面的失败/成功消息 */
  function messageOf(stopReason: AssistantMessage['stopReason'], errorMessage?: string, input = 0): AssistantMessage {
    return {
      role: 'assistant',
      content: [],
      usage: { ...NO_USAGE, input },
      stopReason,
      errorMessage,
      timestamp: 1,
    };
  }

  it('isContextOverflow：显式报错 / 静默溢出 / 普通错误 三态', () => {
    expect(isContextOverflow(messageOf('error', 'prompt is too long: 200000 tokens > 190000 maximum'))).toBe(true);
    expect(isContextOverflow(messageOf('stop', undefined, 50000), 40000)).toBe(true); // input > 窗口
    expect(isContextOverflow(messageOf('error', 'undefined is not a function'))).toBe(false);
  });

  it('isRetryableAssistantError：网络类 true / 配额类 false', () => {
    expect(isRetryableAssistantError(messageOf('error', 'fetch failed'))).toBe(true);
    expect(isRetryableAssistantError(messageOf('error', 'request timeout after 60000ms'))).toBe(true);
    expect(isRetryableAssistantError(messageOf('error', 'insufficient_quota: billing hard limit reached'))).toBe(false);
  });

  it('retryAssistantCall：transient 错误退避重试至成功，回调可见', async () => {
    let calls = 0;
    const scheduled: number[] = [];
    const final = await retryAssistantCall(
      async () => {
        calls += 1;
        return calls === 1 ? messageOf('error', 'fetch failed') : messageOf('stop');
      },
      { enabled: true, maxRetries: 2, baseDelayMs: 1 },
      undefined,
      { onRetryScheduled: (attempt) => void scheduled.push(attempt) },
    );
    expect(calls).toBe(2);
    expect(scheduled).toEqual([1]);
    expect(final.stopReason).toBe('stop');
  });

  it('retryAssistantCall：非可重试错误立即返回不重试', async () => {
    let calls = 0;
    const final = await retryAssistantCall(
      async () => {
        calls += 1;
        return messageOf('error', 'insufficient_quota');
      },
      { enabled: true, maxRetries: 3, baseDelayMs: 1 },
    );
    expect(calls).toBe(1);
    expect(final.stopReason).toBe('error');
  });
});

/* ---------------- S4 前置债：错误桶表 + 在飞帽 ---------------- */

describe('classifyAssistantError（S4 桶表——全仓唯一一份分桶）', () => {
  /** 错误终态消息工厂（桶表输入面） */
  const errorMessageOf = (errorMessage: string, errorCode?: string): AssistantMessage =>
    ({
      role: 'assistant',
      content: [],
      usage: NO_USAGE,
      stopReason: 'error',
      errorMessage,
      ...(errorCode !== undefined ? { errorCode } : {}),
      timestamp: 1,
    }) as AssistantMessage;

  it('① errorCode 码优先：LLM_INFLIGHT_LIMIT → transient（文案不参与判定）', () => {
    expect(classifyAssistantError(errorMessageOf('任意文案', 'LLM_INFLIGHT_LIMIT'))).toBe('transient');
  });

  it('② 溢出分类位：显式溢出文案（Anthropic 式）→ overflow（只分类不消费）', () => {
    // 显式报错正则（约 21 家 provider 族）；静默溢出需 contextWindow 入参——
    // 桶表判定面不带窗口（窗口在溢出兜底纵切处注入），此处只锁显式腿
    expect(classifyAssistantError(errorMessageOf('prompt is too long: 213462 tokens > 200000 maximum'))).toBe(
      'overflow',
    );
  });

  it('③ 配额文案族 → quota（在 transient 正则之前测——429/rate limit 不落此桶）', () => {
    for (const text of ['insufficient_quota: billing hard limit', 'Monthly usage limit reached', 'quota exceeded']) {
      expect(classifyAssistantError(errorMessageOf(text))).toBe('quota');
    }
    expect(classifyAssistantError(errorMessageOf('429 rate limited'))).not.toBe('quota');
  });

  it('④⑤ transient 正则 / 保守默认：fetch failed → transient；未知 → non-retryable', () => {
    expect(classifyAssistantError(errorMessageOf('fetch failed'))).toBe('transient');
    expect(classifyAssistantError(errorMessageOf('request timeout after 60000ms'))).toBe('transient');
    expect(classifyAssistantError(errorMessageOf('invalid api key'))).toBe('non-retryable');
  });
});

describe('describeProviderFailure（P0-3 首跑凭证失败产品级文案——CLI 呈现形态面）', () => {
  it('形态一 provider 未配置：点名 provider + 环境变量名 + 文档指路', () => {
    const copy = describeProviderFailure('Provider is not configured: anthropic')!;
    expect(copy).toContain('anthropic'); // 点名 provider 本尊
    expect(copy).toContain('ANTHROPIC_API_KEY'); // pi-ai 凭证链 <PROVIDER>_API_KEY 形态
    expect(copy).toContain('使用指南'); // 凭证配置文档指路
  });

  it('形态一 provider id 归一：连字符/混合形态转环境变量名大写下划线', () => {
    const copy = describeProviderFailure('Provider is not configured: openrouter')!;
    expect(copy).toContain('OPENROUTER_API_KEY');
  });

  it('形态二 鉴权被拒：401/403 给行动指引 + 上游原文降附注截断', () => {
    // 403 带整段响应体——正文是行动指引，原文收在附注段
    const copy403 = describeProviderFailure('403 {"error":{"message":"invalid x-api-key"}}')!;
    expect(copy403).toContain('403');
    expect(copy403).toContain('ANTHROPIC_API_KEY'); // 环境变量命名形态示例
    expect(copy403).toContain('附注');
    expect(copy403).toContain('invalid x-api-key'); // 上游原文在场（可取证）
    // 401 同形态覆盖
    expect(describeProviderFailure('401 Unauthorized')).toBeDefined();
    // 超长上游响应体截断到帽（300 字符帽含状态码前缀 + 省略号收尾）
    const long = `403 ${'x'.repeat(500)}`;
    const truncated = describeProviderFailure(long)!;
    expect(truncated).toContain('…');
    expect(truncated).toContain('x'.repeat(290)); // 帽内主体保留（300 帽减 '403 ' 前缀）
    expect(truncated).not.toContain('x'.repeat(400)); // 超帽部分确已截去
    expect(truncated.length).toBeLessThan(long.length);
  });

  it('其余失败原文直出：非凭证形态返回 undefined（不劫持）', () => {
    expect(describeProviderFailure('400 your request is malformed')).toBeUndefined();
    expect(describeProviderFailure('fetch failed')).toBeUndefined();
    expect(describeProviderFailure('[LLM_INFLIGHT_LIMIT] 在飞请求达帽')).toBeUndefined();
    // 近形不误伤：provider 名出现在句中而非 ModelsError 原文形态
    expect(describeProviderFailure('provider anthropic said something odd')).toBeUndefined();
  });
});

describe('InFlightTracker（S4 前置债③——per-provider 计数器）', () => {
  it('达帽返 null；释放后名额归还可再取', () => {
    const tracker = new InFlightTracker(1);
    const slot = tracker.tryAcquire('p');
    expect(slot).not.toBeNull();
    expect(tracker.tryAcquire('p')).toBeNull(); // 帽 1 已占
    slot!.release();
    expect(tracker.tryAcquire('p')).not.toBeNull(); // 归还后可再取
  });

  it('release 幂等：双释放不吐双名额（迭代 return() + result() 双路径只生效一次）', () => {
    const tracker = new InFlightTracker(1);
    const slot = tracker.tryAcquire('p')!;
    slot.release();
    slot.release();
    const again = tracker.tryAcquire('p');
    expect(again).not.toBeNull();
    again!.release();
    expect(tracker.tryAcquire('p')).not.toBeNull(); // 仍只有 1 个名额
  });

  it('per-provider 独立计数（互不挤占）', () => {
    const tracker = new InFlightTracker(1);
    expect(tracker.tryAcquire('a')).not.toBeNull();
    expect(tracker.tryAcquire('b')).not.toBeNull(); // 另一 provider 不受 a 占用影响
    expect(tracker.tryAcquire('a')).toBeNull();
  });

  it('max<=0 = 不限：恒成功（NOOP 名额，release 无操作）', () => {
    const tracker = new InFlightTracker(0);
    for (let i = 0; i < 5; i++) {
      const slot = tracker.tryAcquire('p');
      expect(slot).not.toBeNull();
      slot!.release();
    }
  });
});

describe('createStreamFn 在飞帽（S4 前置债③——达帽显式拒绝）', () => {
  it('达帽：错误流带 errorCode=LLM_INFLIGHT_LIMIT（无 start、result() 终值 error）', async () => {
    const { runtime } = makeFauxRuntime();
    const tracker = new InFlightTracker(1);
    const streamFn = createStreamFn(runtime, {}, tracker);
    const occupied = tracker.tryAcquire('faux-test'); // 预占唯一名额
    expect(occupied).not.toBeNull();
    const stream = await streamFn({ messages: [userMsg('hi')] }, { model: 'faux-test/m1' });
    const events = await drainStream(stream);
    expect(events).toHaveLength(1); // 单 error 终止事件——无 start
    expect(events[0]?.type).toBe('error');
    const final = await stream.result();
    expect(final.stopReason).toBe('error');
    expect(final.errorCode).toBe(LLM_INFLIGHT_LIMIT);
    expect(final.errorMessage).toContain(`[${LLM_INFLIGHT_LIMIT}]`);
    occupied!.release();
  });

  it('正常路：流消费完释放名额（第二次调用可通过——达帽错误流也走 result() 幂等释放）', async () => {
    const { faux, runtime } = makeFauxRuntime();
    faux.setResponses([capturingFactory([], '一'), capturingFactory([], '二')]);
    const streamFn = createStreamFn(runtime, {}, new InFlightTracker(1));
    const first = await streamFn({ messages: [userMsg('a')] }, { model: 'faux-test/m1' });
    await drainStream(first);
    await first.result(); // 串行消费完（for-await return + result 双路径幂等）
    const second = await streamFn({ messages: [userMsg('b')] }, { model: 'faux-test/m1' });
    const events = await drainStream(second);
    expect(events.at(-1)?.type).toBe('done'); // 名额已归还不被拒
    await second.result();
  });
});

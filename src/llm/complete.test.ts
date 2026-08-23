/**
 * L1 llm — ctx.llm.complete 具名服务测试（骨架篇 §9.3：单发受托管补全）。
 *
 * 测试策略：faux provider 零网络真实 pi-ai 代码路径；三条硬要求（禁 apiKey /
 * 单发不 loop / 复用 resolveModel+retryAssistantCall+StreamFnDefaults）逐条钉死。
 */
import { describe, expect, it } from 'vitest';
import { fauxProvider } from '@earendil-works/pi-ai';
import type {
  AssistantMessage as PiAssistantMessage,
  Context as PiContext,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import {
  LLM_COMPLETE_API_KEY_FORBIDDEN,
  LLM_COMPLETE_FAILED,
  LLM_COMPLETE_SCHEMA_UNSUPPORTED,
  LLM_MODEL_NOT_FOUND,
  AppError,
} from '../contracts/errors.js';
import type { AssistantMessage, Message } from '../contracts/llm.js';
import { createLlmRuntime } from './runtime.js';
import { createLlmService } from './complete.js';

/* ---------------- 测试基建 ---------------- */

/** 零用量 */
const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

/** 用户消息工厂 */
const userMsg = (text: string): Message => ({ role: 'user', content: text, timestamp: 1 });

/** 组装指定终态/用量的 assistant 消息（faux 响应脚本用——pi-ai 面形状） */
function messageOf(stopReason: 'stop' | 'error', opts: { errorMessage?: string } = {}): PiAssistantMessage {
  return {
    role: 'assistant',
    content: stopReason === 'stop' ? [{ type: 'text', text: 'ok' }] : [],
    usage: NO_USAGE,
    stopReason,
    errorMessage: opts.errorMessage,
    timestamp: 1,
  } as unknown as PiAssistantMessage; // contracts 形状同构缺 api 元数据字段——faux 脚本面收口在此
}

/** faux 运行时（模型 m1/m2）+ 服务组装（缺省模型 m1） */
function makeService(captures?: Array<{ context: PiContext; options: SimpleStreamOptions | undefined }>) {
  const faux = fauxProvider({ provider: 'faux-test', models: [{ id: 'm1' }, { id: 'm2' }] });
  const runtime = createLlmRuntime({ providers: [faux.provider] });
  const service = createLlmService({
    runtime,
    defaultModel: () => 'faux-test/m1',
    ...(captures ? { defaults: { timeoutMs: 11111 } } : {}),
  });
  return { faux, runtime, service };
}

/** 捕获型响应工厂：记录 pi-ai 请求面，恒回固定终态消息 */
function capturing(
  captures: Array<{ context: PiContext; options: SimpleStreamOptions | undefined }>,
  message: PiAssistantMessage,
) {
  return (context: PiContext, options: SimpleStreamOptions | undefined) => {
    captures.push({ context, options });
    return message;
  };
}

describe('ctx.llm.complete：请求面组装与直通', () => {
  it('单发直通：messages 零转换引用相等、defaults 打底、具名键可覆盖、providerNative 平铺在最后', async () => {
    const captures: Array<{ context: PiContext; options: SimpleStreamOptions | undefined }> = [];
    const { faux, service } = makeService(captures);
    const messages = [userMsg('摘要这段')];
    faux.setResponses([capturing(captures, messageOf('stop'))]);

    const result = await service.complete({
      systemPrompt: '你是分类器',
      messages,
      timeoutMs: 22222,
      providerNative: { top_p: 0.5 },
    });

    // 结果面：终态消息 + 用量透传（faux 按文本重算 usage——只断言 result 与 message 同源）
    expect(result.message.stopReason).toBe('stop');
    expect(result.usage).toBe(result.message.usage);
    // 直通：messages 引用相等（零拷贝）、systemPrompt 原样
    const seen = captures[0]!;
    expect(seen.context.messages).toBe(messages);
    expect(seen.context.systemPrompt).toBe('你是分类器');
    // 参数合并序：defaults.timeoutMs=11111 打底 → req.timeoutMs=22222 覆盖 → providerNative 平铺
    expect(seen.options?.timeoutMs).toBe(22222);
    expect((seen.options as Record<string, unknown>)['top_p']).toBe(0.5);
  });

  it('模型缺省继承 defaultModel()；req.model 显式覆盖优先', async () => {
    // 显式覆盖：defaultModel 指向不存在的 m9，req.model 用 m2——成功即证明 req.model 生效
    const faux = fauxProvider({ provider: 'faux-test', models: [{ id: 'm1' }, { id: 'm2' }] });
    const runtime = createLlmRuntime({ providers: [faux.provider] });
    const service = createLlmService({ runtime, defaultModel: () => 'faux-test/m9' });
    faux.setResponses([() => messageOf('stop')]);
    await expect(service.complete({ messages: [userMsg('x')], model: 'faux-test/m2' })).resolves.toBeTruthy();

    // 缺省继承：不传 model → 走 defaultModel() 的 m9 → LLM_MODEL_NOT_FOUND（fail-loud 可观察）
    const service2 = createLlmService({ runtime, defaultModel: () => 'faux-test/m9' });
    faux.setResponses([() => messageOf('stop')]);
    await expect(service2.complete({ messages: [userMsg('x')] })).rejects.toMatchObject({ code: LLM_MODEL_NOT_FOUND });
  });

  it('模型解析失败在重试环外 fail-loud：错误直出、零请求发出', async () => {
    const faux = fauxProvider({ provider: 'faux-test', models: [{ id: 'm1' }] });
    const runtime = createLlmRuntime({ providers: [faux.provider] });
    const service = createLlmService({ runtime, defaultModel: () => 'faux-test/m1' });
    let produced = 0;
    faux.setResponses([
      () => {
        produced += 1;
        return messageOf('stop');
      },
    ]);
    await expect(service.complete({ messages: [userMsg('x')], model: 'ghost/m1' })).rejects.toMatchObject({
      code: LLM_MODEL_NOT_FOUND,
    });
    expect(produced).toBe(0);
  });
});

describe('ctx.llm.complete：三条硬要求', () => {
  it('硬要求 1：参数面禁 apiKey（含 as 逃逸与 JS 调用方）', async () => {
    const { faux, service } = makeService();
    faux.setResponses([() => messageOf('stop')]);
    // as 逃逸形态：类型面无 apiKey 字段，运行时护栏拦真实携带者
    const poisoned = { messages: [userMsg('x')], apiKey: 'sk-washed' } as unknown as Parameters<
      typeof service.complete
    >[0];
    await expect(service.complete(poisoned)).rejects.toMatchObject({ code: LLM_COMPLETE_API_KEY_FORBIDDEN });
  });

  it('硬要求 1（透传槽）：providerNative 禁 apiKey / Authorization——不做洗白通道', async () => {
    const { faux, service } = makeService();
    faux.setResponses([() => messageOf('stop')]);
    await expect(
      service.complete({ messages: [userMsg('x')], providerNative: { apiKey: 'sk-washed' } }),
    ).rejects.toMatchObject({ code: LLM_COMPLETE_API_KEY_FORBIDDEN });
    await expect(
      service.complete({ messages: [userMsg('x')], providerNative: { Authorization: 'Bearer x' } }),
    ).rejects.toMatchObject({ code: LLM_COMPLETE_API_KEY_FORBIDDEN });
  });

  it('schema 响亮拒绝：M1 无结构化输出腿，保留签名位', async () => {
    const { faux, service } = makeService();
    faux.setResponses([() => messageOf('stop')]);
    await expect(service.complete({ messages: [userMsg('x')], schema: { type: 'object' } })).rejects.toMatchObject({
      code: LLM_COMPLETE_SCHEMA_UNSUPPORTED,
    });
  });

  it('硬要求 3：transient 错误经 retryAssistantCall 有界重试至成功（单 streamSimple、非 loop）', async () => {
    const { faux, service } = makeService();
    const calls: string[] = [];
    // 缺省策略 maxRetries=1：第一次 fetch failed（transient）、第二次成功
    faux.setResponses([
      () => {
        calls.push('error');
        return messageOf('error', { errorMessage: 'fetch failed' });
      },
      () => {
        calls.push('ok');
        return messageOf('stop');
      },
    ]);
    const result = await service.complete({ messages: [userMsg('x')] });
    expect(calls).toEqual(['error', 'ok']);
    expect(result.message.stopReason).toBe('stop');
  });

  it('硬要求 3：非可重试错误不重试——错误终态转 AppError LLM_COMPLETE_FAILED 载文案', async () => {
    const { faux, service } = makeService();
    let calls = 0;
    faux.setResponses([
      () => {
        calls += 1;
        return messageOf('error', { errorMessage: 'insufficient_quota: billing hard limit reached' });
      },
    ]);
    const rejection = service.complete({ messages: [userMsg('x')] });
    await expect(rejection).rejects.toBeInstanceOf(AppError);
    await expect(rejection).rejects.toMatchObject({ code: LLM_COMPLETE_FAILED });
    expect(calls).toBe(1); // 配额类不可重试——立即收束
  });
});

describe('ctx.llm.complete：计量 seam 与 provider 注册面', () => {
  it('onUsage 收到结果与模型标识；回调异常被隔离不拖垮补全', async () => {
    const faux = fauxProvider({ provider: 'faux-test', models: [{ id: 'm1' }] });
    const runtime = createLlmRuntime({ providers: [faux.provider] });
    const seen: Array<{ model: string; output: number }> = [];
    const service = createLlmService({
      runtime,
      defaultModel: () => 'faux-test/m1',
      onUsage: (result, model) => {
        seen.push({ model, output: result.usage.output });
        throw new Error('计量回调炸了'); // 计量是观测面——异常不得影响补全结果
      },
    });
    faux.setResponses([() => messageOf('stop')]);
    const result = await service.complete({ messages: [userMsg('x')] });
    expect(result.usage).toBe(result.message.usage); // 回调炸了，结果照常返回
    // 计量 seam：模型标识 + 与结果同源的用量（faux 重算 usage，断言一致性而非具体值）
    expect(seen).toEqual([{ model: 'faux-test/m1', output: result.usage.output }]);
  });

  it('registerProvider/unregisterProvider 委派 runtime 底座', () => {
    const { runtime, service } = makeService();
    const extra = fauxProvider({ provider: 'faux-extra', models: [{ id: 'e1' }] });
    const off = service.registerProvider(extra.provider);
    expect(runtime.resolveModel('faux-extra/e1')).toBeTruthy();
    off();
    expect(() => runtime.resolveModel('faux-extra/e1')).toThrowError(AppError);
    // 显式注销面：再注册后走 unregisterProvider(id)
    service.registerProvider(extra.provider);
    service.unregisterProvider('faux-extra');
    expect(() => runtime.resolveModel('faux-extra/e1')).toThrowError(AppError);
  });
});

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
  LLM_BUDGET_EXCEEDED,
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

describe('ctx.llm.complete：canAfford 预算闸门（记忆篇铁律 4 宿主化，2026-08-24 第十一批 durable 底账）', () => {
  /**
   * 模拟装配层 durable 闭环（服务本层不持有账，只持有闸门机制）：ledger 扮演
   * 会话日志——onUsage 写侧（组合根在此落 llm/usage durable 事件，只计
   * background、与聚合口径一致）+ backgroundSpentToday 读侧（persist 聚合查询），
   * 两侧经同一变量闭合为同一本账。日历日窗口/跨会话聚合语义归 persist 侧测试。
   */
  function makeBudgetService(budget: number, ledger: { spent: number } = { spent: 0 }) {
    const faux = fauxProvider({ provider: 'faux-test', models: [{ id: 'm1' }] });
    const runtime = createLlmRuntime({ providers: [faux.provider] });
    const service = createLlmService({
      runtime,
      defaultModel: () => 'faux-test/m1',
      backgroundBudgetTokens: budget,
      // 写侧 seam：组合根经 onUsage 落 llm/usage 事件（此处闭包累计代演装配层）
      onUsage: (result) => {
        if (result.priority === 'background') {
          ledger.spent += result.usage.input + result.usage.output;
        }
      },
      // 读侧 seam：聚合查询注入（真实形态 = persist.spentBackgroundTokensSince 当日窗口）
      backgroundSpentToday: () => ledger.spent,
    });
    return { faux, service };
  }

  it('foreground 恒放行：预算 0 也不拦用户可见请求（priority 显式或缺省同面）', async () => {
    const { faux, service } = makeBudgetService(0, { spent: 1 }); // 账上已有耗用
    faux.setResponses([() => messageOf('stop')]);
    expect(service.canAfford('foreground')).toBe(true);
    expect(service.canAfford('background')).toBe(false); // spent 1 ≥ 预算 0
    await expect(service.complete({ messages: [userMsg('x')], priority: 'foreground' })).resolves.toMatchObject({
      message: { stopReason: 'stop' },
    });
    // 不带 priority 的调用 = 用户可见面（默认前景）——同不拦
    faux.setResponses([() => messageOf('stop')]);
    await expect(service.complete({ messages: [userMsg('x')] })).resolves.toMatchObject({
      message: { stopReason: 'stop' },
    });
  });

  it('后台闸门拒发：预算耗尽 → LLM_BUDGET_EXCEEDED 且零请求发出', async () => {
    const { faux, service } = makeBudgetService(0); // 空账零耗，预算 0 即耗尽
    let produced = 0;
    faux.setResponses([
      () => {
        produced += 1;
        return messageOf('stop');
      },
    ]);
    await expect(service.complete({ messages: [userMsg('x')], priority: 'background' })).rejects.toMatchObject({
      code: LLM_BUDGET_EXCEEDED,
    });
    expect(produced).toBe(0); // 拒在发出前——模型层零消耗
  });

  it('外部入账驱动闸门：首发放行、经 onUsage 入账后二发拒发（durable 闭环 seam 契约）', async () => {
    // 预算 1、账上 0：首发放行；faux 按文本重算用量（prompt/response 非空 → in+out ≥ 1）
    // → onUsage 写侧入账后账面 ≥1，二发即拒。二发被拒 = 写侧 seam 已发生作用的确定性证据。
    const ledger = { spent: 0 };
    const { faux, service } = makeBudgetService(1, ledger);
    faux.setResponses([() => messageOf('stop')]);
    const first = await service.complete({ messages: [userMsg('背景摘要任务')], priority: 'background' });
    expect(first.message.stopReason).toBe('stop');
    expect(first.priority).toBe('background'); // 计量身份随结果——装配层落事件分道用
    expect(first.callId).toMatch(/^[0-9a-f-]{36}$/); // settlement 幂等身份（uuid 标准形状）
    expect(ledger.spent).toBeGreaterThan(0); // 写侧已入账
    expect(service.canAfford('background')).toBe(false); // 读侧读回同一本账——闸门关
    faux.setResponses([() => messageOf('stop')]);
    await expect(service.complete({ messages: [userMsg('再来一发')], priority: 'background' })).rejects.toMatchObject({
      code: LLM_BUDGET_EXCEEDED,
    });
    // 拒发不影响前景面（铁律 4：用户可见请求永远优先）
    faux.setResponses([() => messageOf('stop')]);
    await expect(service.complete({ messages: [userMsg('前台照常')] })).resolves.toMatchObject({
      message: { stopReason: 'stop' },
    });
  });

  it('缺省无装配接线 = 无已耗：backgroundSpentToday 不注入时后台调用不误拦', async () => {
    // dump-config 纯合成树等无持久化装配面：缺省 () => 0——缺账本不是错，闸门只看限额
    const faux = fauxProvider({ provider: 'faux-test', models: [{ id: 'm1' }] });
    const service = createLlmService({
      runtime: createLlmRuntime({ providers: [faux.provider] }),
      defaultModel: () => 'faux-test/m1',
      backgroundBudgetTokens: 100,
    });
    expect(service.canAfford('background')).toBe(true);
    faux.setResponses([() => messageOf('stop')]);
    await expect(service.complete({ messages: [userMsg('x')], priority: 'background' })).resolves.toMatchObject({
      message: { stopReason: 'stop' },
    });
  });

  it('canAfford app 维（契约篇 §5.4 底账统一三维）：未声明恒放行 / 声明按 app 账 / foreground 恒放行', () => {
    // app 维 seam：appBudget = 清单声明面（装配层从 apps/*.app.yaml 折出），
    // appSpentToday = 会话域投影（persist JOIN sessions on app）
    const faux = fauxProvider({ provider: 'faux-test', models: [{ id: 'm1' }] });
    const service = createLlmService({
      runtime: createLlmRuntime({ providers: [faux.provider] }),
      defaultModel: () => 'faux-test/m1',
      backgroundBudgetTokens: 100, // 全局账几乎打满——app 维不得回退用全局账
      backgroundSpentToday: () => 99,
      appBudget: (app) => (app === 'hermes' ? 2_000_000 : undefined),
      appSpentToday: (app) => (app === 'hermes' ? 1_999_999 : 0),
    });
    // 带 app 未声明预算 = 恒放行（不适用全局账——app 维独立判据）
    expect(service.canAfford('background', 'unknown/app')).toBe(true);
    // 声明且未超 = 放行；声明且超 = 拒（全局账打满不传染 app 维）
    expect(service.canAfford('background', 'hermes')).toBe(true);
    // foreground 恒放行（带 app 也不拦——前台不硬断）
    expect(service.canAfford('foreground', 'hermes')).toBe(true);

    const tight = createLlmService({
      runtime: createLlmRuntime({ providers: [faux.provider] }),
      defaultModel: () => 'faux-test/m1',
      appBudget: (app) => (app === 'hermes' ? 100 : undefined),
      appSpentToday: (app) => (app === 'hermes' ? 100 : 0),
    });
    expect(tight.canAfford('background', 'hermes')).toBe(false); // app 账打满 → 拒新跑
    expect(tight.canAfford('background')).toBe(true); // 无 app 走全局账（未接线 = 0 < 缺省）
  });

  it('计量身份：callId 每次调用唯一、priority 缺省 foreground（两者即 llm/usage 事件字段源）', async () => {
    const { faux, service } = makeBudgetService(1_000_000);
    faux.setResponses([() => messageOf('stop'), () => messageOf('stop')]);
    const a = await service.complete({ messages: [userMsg('一')] });
    const b = await service.complete({ messages: [userMsg('二')], priority: 'background' });
    expect(a.priority).toBe('foreground'); // 缺省 = 用户可见面
    expect(b.priority).toBe('background'); // 显式声明透传
    expect(a.callId).not.toBe(b.callId); // 每次调用唯一——write-behind 重试去重锚点
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

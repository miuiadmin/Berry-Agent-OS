/**
 * L1 llm — StreamFn 适配层（骨架篇 §3.1/§5.1：pi-ai 流 → agent StreamFn 契约）。
 *
 * 「永不抛错」契约的实现侧：一切解析/装配失败在本层编码为流内 error 终止事件 +
 * stopReason='error' 的最终消息（错误是数据不是异常，loop 零 try/catch 的根基）。
 * pi-ai 自身的 lazyStream 已把 auth/网络装配失败编码为流 error 事件，本层只补齐
 * 「模型解析失败」这一前置环节。
 *
 * 直通策略（§5.4 超集兼容子集）：messages 标准三角色零转换直通 pi-ai（同构形状，
 * 结构化赋值即可）；工具描述仅做类型收口（parameters 已是 JSON Schema 对象）。
 */

import type {
  AssistantMessage as PiAssistantMessage,
  CacheRetention,
  Context as PiContext,
  Message as PiMessage,
  Model,
  SimpleStreamOptions,
  Tool as PiTool,
} from '@earendil-works/pi-ai';
// 注意：AssistantMessageEventStream 类名被 types.ts 的 type-only 再输出遮蔽，值只能经
// 官方工厂函数取得（该工厂即为此用途提供——"for use in extensions"）
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage, AssistantStream, LlmContext, StreamFn, StreamFnOptions } from '../contracts/llm.js';
import type { AppError } from '../contracts/errors.js';
import { LLM_INFLIGHT_LIMIT } from '../contracts/errors.js';
import type { InFlightSlot, InFlightTracker } from './inflight.js';
import type { LlmRuntime } from './runtime.js';

/**
 * StreamFn 默认请求参数（llm 闭包内持有——重试/采样档位是 provider 层配置，
 * 不进 agent 契约面；骨架篇 §3.2 第二行「SDK 级重试透传」）。
 * abort 是终态绝不重试——pi-ai SDK 行为，本层不另加重试。
 */
export interface StreamFnDefaults {
  /**
   * SDK 级客户端重试上限（网络/限流类 transient 错误）。实证 2026-08-26：
   * pi-ai anthropropic 路径 retryProviderRequest 缺省 **0**（options.maxRetries
   * ?? 0）且 SDK maxRetries 显式关——主链路实际零 provider 层重试，瞬态恢复
   * 由会话层 turn 级 auto-retry 承担（骨架篇 §3.2）；OpenAI SDK 缺省 2 仅其
   * 一家。显式传值才生效，本层不加缺省。
   */
  maxRetries?: number;
  /** 重试延迟帽（毫秒）——服务器要求的长等待超帽即失败上抛，交上层可见处理 */
  maxRetryDelayMs?: number;
  temperature?: number;
  maxTokens?: number;
  /** prompt 缓存保留偏好（pi-ai 统一表达，缺省 short） */
  cacheRetention?: CacheRetention;
  /** HTTP 请求超时（毫秒） */
  timeoutMs?: number;
  /**
   * per-provider 在飞上限（S4 前置债批——多驱动并发背压；装配处可覆写，
   * 0 = 不限）。计数器由装配构造传入（complete 单发路共享同一份）。
   */
  maxInFlightPerProvider?: number;
}

/** 零用量（错误合成消息用） */
const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

/**
 * 创建 agent StreamFn（模型层整体注入 loop 的那一个函数）。
 * @param runtime llm 运行时（Models 宿主）
 * @param defaults 请求参数默认值（重试/采样档位，闭包持有）
 * @param tracker per-provider 在飞计数器（S4 前置债批——缺省不限；装配处与
 *        complete 单发路共享同一份，「per-provider」名实相符）
 */
export function createStreamFn(
  runtime: LlmRuntime,
  defaults: StreamFnDefaults = {},
  tracker?: InFlightTracker,
): StreamFn {
  return (context: LlmContext, options: StreamFnOptions, signal?: AbortSignal): AssistantStream => {
    // 模型解析失败 → 编码为错误流（永不抛错；AppError 在此转数据）。
    // 错误文案携带 [CODE] 前缀（骨架篇 §3.4 M1 过渡态——LLM_* 码族随 provider 包装层成篇）
    let model: Model<string>;
    try {
      model = runtime.resolveModel(options.model);
    } catch (error) {
      const appError = error as AppError;
      const code = appError?.code ? `[${appError.code}] ` : '';
      return errorStream(`模型解析失败：${code}${appError.message ?? String(error)}`);
    }

    // 在飞帽（S4 前置债③）：达帽显式拒绝——错误流带 errorCode（桶表码优先判
    // transient，会话层 auto-retry 退避后槽已释放重试成功）。模型解析先行是
    // 顺序必然：provider 名来自解析产物。
    if (tracker !== undefined) {
      const slot = tracker.tryAcquire(model.provider);
      if (slot === null) {
        return errorStream(
          `在飞请求达帽（provider=${model.provider}）：并发压力自解，会话层退避后重试`,
          LLM_INFLIGHT_LIMIT,
        );
      }
      return withRelease(
        runtime.models.streamSimple(
          model,
          buildPiContext(context),
          buildPiOptions(defaults, options, signal),
        ) as unknown as AssistantStream,
        slot,
      );
    }

    // 事件流结构同构（12 型协议 + result()），超集兼容子集直通
    return runtime.models.streamSimple(
      model,
      buildPiContext(context),
      buildPiOptions(defaults, options, signal),
    ) as unknown as AssistantStream;
  };
}

/** 标准三角色零转换直通（超集兼容子集；引用同一数组，无拷贝） */
function buildPiContext(context: LlmContext): PiContext {
  return {
    systemPrompt: context.systemPrompt,
    messages: context.messages as PiMessage[],
    tools: context.tools?.map(toPiTool),
  };
}

/** defaults 打底 + 具名覆盖 + signal 透传（reasoning 无 'off' 档——undefined 即关闭） */
function buildPiOptions(
  defaults: StreamFnDefaults,
  options: StreamFnOptions,
  signal: AbortSignal | undefined,
): SimpleStreamOptions {
  const { maxInFlightPerProvider: _unused, ...sdkDefaults } = defaults;
  return {
    ...sdkDefaults,
    reasoning:
      options.thinkingLevel !== undefined && options.thinkingLevel !== 'off' ? options.thinkingLevel : undefined,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };
}

/**
 * 流终结释放包装（释放双保险的流侧半边）：消费面 for-await 结束/中断触发迭代
 * return()，终态路径调 result()——任一先到释放名额（slot.release 幂等，双路径
 * 只生效一次）。转发不拦截：事件与终值原样透传。
 */
function withRelease(stream: AssistantStream, slot: InFlightSlot): AssistantStream {
  return {
    [Symbol.asyncIterator]() {
      const iterator = stream[Symbol.asyncIterator]();
      return {
        next: (value?: unknown) => iterator.next(value),
        return: (value?: unknown) => {
          slot.release();
          return iterator.return?.(value) ?? Promise.resolve({ value: undefined, done: true as const });
        },
        throw: (error?: unknown) => {
          slot.release();
          return iterator.throw ? iterator.throw(error) : Promise.reject(error);
        },
      };
    },
    result: async () => {
      try {
        return await stream.result();
      } finally {
        slot.release(); // result() 兜底：流未被完全消费（早 break 不调 return 的消费形态）
      }
    },
  };
}

/** 工具描述收口：AgentTool 的 LLM 面字段 → pi-ai Tool（parameters 已是 JSON Schema 对象） */
function toPiTool(tool: { name: string; description: string; parameters: object }): PiTool {
  return {
    name: tool.name,
    description: tool.description,
    // 类型层面 JSON Schema 对象 → TSchema（运行时同一对象，TypeBox schema 即 JSON Schema；
    // LlmTool.parameters 为宽收 object——兼容 TypeBox 构建器产物与手写 schema 两种来源）
    parameters: tool.parameters as PiTool['parameters'],
  };
}

/**
 * 合成错误流：单 error 终止事件 + 终值消息（pi-ai 事件流原语自建，协议同构）。
 * @param errorCode 宿主合成码（S4 起错误四件套之四——桶表码优先判定用；
 *        文案仍带 [CODE] 前缀维持 M1 过渡态双轨）
 */
function errorStream(errorMessage: string, errorCode?: string): AssistantStream {
  const message: AssistantMessage = {
    role: 'assistant',
    content: [],
    usage: NO_USAGE,
    stopReason: 'error',
    errorMessage: errorCode !== undefined ? `[${errorCode}] ${errorMessage}` : errorMessage,
    ...(errorCode !== undefined ? { errorCode } : {}),
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'error', reason: 'error', error: message as PiAssistantMessage });
  stream.end(message as PiAssistantMessage);
  return stream as unknown as AssistantStream;
}

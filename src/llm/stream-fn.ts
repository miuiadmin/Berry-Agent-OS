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
import type { LlmRuntime } from './runtime.js';

/**
 * StreamFn 默认请求参数（llm 闭包内持有——重试/采样档位是 provider 层配置，
 * 不进 agent 契约面；骨架篇 §3.2 第二行「SDK 级重试透传」）。
 * abort 是终态绝不重试——pi-ai SDK 行为，本层不另加重试。
 */
export interface StreamFnDefaults {
  /** SDK 级客户端重试上限（网络/限流类 transient 错误；pi-ai 各 SDK 缺省 2） */
  maxRetries?: number;
  /** 重试延迟帽（毫秒）——服务器要求的长等待超帽即失败上抛，交上层可见处理 */
  maxRetryDelayMs?: number;
  temperature?: number;
  maxTokens?: number;
  /** prompt 缓存保留偏好（pi-ai 统一表达，缺省 short） */
  cacheRetention?: CacheRetention;
  /** HTTP 请求超时（毫秒） */
  timeoutMs?: number;
}

/** 零用量（错误合成消息用） */
const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

/**
 * 创建 agent StreamFn（模型层整体注入 loop 的那一个函数）。
 * @param runtime llm 运行时（Models 宿主）
 * @param defaults 请求参数默认值（重试/采样档位，闭包持有）
 */
export function createStreamFn(runtime: LlmRuntime, defaults: StreamFnDefaults = {}): StreamFn {
  return (context: LlmContext, options: StreamFnOptions, signal?: AbortSignal): AssistantStream => {
    // 模型解析失败 → 编码为错误流（永不抛错；AppError 在此转数据）
    let model: Model<string>;
    try {
      model = runtime.resolveModel(options.model);
    } catch (error) {
      const appError = error as AppError;
      return errorStream(`模型解析失败：${appError.message ?? String(error)}`);
    }

    // 标准三角色零转换直通（超集兼容子集；引用同一数组，无拷贝）
    const piContext: PiContext = {
      systemPrompt: context.systemPrompt,
      messages: context.messages as PiMessage[],
      tools: context.tools?.map(toPiTool),
    };
    const piOptions: SimpleStreamOptions = {
      ...defaults,
      // reasoning 无 'off' 档——undefined 即关闭（pi-ai 语义）
      reasoning:
        options.thinkingLevel !== undefined && options.thinkingLevel !== 'off' ? options.thinkingLevel : undefined,
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(signal !== undefined ? { signal } : {}),
    };
    // 事件流结构同构（12 型协议 + result()），超集兼容子集直通
    return runtime.models.streamSimple(model, piContext, piOptions) as unknown as AssistantStream;
  };
}

/** 工具描述收口：AgentTool 的 LLM 面字段 → pi-ai Tool（parameters 已是 JSON Schema 对象） */
function toPiTool(tool: { name: string; description: string; parameters: Record<string, unknown> }): PiTool {
  return {
    name: tool.name,
    description: tool.description,
    // 类型层面 JSON Schema 对象 → TSchema（运行时同一对象，TypeBox schema 即 JSON Schema）
    parameters: tool.parameters as PiTool['parameters'],
  };
}

/**
 * 合成错误流：单 error 终止事件 + 终值消息（pi-ai 事件流原语自建，协议同构）。
 */
function errorStream(errorMessage: string): AssistantStream {
  const message: AssistantMessage = {
    role: 'assistant',
    content: [],
    usage: NO_USAGE,
    stopReason: 'error',
    errorMessage,
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'error', reason: 'error', error: message as PiAssistantMessage });
  stream.end(message as PiAssistantMessage);
  return stream as unknown as AssistantStream;
}

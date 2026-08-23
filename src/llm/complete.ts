/**
 * L1 llm — ctx.llm 具名服务（骨架篇 §9.3 动作层：插件发起单次受托管补全的唯一合法路径）。
 *
 * 2026-08-23 生态读码 same-flaw 1 的兑现：pi-6（宿主无「以当前会话身份跑一次补全」原语）
 * + dsh-9（出口）——没有它，M2 记忆插件只能特权接线（违反契约篇 §6.2）或自拼凭证。
 *
 * 三条硬要求（dsh-9 反推，规范 §9.3 原文）：
 * 1. 参数面禁 apiKey——凭证一律走 CredentialStore 缺省解析，providerNative 透传槽内携带同理；
 * 2. 轻量单发就是单发——不起 subagent loop（loop 装配是任务委派的成本，不是摘要/分类的成本）；
 * 3. 复用 resolveModel + retryAssistantCall + StreamFnDefaults——与主对话同一模型解析、
 *    重试语义与请求参数面，插件不另立炉灶。
 */

import type { AssistantMessage, Message, Usage } from '../contracts/llm.js';
import {
  AppError,
  LLM_COMPLETE_API_KEY_FORBIDDEN,
  LLM_COMPLETE_SCHEMA_UNSUPPORTED,
  LLM_COMPLETE_FAILED,
} from '../contracts/errors.js';
import type { LlmRuntime } from './runtime.js';
import type { StreamFnDefaults } from './stream-fn.js';
import { retryAssistantCall, type RetryPolicy } from './recovery.js';
import type { Message as PiMessage, SimpleStreamOptions } from '@earendil-works/pi-ai';

/** 单发补全请求（插件侧唯一参数面——apiKey 禁入是运行时护栏不是类型约定） */
export interface CompleteRequest {
  /** 系统提示词（缺省无） */
  systemPrompt?: string;
  /** 补全输入（contracts 标准三角色直通 pi-ai——超集兼容子集零转换；自定义角色经 convertToLlm 属 loop 职责，单发面不收） */
  messages: Message[];
  /** 模型标识（"provider/model-id"）；缺省继承会话当前模型 */
  model?: string;
  /**
   * TypeBox 构建器产物（与 ToolDefinition.parameters 同面）。M1 pi-ai 无结构化输出腿——
   * 传即 LLM_COMPLETE_SCHEMA_UNSUPPORTED 响亮拒绝，保留签名位（精确面随 M2 provider 钩子收口）。
   */
  schema?: object;
  /** HTTP 请求超时（毫秒），覆盖构造期 StreamFnDefaults.timeoutMs */
  timeoutMs?: number;
  /** 取消信号（透传 pi-ai + retryAssistantCall——abort 归一为 aborted 终态消息，不重试） */
  signal?: AbortSignal;
  /**
   * 'background' 接记忆篇 canAfford 预算闸门——M1 闸门未落（随 M2 记忆插件），
   * 当前收下不闸、等同 foreground；签名先钉死防后补即 breaking。
   */
  priority?: 'background' | 'foreground';
  /** provider 原生参数透传槽——平铺展开进 pi-ai 请求参数（具名键之后，可覆盖）；钩子审计面 M2 落（骨架篇 §3.4） */
  providerNative?: Record<string, unknown>;
}

/** 单发补全结果：终态消息 + 用量（usage 已过 onUsage 计量回调） */
export interface CompleteResult {
  message: AssistantMessage;
  usage: Usage;
}

/** ctx.llm 服务面（骨架篇 §9.3：complete + provider 注册/注销） */
export interface LlmService {
  /** 注册/替换 provider（按 id upsert）；返回注销函数（插件卸载路径） */
  registerProvider(provider: Parameters<LlmRuntime['registerProvider']>[0]): () => void;
  /** 按 id 移除 provider */
  unregisterProvider(id: string): void;
  /** 单发受托管补全（本文件主角） */
  complete(req: CompleteRequest): Promise<CompleteResult>;
}

/** 服务构造选项 */
export interface LlmServiceOptions {
  /** llm 运行时（Models 宿主——与主对话共用同一实例） */
  runtime: LlmRuntime;
  /** 请求参数默认值（与 createStreamFn 共用同一份——重试/采样档位全宿主一致） */
  defaults?: StreamFnDefaults;
  /** 会话当前模型缺省（函数面：运行时可变，M2 ctx.agent.setModel 接管后随之） */
  defaultModel: () => string;
  /** 有界重试策略（缺省开 1 次重试——transient 网络抖动兜底，非 loop 级成本） */
  retry?: RetryPolicy;
  /**
   * 用量计量回调（统一计量账 seam——canAfford 数据源宿主化，M2 记忆篇）。
   * 回调异常被隔离：计量是观测面，不拖垮补全结果本身。
   */
  onUsage?: (result: CompleteResult, modelSpec: string) => void;
}

/** 缺省重试策略：开 1 次重试、500ms 起步指数退避（SDK 级 maxRetries 之外的有界第二层） */
const DEFAULT_RETRY: RetryPolicy = { enabled: true, maxRetries: 1, baseDelayMs: 500 };

/** providerNative 内禁入的凭证类键（与参数面 apiKey 同禁——透传槽不做洗白通道） */
const FORBIDDEN_PROVIDER_NATIVE_KEYS = new Set(['apikey', 'authorization']);

/**
 * 创建 ctx.llm 具名服务（组合根 provide('llm') 的那一行所注对象）。
 */
export function createLlmService(options: LlmServiceOptions): LlmService {
  const { runtime, defaults = {}, defaultModel, retry = DEFAULT_RETRY } = options;

  return {
    registerProvider: (provider) => runtime.registerProvider(provider),
    unregisterProvider: (id) => runtime.unregisterProvider(id),

    async complete(req: CompleteRequest): Promise<CompleteResult> {
      // 硬要求 1：参数面禁 apiKey（类型面无此字段，运行时护栏拦 JS 调用方与 as 逃逸）
      if ('apiKey' in req) {
        throw new AppError(
          LLM_COMPLETE_API_KEY_FORBIDDEN,
          'complete 参数面禁 apiKey——凭证一律走 CredentialStore 缺省解析',
        );
      }
      if (req.schema !== undefined) {
        throw new AppError(
          LLM_COMPLETE_SCHEMA_UNSUPPORTED,
          'M1 不支持结构化输出（pi-ai 面无此腿）——schema 随 M2 provider 钩子收口',
        );
      }
      // 透传槽同样禁凭证类键：不做 apiKey → providerNative.apiKey 的洗白通道
      for (const key of Object.keys(req.providerNative ?? {})) {
        if (FORBIDDEN_PROVIDER_NATIVE_KEYS.has(key.toLowerCase())) {
          throw new AppError(LLM_COMPLETE_API_KEY_FORBIDDEN, `providerNative 禁携带凭证类键：${key}`);
        }
      }

      // 模型解析 fail-loud（AppError LLM_MODEL_*——分类不归插件自理）；在重试环外：解析错误是确定性的，重试无意义
      const modelSpec = req.model ?? defaultModel();
      const model = runtime.resolveModel(modelSpec);

      // 标准三角色零转换直通（同 stream-fn 直通策略）；单发无工具面
      const piContext = {
        systemPrompt: req.systemPrompt,
        messages: req.messages as unknown as PiMessage[],
      };
      // defaults 打底 → 具名覆盖 → providerNative 最后平铺（可覆盖具名键，pi-ai samplingParams 同语义）
      const piOptions: SimpleStreamOptions = {
        ...defaults,
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        ...req.providerNative,
      };

      // 硬要求 2：单发不 loop——一次 streamSimple + 有界 transient 重试（硬要求 3 的 retryAssistantCall）
      const message = await retryAssistantCall(
        async () => {
          const stream = runtime.models.streamSimple(model, piContext, piOptions);
          return (await stream.result()) as unknown as AssistantMessage;
        },
        retry,
        req.signal,
      );

      // 错误终态 → AppError（错误是异常不是数据：complete 面向 await 的插件调用方，不消费事件流）
      if (message.stopReason === 'error') {
        throw new AppError(LLM_COMPLETE_FAILED, message.errorMessage ?? '单发补全失败（pi-ai 错误终态）');
      }

      const result: CompleteResult = { message, usage: message.usage };
      // 计量 seam：回调异常隔离（观测面不拖垮补全结果）
      try {
        options.onUsage?.(result, modelSpec);
      } catch {
        // onUsage 是宿主接线面的责任——异常静默（组合根侧应自兜底），此处不归插件感知
      }
      return result;
    },
  };
}

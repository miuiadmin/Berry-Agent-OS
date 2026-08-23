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
 *
 * 预算闸门底账 durable 化（2026-08-24 第十一批拍板 #1，loopx 读码启发 #1——会话篇 §1.1）：
 * 花销 = llm/usage durable 事件（onUsage 写侧经组合根落日志），余额 = 注入的聚合查询
 * （backgroundSpentToday 读侧）——余额不存储、重放推导；原 per-process 内存账形态退役。
 */

import type { AssistantMessage, Message, Usage } from '../contracts/llm.js';
import { randomUUID } from 'node:crypto';
import {
  AppError,
  LLM_BUDGET_EXCEEDED,
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
   * 'background' 接记忆篇 canAfford 预算闸门（骨架篇 §9.3，2026-08-24 落码）：
   * 后台调用且当日后台累计 tokens 已达限额 → LLM_BUDGET_EXCEEDED 拒发
   * （调用方捕获即「跳过本轮、下个周期再试」）；'foreground' 恒放行——
   * 用户可见请求永远优先（铁律 4 原文）。
   */
  priority?: 'background' | 'foreground';
  /** provider 原生参数透传槽——平铺展开进 pi-ai 请求参数（具名键之后，可覆盖）；钩子审计面 M2 落（骨架篇 §3.4） */
  providerNative?: Record<string, unknown>;
}

/** 单发补全结果：终态消息 + 用量 + 计量身份（usage 已过 onUsage 计量回调） */
export interface CompleteResult {
  message: AssistantMessage;
  usage: Usage;
  /**
   * 本次补全的结算 id（settlement 幂等身份，2026-08-24 第十一批——会话篇 §1.1
   * llm/usage 事件的 callId 字段源）：每次 complete 调用唯一生成，装配层落
   * durable 计量事件携此 id——write-behind 重试去重的锚点。
   */
  callId: string;
  /** 本次调用的预算道（装配层落 llm/usage 事件的 priority 字段源） */
  priority: 'background' | 'foreground';
}

/** ctx.llm 服务面（骨架篇 §9.3：complete + provider 注册/注销 + canAfford 预算闸门） */
export interface LlmService {
  /** 注册/替换 provider（按 id upsert）；返回注销函数（插件卸载路径） */
  registerProvider(provider: Parameters<LlmRuntime['registerProvider']>[0]): () => void;
  /** 按 id 移除 provider */
  unregisterProvider(id: string): void;
  /** 单发受托管补全（本文件主角） */
  complete(req: CompleteRequest): Promise<CompleteResult>;
  /**
   * 预算闸门查询（记忆篇铁律 4 宿主化数据源）：'foreground' 恒 true；'background'
   * = 当日后台累计 tokens（in+out）< 限额。数据源 = 注入的聚合查询
   * （backgroundSpentToday——底账为会话日志 llm/usage durable 事件的投影，
   * 2026-08-24 第十一批拍板 #1：花销是事件流事实、余额不存储，重启/双开/审计
   * 三题一次解；llm 模块不持有账，只持有闸门机制）。
   */
  canAfford(priority: 'background' | 'foreground'): boolean;
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
   * 用量计量回调（底账接线 seam——2026-08-24 第十一批后即 canAfford 数据源的
   * 写侧：组合根在此落 llm/usage durable 事件，read 侧聚合查询注入
   * backgroundSpentToday，两侧经事件日志闭合为同一本账）。
   * 回调异常被隔离：计量是观测面，不拖垮补全结果本身。
   */
  onUsage?: (result: CompleteResult, modelSpec: string) => void;
  /** 当日后台预算限额 tokens（in+out 合计；缺省 4,000,000——起草值随实测调，骨架篇 §9.3） */
  backgroundBudgetTokens?: number;
  /**
   * 当日后台已耗查询（缺省 () => 0——无装配接线即无已耗；生产由组合根注入：
   * 对会话日志 llm/usage 事件的当日时间窗聚合，persist 模块实现）。
   * 底账 durable 化（2026-08-24 第十一批拍板 #1，loopx 读码启发 #1——余额不存、
   * 重放推导）：替代原 per-process 内存账——重启不清零、双开各记半边两 seam 当日清除。
   * write-behind 批落窗口内的最近一笔可能未及落盘（闸门偏松一笔）——与
   * 「最后一发可略超限额」同语义，预算是软闸门不是安全边界。
   */
  backgroundSpentToday?: () => number;
}

/** 缺省重试策略：开 1 次重试、500ms 起步指数退避（SDK 级 maxRetries 之外的有界第二层） */
const DEFAULT_RETRY: RetryPolicy = { enabled: true, maxRetries: 1, baseDelayMs: 500 };

/** providerNative 内禁入的凭证类键（与参数面 apiKey 同禁——透传槽不做洗白通道） */
const FORBIDDEN_PROVIDER_NATIVE_KEYS = new Set(['apikey', 'authorization']);

/** 缺省后台预算：当日后台补全 tokens（in+out 合计）限额（起草值，骨架篇 §9.3） */
const DEFAULT_BACKGROUND_BUDGET = 4_000_000;

/**
 * 创建 ctx.llm 具名服务（组合根 provide('llm') 的那一行所注对象）。
 */
export function createLlmService(options: LlmServiceOptions): LlmService {
  const { runtime, defaults = {}, defaultModel, retry = DEFAULT_RETRY } = options;
  const budget = options.backgroundBudgetTokens ?? DEFAULT_BACKGROUND_BUDGET;
  // 当日后台已耗 = 注入的聚合查询（底账 = 会话日志 llm/usage 事件投影，缺省无已耗）
  const spentToday = options.backgroundSpentToday ?? (() => 0);

  const canAfford = (priority: 'background' | 'foreground'): boolean =>
    priority === 'foreground' ? true : spentToday() < budget;

  return {
    registerProvider: (provider) => runtime.registerProvider(provider),
    unregisterProvider: (id) => runtime.unregisterProvider(id),

    canAfford,

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
      // 预算闸门（骨架篇 §9.3）：后台调用且当日已耗尽 → 拒发。检查在调用前；入账
      // 在成功后（装配层经 onUsage 落 llm/usage durable 事件）——最后一发可略超限额
      //（check-then-act 于单发粒度；另 write-behind 批落窗口内的最近一笔闸门可能未见，
      // 同为「略超」语义——预算是软闸门，不是安全边界）
      if (req.priority === 'background' && !canAfford('background')) {
        throw new AppError(
          LLM_BUDGET_EXCEEDED,
          `当日后台预算已耗尽（限额 ${budget} tokens）——用户可见请求永远优先，后台任务下个周期再试`,
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

      // 计量身份随结果携带：callId 供装配层落 llm/usage（settlement 幂等），
      // priority 供事件分道（聚合只计 background）
      const result: CompleteResult = {
        message,
        usage: message.usage,
        callId: randomUUID(),
        priority: req.priority ?? 'foreground',
      };
      // 计量 seam：回调异常隔离（观测面不拖垮补全结果；底账由装配层在此落 durable）
      try {
        options.onUsage?.(result, modelSpec);
      } catch {
        // onUsage 是宿主接线面的责任——异常静默（组合根侧应自兜底），此处不归插件感知
      }
      return result;
    },
  };
}

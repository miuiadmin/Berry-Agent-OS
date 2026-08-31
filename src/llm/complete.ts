/**
 * L1 llm — ctx.llm 具名服务（骨架篇 §9.3 动作层：应用发起单次受托管补全的唯一合法路径）。
 *
 * 2026-08-23 生态读码 same-flaw 1 的兑现：pi-6（宿主无「以当前会话身份跑一次补全」原语）
 * + dsh-9（出口）——没有它，M2 记忆应用只能特权接线（违反契约篇 §6.2）或自拼凭证。
 *
 * 三条硬要求（dsh-9 反推，规范 §9.3 原文）：
 * 1. 参数面禁 apiKey——凭证一律走 CredentialStore 缺省解析，providerNative 透传槽内携带同理；
 * 2. 轻量单发就是单发——不起 subagent loop（loop 装配是任务委派的成本，不是摘要/分类的成本）；
 * 3. 复用 resolveModel + retryAssistantCall + StreamFnDefaults——与主对话同一模型解析、
 *    重试语义与请求参数面，应用不另立炉灶。
 *
 * 预算闸门底账 durable 化（2026-08-24 第十一批拍板 #1，loopx 读码启发 #1——会话篇 §1.1）：
 * 花销 = llm/usage durable 事件（onUsage 写侧经组合根落日志），余额 = 注入的聚合查询
 * （backgroundSpentToday 读侧）——余额不存储、重放推导；原 per-process 内存账形态退役。
 *
 * 底账统一真实请求（2026-08-25 应用面第二纵切拍板，契约篇 §5.4）：主 loop 前台花销
 * 经 chat durable 折叠同落 llm/usage（foreground 道——落点在 chat/durable.ts 非 complete，
 * 此处只持有闸门）；canAfford 升三维 (当日, priority, app)——app 维 = 会话域投影归集。
 */

import type { AssistantMessage, Message, ModelInfo, Usage } from '../contracts/llm.js';
import { randomUUID } from 'node:crypto';
import {
  AppError,
  LLM_BUDGET_EXCEEDED,
  LLM_COMPLETE_API_KEY_FORBIDDEN,
  LLM_COMPLETE_SCHEMA_UNSUPPORTED,
  LLM_COMPLETE_FAILED,
  LLM_INFLIGHT_LIMIT,
} from '../contracts/errors.js';
import type { LlmRuntime } from './runtime.js';
import { formatModelId } from './model-id.js';
import type { StreamFnDefaults } from './stream-fn.js';
import type { InFlightTracker } from './inflight.js';
import {
  classifyAssistantError,
  isContextOverflow,
  type ErrorBucket,
  retryAssistantCall,
  type RetryPolicy,
} from './recovery.js';
import type { Message as PiMessage, SimpleStreamOptions } from '@earendil-works/pi-ai';

/** 单发补全请求（应用侧唯一参数面——apiKey 禁入是运行时护栏不是类型约定） */
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
  /**
   * 应用域标记（契约篇 §5.4 底账统一第三维，2026-08-25 纵切二落码）：
   * 调用方携当前会话域（无会话的后台 job 取 job 归属应用），后台闸门按应用账
   * 判——未声明 budget 的应用恒放行。入账侧不读本字段（花销按 sessions.app
   * 会话域投影归集，payload 不加 appId）；前台调用忽略此字段（恒放行）。
   */
  app?: string;
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

/** ctx.llm 服务面（骨架篇 §9.3：complete + provider 注册/注销 + 模型目录只读投影 + canAfford 预算闸门） */
export interface LlmService {
  /** 注册/替换 provider（按 id upsert）；返回注销函数（应用卸载路径） */
  registerProvider(provider: Parameters<LlmRuntime['registerProvider']>[0]): () => void;
  /** 按 id 移除 provider */
  unregisterProvider(id: string): void;
  /**
   * 模型目录只读投影（2026-08-26 挖矿批 P0-1，骨架篇 §9.3——四包实证的 provider
   * 应用枚举需求）：pi-ai Models 接口包装（与主对话同一 Models 实例——registerProvider
   * 增补即刻可见），不新开特权口（pi-11：宿主数据不开放读面 = 生态直读私有格式的起点）。
   * 投影形 ModelInfo：传输/配置面（baseUrl/headers 等）不披露。
   */
  listModels(provider?: string): ModelInfo[];
  /** 单模型查询（listModels 的点查形态，同表同账；id = "provider/model-id" 全形） */
  getModel(id: string): ModelInfo | undefined;
  /** 单发受托管补全（本文件主角） */
  complete(req: CompleteRequest): Promise<CompleteResult>;
  /**
   * 预算闸门查询（记忆篇铁律 4 宿主化数据源）：'foreground' 恒 true；'background'
   * = 当日后台累计 tokens（in+out）< 限额。数据源 = 注入的聚合查询
   * （backgroundSpentToday——底账为会话日志 llm/usage durable 事件的投影，
   * 2026-08-24 第十一批拍板 #1：花销是事件流事实、余额不存储，重启/双开/审计
   * 三题一次解；llm 模块不持有账，只持有闸门机制）。
   *
   * 第三维 app（契约篇 §5.4 应用面第二纵切，2026-08-25 底账统一拍板）：
   * 会话域投影归集——花销按 sessions.app 归集到应用名下当日账。调用语义：
   * 查询方带当前会话域（后台 job 无会话时取 job 归属）；**未声明 budget 的
   * 应用恒 true**（无预算 = 不闸，全局缺省限额只作用于 background 道全局账）。
   * 超限执法只落 background（后台拒新跑）；foreground 恒放行花销照进账
   * （可见性走 /usage 计量投影面，不硬断）。
   */
  canAfford(priority: 'background' | 'foreground', app?: string): boolean;
  /**
   * 错误桶判定（S4 前置债批——全仓唯一一份桶表 recovery.ts classifyAssistantError
   * 的服务面公开位）：chat 件等宿主内消费方经 ctx 取用（chat 拓扑边不含 llm，
   * 判定器经服务面注入驱动——「应用侧禁写第二份分桶」的执法前提是宿主面可得）。
   */
  classifyError(message: AssistantMessage): ErrorBucket;
  /**
   * 溢出判定（第四十五批溢出兜底——窗口携带）：recovery.isContextOverflow 的
   * 服务面公开位。静默溢出（input+cacheRead ≥ 窗口×0.99 且正常停）与 length
   * 零输出两路依赖 contextWindow——窗口按模型目录活取（chat 件判定器注入携
   * 当轮效值模型，非装配期定死）；目录缺模型 = undefined → 诚实退化仅错误
   * 正则一路（注记不阻断——冷读 P1-3）。
   */
  isContextOverflowFor(message: AssistantMessage, model: string): boolean;
}

/** 服务构造选项 */
export interface LlmServiceOptions {
  /** llm 运行时（Models 宿主——与主对话共用同一实例） */
  runtime: LlmRuntime;
  /** 请求参数默认值（与 createStreamFn 共用同一份——重试/采样档位全宿主一致） */
  defaults?: StreamFnDefaults;
  /**
   * per-provider 在飞计数器（S4 前置债批——与 createStreamFn 共享同一份：
   * 两出口同源计数「per-provider」名实相符。complete 路达帽**同拒**：
   * produce 返回 LLM_INFLIGHT_LIMIT 错误终态 → pi-ai 正则归 non-retryable
   * 上抛 LLM_COMPLETE_FAILED——过载期单发失败由调用方自然重试，不造排队口子。
   */
  tracker?: InFlightTracker;
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
  /**
   * onUsage 回调异常的观测面（复盘 20260901 E-3）：回调抛错时携带
   * { callId, model, error } 上抛给接线面落 warn 日志——llm/usage 是预算
   * 投影唯一底账，丢账不静默。llm 边表仅 contracts（不引 context logger），
   * 故走窄面回调；组合根接 ctx.logger.warn。缺省不接 = 零观测（lib 形态）。
   */
  onUsageError?: (err: unknown, info: { callId: string; model: string }) => void;
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
  /**
   * 应用预算查询（canAfford 第三维数据源；缺省恒 undefined = 未声明）：
   * app id → 该应用清单声明的 budget.dailyTokens。生产由组合根注入
   * （应用注册表闭包——装载期官方清单 + 未来第三方清单合流）。
   * 未声明的应用恒 true 不闸（无预算 = 不闸，全局限额只管全局账）。
   */
  appBudget?: (app: string) => number | undefined;
  /**
   * 应用域当日后台已耗查询（缺省 () => 0——无装配接线即无已耗；生产由组合根注入：
   * 会话日志 llm/usage 事件按 sessions.app 会话域投影的当日聚合，persist 模块实现）。
   * 与 backgroundSpentToday 同底账不同切面：全局账按 time 全局过滤，应用账
   * 额外 JOIN sessions 按域归集（底账事件载荷不加 appId——域归属是会话行属性）。
   */
  appSpentToday?: (app: string) => number;
}

/** 缺省重试策略：开 1 次重试、500ms 起步指数退避（SDK 级 maxRetries 之外的有界第二层） */
const DEFAULT_RETRY: RetryPolicy = { enabled: true, maxRetries: 1, baseDelayMs: 500 };

/** 零用量（达帽错误终态合成用——同 stream-fn 的 errorStream 惯例） */
const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

/** providerNative 内禁入的凭证类键（与参数面 apiKey 同禁——透传槽不做洗白通道） */
const FORBIDDEN_PROVIDER_NATIVE_KEYS = new Set(['apikey', 'authorization']);

/** 缺省后台预算：当日后台补全 tokens（in+out 合计）限额（起草值，骨架篇 §9.3） */
const DEFAULT_BACKGROUND_BUDGET = 4_000_000;

/**
 * 创建 ctx.llm 具名服务（组合根 provide('llm') 的那一行所注对象）。
 */
export function createLlmService(options: LlmServiceOptions): LlmService {
  const { runtime, defaults = {}, defaultModel, retry = DEFAULT_RETRY, tracker } = options;
  const budget = options.backgroundBudgetTokens ?? DEFAULT_BACKGROUND_BUDGET;
  // 当日后台已耗 = 注入的聚合查询（底账 = 会话日志 llm/usage 事件投影，缺省无已耗）
  const spentToday = options.backgroundSpentToday ?? (() => 0);
  // 应用面三维（缺省 = 无声明无已耗：canAfford(app) 恒 true——诊断装配形态）
  const appBudget = options.appBudget ?? (() => undefined);
  const appSpentToday = options.appSpentToday ?? (() => 0);

  /**
   * 预算闸门（三维）：
   * - foreground 恒 true（用户可见请求永远优先，铁律 4 原文——前台不硬断）；
   * - background 无 app：全局账（当日全局 background 累计 < 全局限额）；
   * - background 带 app：应用未声明 budget 恒 true（无预算不闸）；声明了则按
   *   应用域当日归集账比较（会话域投影——底账同源，切面不同）。
   */
  const canAfford = (priority: 'background' | 'foreground', app?: string): boolean => {
    if (priority === 'foreground') return true;
    if (app === undefined) return spentToday() < budget;
    const declared = appBudget(app);
    if (declared === undefined) return true;
    return appSpentToday(app) < declared;
  };

  /** pi-ai Model → ModelInfo 投影（listModels/getModel 同一映射，同表同账） */
  const toModelInfo = (m: ReturnType<LlmRuntime['listModels']>[number]): ModelInfo => ({
    id: formatModelId(m.provider, m.id),
    name: m.name,
    provider: m.provider,
    reasoning: m.reasoning,
    input: [...m.input],
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  });

  /** 目录点查窗口（第四十五批溢出兜底）：全形 id → contextWindow；缺模型 undefined（诚实退化） */
  const contextWindowOf = (id: string): number | undefined => {
    const found = runtime.listModels().find((m) => formatModelId(m.provider, m.id) === id);
    return found === undefined ? undefined : found.contextWindow;
  };

  return {
    registerProvider: (provider) => runtime.registerProvider(provider),
    unregisterProvider: (id) => runtime.unregisterProvider(id),

    // 错误桶判定（S4）：recovery 桶表直通——全仓唯一一份分桶的公开消费位
    classifyError: (message: AssistantMessage) => classifyAssistantError(message),

    // 溢出判定（第四十五批溢出兜底）：窗口活取目录点查——缺模型 undefined 即
    // 仅错误正则一路（静默溢出/length 零输出两路天然不触发，诚实退化不阻断）
    isContextOverflowFor: (message: AssistantMessage, model: string) =>
      isContextOverflow(message, contextWindowOf(model)),

    // 模型目录只读投影（P0-1）：pi-ai Model → ModelInfo 字段子集直通——id 组
    // "provider/model-id" 全形（resolveModel 同名可解析），传输/配置面不披露
    listModels(provider?: string): ModelInfo[] {
      return runtime.listModels(provider).map(toModelInfo);
    },
    // 点查复用同一投影（同表同账）；全形 id 不在目录 = undefined（点查语义——
    // 不抛 LLM_MODEL_NOT_FOUND，那是 resolveModel 发补全请求时的 fail-loud 面）
    getModel(id: string): ModelInfo | undefined {
      const found = runtime.listModels().find((m) => formatModelId(m.provider, m.id) === id);
      return found === undefined ? undefined : toModelInfo(found);
    },

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
      // 预算闸门（骨架篇 §9.3 + 契约篇 §5.4 三维）：后台调用且当日已耗尽 → 拒发。
      // 检查在调用前；入账在成功后（装配层经 onUsage 落 llm/usage durable 事件）——
      // 最后一发可略超限额（check-then-act 于单发粒度；另 write-behind 批落窗口内的
      // 最近一笔闸门可能未见，同为「略超」语义——预算是软闸门，不是安全边界）。
      // 带 app = 应用账判据（未声明恒放行）；不带 = 全局账。
      if (req.priority === 'background' && !canAfford('background', req.app)) {
        throw new AppError(
          LLM_BUDGET_EXCEEDED,
          req.app !== undefined
            ? `应用 ${req.app} 当日后台预算已耗尽——用户可见请求永远优先，后台任务下个周期再试`
            : `当日后台预算已耗尽（限额 ${budget} tokens）——用户可见请求永远优先，后台任务下个周期再试`,
        );
      }
      // 透传槽同样禁凭证类键：不做 apiKey → providerNative.apiKey 的洗白通道
      for (const key of Object.keys(req.providerNative ?? {})) {
        if (FORBIDDEN_PROVIDER_NATIVE_KEYS.has(key.toLowerCase())) {
          throw new AppError(LLM_COMPLETE_API_KEY_FORBIDDEN, `providerNative 禁携带凭证类键：${key}`);
        }
      }

      // 模型解析 fail-loud（AppError LLM_MODEL_*——分类不归应用自理）；在重试环外：解析错误是确定性的，重试无意义
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
          // 在飞帽（S4 前置债③）：与主循环路同源计数；达帽同拒——错误终态带
          // errorCode，经 pi-ai 正则归 non-retryable 即刻上抛（不造排队口子）
          const slot = tracker?.tryAcquire(model.provider) ?? null;
          if (slot === null && tracker !== undefined) {
            return {
              role: 'assistant',
              content: [],
              usage: NO_USAGE,
              stopReason: 'error',
              errorMessage: `[${LLM_INFLIGHT_LIMIT}] 在飞请求达帽（provider=${model.provider}）：过载期单发失败，调用方稍后自然重试`,
              errorCode: LLM_INFLIGHT_LIMIT,
              timestamp: Date.now(),
            } as AssistantMessage;
          }
          try {
            const stream = runtime.models.streamSimple(model, piContext, piOptions);
            return (await stream.result()) as unknown as AssistantMessage;
          } finally {
            slot?.release(); // result() 即流终结：单发消费面只走这一条路，finally 必达
          }
        },
        retry,
        req.signal,
      );

      // 错误终态 → AppError（错误是异常不是数据：complete 面向 await 的应用调用方，不消费事件流）
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
      } catch (usageErr) {
        // onUsage 异常隔离不变，但不再零可观测（复盘 20260901 E-3）：llm/usage 是
        // 预算闸门唯一底账，丢账必须可观测——经 onUsageError 交接线面落 warn
        options.onUsageError?.(usageErr, { callId: result.callId, model: modelSpec });
      }
      return result;
    },
  };
}

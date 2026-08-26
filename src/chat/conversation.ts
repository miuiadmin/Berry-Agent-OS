/**
 * L4 chat — 会话驱动（ConversationDriver：活数组 + 队列的通道宿主面 + run 编排）。
 *
 * 2026-08-24 应用面第一纵切自 assembly.ts 迁出（契约篇 §5.4 件本体①）、同日
 * 铭牌批入册 src/chat/ 件聚落：驱动构造归 `builtin:chat` 对话应用官方件，本文件
 * 只承载驱动本体——assembly（组合根）与 plugin（件）及双入口共同引用，独立成
 * 文件防装配环（assembly 经 builtins 引件，件引驱动类型，不得反向）。
 *
 * submit 在 running 时入 steering 队列、闲时直接开 run；run 自然停后余量按
 * followUp 续跑；loop 级异常在此合成 error 收尾（骨架篇：run 级兜底在 app
 * 不在内核）。
 */

import { PendingMessageQueue } from '../agent/queue.js';
import type { AgentEvent, AgentEventSink, RunStatus } from '../agent/events.js';
import type { AgentContext, AgentLoopConfig, RunResult } from '../agent/loop.js';
import { startRun } from '../agent/loop.js';
import type { AgentMessage } from '../contracts/messages.js';
import type { AssistantMessage, Usage } from '../contracts/llm.js';
import { describeError } from '../contracts/errors.js';
import { runInSessionChain } from '../context/chain.js';
import type { Session } from '../session/session.js';
import type { DurableSinks } from './durable.js';
import { projectedToAgentMessages } from './durable.js';
import type { LlmRetryData } from '../session/event-types.js';

/**
 * 会话层重试策略（S4 前置债批，骨架篇 §3.2 会话层行⑦——结构同构 pi-ai
 * RetryPolicy；驱动不 import llm 模块〔拓扑纪律：chat 边不含 llm〕，判定器经
 * deps.isTransientError 注入）。缺省 {enabled, 3, 1000}。
 */
export interface DriverRetryPolicy {
  /** 总开关（关 = 错误直通不重试） */
  readonly enabled: boolean;
  /** 重试帽（transient 错误的最大重试次数） */
  readonly maxRetries: number;
  /** 指数退避基延迟（毫秒）——delay = base·2^(n-1)·(0.5+random·0.5) */
  readonly baseDelayMs: number;
}

/** 驱动缺省重试策略（骨架篇 §3.2 会话层行⑦：enabled/3 次/1s 起） */
const DEFAULT_RETRY_POLICY: DriverRetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 1000 };

/**
 * 指数退避 + 等比半幅抖动（骨架篇 §3.2 会话层行③）：抖动因子 ∈[0.5,1]——
 * 多驱动并发同源错误时错峰打散（因子区间比 pi-ai provider 层 [0.75,1] 更宽，
 * 打散更强；下界 >0 不会零延迟）。导出供单测覆盖区间断言。
 */
export function retryBackoffDelay(attempt: number, baseDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

/**
 * 可取消睡眠：resolve false = 睡满（继续）；true = 被 abort 打断（退避取消路）。
 * 已 abort 的 signal 事件只发一次——先短路再挂监听（S3 同款教训）。
 */
function sleepCancellable(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(true);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    signal.addEventListener('abort', onAbort);
  });
}

/**
 * run 结算载荷（骨架篇 §9.3 ctx.agent.onRunSettled）：sessionId = 结算 run 的
 * 归属会话（S1 增维——订阅是全局单份、run 是多驱动各自的，消费方按 sessionId
 * 路由，goal 直查该会话 goals 表不再依赖装配闭包单值）。
 */
export interface RunSettled {
  readonly status: RunStatus;
  readonly sessionId: string;
}

/** 零用量（error 合成消息用） */
const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

/**
 * 三通道投递选项（骨架篇 §4.1/§6.4 落码面）：发送方只声明意图
 * （backgroundWake = 后台任务完成唤醒），通道由运行时按目标当前状态选定。
 */
export interface DeliverOptions {
  /** true = 后台唤醒（计入自激预算 maxConsecutiveWakes）；用户手写消息缺省 false 并恢复预算 */
  readonly backgroundWake?: boolean;
  /**
   * run 级工具白名单（第二十四批题3a——无人值守收窄投影）：仅当实际开起的 run
   * 批**全部**为 backgroundWake 消息时生效（用户消息混批 = 用户在场，不收窄）；
   * 多消息各自的 filter 取交集（窄者赢）。steer 入队消息不生效（工具面随开跑
   * 时批已定）。守门段照常运行——收窄的是模型感知面，不是执法面。
   */
  readonly toolFilter?: readonly string[];
}

/** 三通道（§4.1）：steer（run 中入队）/ followUp（闲时唤醒开轮）/ inject（只落日志不唤醒） */
export type DeliverChannel = 'steer' | 'followUp' | 'inject';

/** 投递元数据（deliver 携带、驱动按消息引用挂靠——收窄判定输入） */
export interface DeliverMeta {
  readonly backgroundWake: boolean;
  readonly toolFilter?: readonly string[];
}

/**
 * 纯 backgroundWake 批的工具白名单判定（第二十四批题3a，纯函数——驱动消费 +
 * 单测直接覆盖）：批内任一非 backgroundWake 消息（用户在场）→ undefined
 * （不收窄）；全 wake 批取各自 toolFilter 的交集（窄者赢——未携带 filter 的
 * wake 消息不构成否决）；无任何 filter → undefined。空批 → undefined。
 */
export function resolveWakeToolAllowList(metas: readonly (DeliverMeta | undefined)[]): Set<string> | undefined {
  const filters: (readonly string[])[] = [];
  for (const meta of metas) {
    if (meta?.backgroundWake !== true) return undefined;
    if (meta.toolFilter !== undefined) filters.push(meta.toolFilter);
  }
  if (filters.length === 0) return undefined;
  let allow = new Set<string>(filters[0]!);
  for (const filter of filters.slice(1)) allow = new Set<string>(filter.filter((name) => allow.has(name)));
  return allow;
}

/** 会话驱动依赖（chat 件装配产物注入） */
export interface ConversationDriverDeps {
  /** 归属会话 id（S1 多驱动路由键——调用链作用域包裹与 RunSettled 载荷的取值源） */
  readonly sessionId: string;
  /** loop 上下文（messages 活数组——历史投影回读 + 新消息追加同一时间线） */
  readonly context: AgentContext;
  /** loop 配置基座（streamFn/model/convertToLlm；steering 取数口由驱动补齐） */
  readonly loopConfig: Omit<AgentLoopConfig, 'getSteeringMessages' | 'getFollowUpMessages'>;
  /** durable 接线（无持久层装配时缺省） */
  readonly durable?: DurableSinks;
  /**
   * 会话只读写面（S4 前置债批——重试三消费：events 倒扫取遮蔽区间 /
   * deriveMessages 私有重播种种子 / llm/retry 落账+信封遮蔽）。缺省（无持久层
   * 装配）时 auto-retry 随之关闭——遮蔽与落账是重试的构成要件，无日志无重试。
   */
  readonly session?: Session;
  /**
   * 瞬态错误判定（S4——llm/recovery 桶表 transient 判定经装配注入：chat 拓扑
   * 边不含 llm，判定器走 ctx.llm.classifyError 服务面）。缺省 = 恒 false
   * （不判定即不重试——保守直通，测试装配可显式关）。
   */
  readonly isTransientError?: (message: AssistantMessage) => boolean;
  /** 会话层重试策略（缺省 enabled/3 次/1s 起——装配处可覆写） */
  readonly retryPolicy?: DriverRetryPolicy;
  /** 会话首 run 前落 request/header 快照（chat 件闭包——驱动不知道快照内容） */
  readonly writeHeader?: () => void;
  /**
   * 驱动面回调异常诊断（隔离案一第一刀 #4——结构脆弱补强，消 P8'：
   * onRunSettled 订阅方抛错逐条隔离上报，一个坏订阅不毒后续订阅/驱动本体。
   * 当前唯一注册者已自带隔离壳；本防线保护的是未来的裸注册者）。
   * @param err 回调抛出的原始错误
   * @param source 回调来源标签（'onRunSettled'——日志归因用）
   */
  readonly onCallbackError?: (err: unknown, source: string) => void;
}

/**
 * 会话驱动：通道宿主面（ChannelHost）+ run 编排。
 *
 * 持有 loop 的活数组上下文与 steering/followUp 共用队列；emit 扇出到 durable +
 * 展示消费者（TUI）；run 级异常合成 error 收尾（loop 零 try/catch 的对价）。
 */
export class ConversationDriver {
  /** 待注入消息队列（running 期 = steering 逐条；run 间隙 = followUp 全量） */
  private readonly queue = new PendingMessageQueue();
  /** 归属会话 id（S1 多驱动路由键——调用链包裹与 RunSettled 载荷取值源） */
  private readonly sessionId: string;
  private readonly context: AgentContext;
  private readonly config: AgentLoopConfig;
  private readonly durable: DurableSinks | undefined;
  private readonly writeHeader: (() => void) | undefined;
  /** 驱动面回调异常诊断（onRunSettled 逐条隔离的上报口；缺省静默隔离） */
  private readonly onCallbackError: ((err: unknown, source: string) => void) | undefined;
  /** 展示消费者（TUI handle；headless 无）——emit 扇出的非持久化半边 */
  private readonly displays: AgentEventSink[] = [];
  /** run 取消信号（退出序列 / SIGINT 共用；一次性——abort 即终态） */
  private readonly abortController = new AbortController();
  /**
   * 投递元数据（按消息引用挂靠）：队列只存 AgentMessage 契约面，投递选项是
   * 驱动侧关注点——纯 backgroundWake 批的工具收窄判定依据（第二十四批题3a）。
   * 生命周期：deliver 时写入；批消费（开 run / steering 取数 / resetTimeline）时清除。
   */
  private readonly deliverMeta = new Map<AgentMessage, DeliverMeta>();
  /**
   * run 结算订阅表（骨架篇 §9.3 onRunSettled 的驱动侧半边）：
   * ctx.agent 服务挂入总派发器（件内构造）——隔离责任在服务层，驱动只管
   * 在每个 run 终结（running 复位后）同步派发一次。载荷含归属 sessionId
   * （S1——多驱动下订阅方按其路由）。
   */
  private readonly runSettledListeners = new Set<(settled: RunSettled) => void>();
  /** request/header 是否已落（会话首个 run 前一次） */
  private headerWritten = false;
  /** 是否有 run 在跑（submit 的 steering/followUp 分流依据） */
  private running = false;
  /** 会话只读写面（S4 重试三消费；无持久层装配时 undefined——重试随之关闭） */
  private readonly session: Session | undefined;
  /** 瞬态错误判定（S4——装配注入的桶表 transient 位；缺省恒 false 保守直通） */
  private readonly isTransientError: (message: AssistantMessage) => boolean;
  /** 会话层重试策略（S4——缺省 enabled/3 次/1s 起） */
  private readonly retryPolicy: DriverRetryPolicy;
  /** 最近一次 launch 的完成信号（settle 等待用） */
  private runPromise: Promise<void> = Promise.resolve();
  private quitResolve!: () => void;
  /** 退出请求 promise（TUI Ctrl+D/Ctrl+C、run 入口 SIGINT resolve——命令入口 await 它） */
  readonly quit: Promise<void> = new Promise((resolve) => {
    this.quitResolve = resolve;
  });

  constructor(deps: ConversationDriverDeps) {
    this.sessionId = deps.sessionId;
    this.context = deps.context;
    this.durable = deps.durable;
    this.writeHeader = deps.writeHeader;
    this.onCallbackError = deps.onCallbackError;
    this.session = deps.session;
    this.isTransientError = deps.isTransientError ?? (() => false);
    this.retryPolicy = deps.retryPolicy ?? DEFAULT_RETRY_POLICY;
    // steering 取数口驱动自持：仅 running 期供给（run 间隙的余量走 launch 的
    // followUp 循环，不经此口——两路取数同一条队列，分流点在时机不在通道）。
    // 取出即清投递元数据（steering 路不收窄——工具面随开跑时批已定）
    this.config = {
      ...deps.loopConfig,
      getSteeringMessages: async () => (this.running ? this.consumeMeta(this.queue.drain()) : []),
      getFollowUpMessages: async () => [],
    };
  }

  /** 注册展示消费者（emit 扇出追加；TUI 起屏时接 handle） */
  addDisplay(sink: AgentEventSink): void {
    this.displays.push(sink);
  }

  /** emit 扇出：durable 半边 + 全部展示消费者（顺序执行，与事件序列同序） */
  private readonly emit: AgentEventSink = (event) => {
    this.durable?.handle(event);
    for (const display of this.displays) display(event);
  };

  /** 普通消息提交（通道宿主面）：经 deliver 三通道路由（非后台投递——用户手写消息恢复自激预算） */
  submit(text: string): void {
    this.deliver({ role: 'user', content: text, timestamp: Date.now() });
  }

  /** 退出请求（通道宿主面）：abort 当前 run + resolve 退出 promise */
  requestQuit(): void {
    this.abortController.abort();
    this.quitResolve();
  }

  /**
   * 退役（S1 /new 换新驱动）：仅 abort 不 resolve quit promise——此后一切投递
   * 走 inject 通道（只落日志保审计不开 run），迟到结算照常发（fireRunSettled
   * 不受 abort 静默）。与 requestQuit 的差异：退役是「会话停摆」不是「进程退出」
   * ——前台退出聚合（frontQuit）只认 requestQuit，退役驱动的 quit promise
   * 永不 resolve，防 /new 误触发 TUI 退出。
   */
  retire(): void {
    this.abortController.abort();
  }

  /** headless 单次执行：开一个 run 等终值（命令入口用；与 submit 互斥使用） */
  async submitOnce(text: string): Promise<RunResult | undefined> {
    this.wakeCount = 0; // 用户手写输入开跑——自激预算恢复（§6.4）
    return this.launch([{ role: 'user', content: text, timestamp: Date.now() }]);
  }

  /** 等待在跑的 run 结算（退出序列在 abort 后先等它收尾再 flush） */
  async settle(): Promise<void> {
    await this.runPromise;
  }

  /** 是否有 run 在跑（/new 会话热切换的准入判据——run 中不换时间线） */
  get isRunning(): boolean {
    return this.running;
  }

  /** 自激预算帽（§6.4 maxConsecutiveWakes 默认 3——被后台完成连续唤醒的次数封顶） */
  private static readonly MAX_CONSECUTIVE_WAKES = 3;

  /** 连续后台唤醒计数（§6.4）：backgroundWake 唤醒 +1；任何非后台投递清零（用户手写恢复） */
  private wakeCount = 0;

  /** 批消费的元数据清理（steering 取数口共用——只清不读，返回原批） */
  private consumeMeta(batch: readonly AgentMessage[]): AgentMessage[] {
    for (const message of batch) this.deliverMeta.delete(message);
    return [...batch];
  }

  /**
   * run 上下文投影（第二十四批题3a）：收窄批返回工具面过滤后的浅拷贝上下文
   * （messages 活数组引用不变——时间线单一不变式不破；基础上下文的 tools
   * 数组不受影响——后续 run 恢复全量）。元数据消费即清。
   */
  private contextForBatch(batch: readonly AgentMessage[]): AgentContext {
    const metas = batch.map((message) => {
      const meta = this.deliverMeta.get(message);
      this.deliverMeta.delete(message);
      return meta;
    });
    const allow = resolveWakeToolAllowList(metas);
    if (allow === undefined || this.context.tools === undefined) return this.context;
    return { ...this.context, tools: this.context.tools.filter((tool) => allow.has(tool.name)) };
  }

  /**
   * 三通道投递（§4.1 路由表 + §6.4 落码面）：路由按目标当前状态——
   * 拆卸中（abort 已触发）→ inject：只落日志/投影 + 展示，不入队不开 run
   *   （拆卸后队列消息永无人消费，落日志保审计）；
   * running → steer：入 steering 队列（loop 在 turn 边界注入——同批多条只花一个边界）；
   * idle + backgroundWake 超预算 → inject 降级（自激链封顶，只留记录不唤醒）；
   * idle 其余 → followUp：launch 唤醒（非后台投递 = 用户手写消息，预算清零）。
   * @returns 实际选定的通道（发送方可观测路由结果——诊断/测试面）
   */
  deliver(message: AgentMessage, opts?: DeliverOptions): DeliverChannel {
    const backgroundWake = opts?.backgroundWake === true;
    // 收窄投影仅对 backgroundWake 消息有意义（用户消息不携带）
    const toolFilter = backgroundWake ? opts?.toolFilter : undefined;
    if (this.abortController.signal.aborted) return this.inject(message);
    if (this.running) {
      this.deliverMeta.set(message, { backgroundWake, toolFilter });
      this.queue.enqueue(message);
      return 'steer';
    }
    if (backgroundWake && this.wakeCount >= ConversationDriver.MAX_CONSECUTIVE_WAKES) {
      return this.inject(message);
    }
    if (backgroundWake) this.wakeCount += 1;
    else this.wakeCount = 0;
    this.deliverMeta.set(message, { backgroundWake, toolFilter });
    void this.launch([message]);
    return 'followUp';
  }

  /** inject 落账：只追加会话日志/投影 + 展示消费者（不开 run、不入队——§4.1 第三通道） */
  private inject(message: AgentMessage): 'inject' {
    this.emit({ type: 'message_start', message });
    this.emit({ type: 'message_end', message });
    return 'inject';
  }

  /**
   * 时间线原位重置（会话热切换 /new 用）：活数组引用不变、内容替换为新种子
   * （loop 持有的 context.messages 引用持续有效——单一时间线不变式不破），
   * 首 run 标记复位（新会话要重新落 request/header）。
   * @returns run 进行中返回 false（拒绝热切换，时间线原样）——守卫只管**外部**
   *          热切换调用方（/new 类）；run 内重试走 reseedTimelineFromProjection
   *          私有路径（同一写者的时序内动作不受守卫管辖，S4 冷读闸拆分）
   */
  resetTimeline(seed: readonly AgentMessage[] = []): boolean {
    if (this.running) return false;
    this.replaceTimeline(seed);
    this.headerWritten = false;
    // 时间线重置时旧投递元数据随之作废（防跨会话泄漏引用）
    this.deliverMeta.clear();
    return true;
  }

  /**
   * 活数组原位替换（重播种共同原语：外部 resetTimeline 与 run 内重试共用——
   * 只动 timeline 内容，不碰 headerWritten / deliverMeta〔那是热切换语义〕）。
   */
  private replaceTimeline(seed: readonly AgentMessage[]): void {
    const messages = this.context.messages;
    messages.length = 0;
    messages.push(...seed);
  }

  /**
   * 投影重播种（S4 重试路径——compaction 增补 1 教训的「活数组不重播种遮蔽
   * 不生效」半边）：从当前投影（已含遮蔽语义——错误 assistant 及伴生组不进
   * 投影）重建活数组。**不清 deliverMeta**（退避期入队的 backgroundWake 元数据
   * 须保留，续入合批继续收窄工具面）、**不复位 headerWritten**（续入 writeHeader
   * 由差分语义天然幂等）。
   */
  private reseedTimelineFromProjection(): void {
    this.replaceTimeline(projectedToAgentMessages(this.session!.deriveMessages()));
  }

  /**
   * 开 run（防重入：running 时全部转队列——followUp 语义自然兜住并发 submit）。
   * @returns 闲时启动的 run 终值；running 时的提交返回 undefined（结果经事件流）
   */
  private async launch(prompts: AgentMessage[]): Promise<RunResult | undefined> {
    if (this.running || this.abortController.signal.aborted) {
      for (const message of prompts) this.queue.enqueue(message);
      return undefined;
    }
    this.running = true;
    // 调用链会话作用域写点①（骨架篇 §9.3 机制定案）：runTurns 整链包裹本驱动会话
    // ——工具执行/管道 sink/context_transform 桥/事件落账全链自然继承归属语境。
    // background 列（S5）：开起批全部 backgroundWake 即 background（与 toolFilter
    // 收窄同款批语义——元数据缺失〔submit 直入〕视同用户消息）；此处只读不删，
    // 元数据消费删除留给 contextForBatch；run 中途 steering 不翻级，下一 run 定型
    const background =
      prompts.length > 0 && prompts.every((message) => this.deliverMeta.get(message)?.backgroundWake === true);
    const attempt = runInSessionChain({ sessionId: this.sessionId, background }, () => this.runTurns(prompts));
    // 结算通知序（骨架篇 §9.3 onRunSettled）：finally 先注册先执行——running
    // 复位先于订阅者派发，订阅回调内 deliver 见到的必是闲时（followUp 开轮
    // 判定不被 running 卡死）。订阅回调同步执行：goal 续跑等注入即在此点起轮
    const guarded = attempt.finally(() => {
      this.running = false;
    });
    // 调用链会话作用域写点②：结算回调显式重包——attempt.then 的注册点在包裹区外
    // （launch 自身可能运行于任意调用链语境），重包为不依赖包裹形状的确定位；
    // background 闭包继承本 run 批值（订阅者起的后台续跑在下一 run 边界重新定型）
    void attempt.then(
      (result) =>
        runInSessionChain({ sessionId: this.sessionId, background }, () => this.fireRunSettled(result.status)),
      () => runInSessionChain({ sessionId: this.sessionId, background }, () => this.fireRunSettled('failed')),
    );
    this.runPromise = guarded.then(
      () => undefined,
      () => undefined,
    );
    return guarded;
  }

  /**
   * 订阅 run 结算（骨架篇 §9.3 ctx.agent.onRunSettled 的驱动半边）：
   * 每个 run 终结（含异常兜底合成路）派发一次 status + 归属 sessionId。不承诺
   * 恰好一次——订阅方须容忍重复（deliver 路由自适应目标状态，§4.1）。
   */
  onRunSettled(cb: (settled: RunSettled) => void): () => void {
    this.runSettledListeners.add(cb);
    return () => {
      this.runSettledListeners.delete(cb);
    };
  }

  /**
   * 派发 run 结算（快照遍历——派发中注销/新订不炸迭代；逐回调异常隔离：
   * 抛错的订阅上报诊断后继续派发，§1.6 监听器异常隔离纪律在驱动面的执法）。
   */
  private fireRunSettled(status: RunStatus): void {
    const settled: RunSettled = { status, sessionId: this.sessionId };
    for (const cb of [...this.runSettledListeners]) {
      try {
        cb(settled);
      } catch (err) {
        // 坏订阅只蒸发自己这一次通知，不毒后续订阅与驱动本体
        this.onCallbackError?.(err, 'onRunSettled');
      }
    }
  }

  /** run 序列：首 run + followUp 续跑循环（每次 startRun 过 runWithRetry 检查点）；异常兜底合成 error 收尾 */
  private async runTurns(prompts: AgentMessage[]): Promise<RunResult> {
    const hooks = { emit: this.emit, signal: this.abortController.signal };
    let result: RunResult | undefined;
    try {
      // 会话首 run 前落 request/header（组装参数证据腿）。挪进 try 是卡死窗口
      // 修复（独立重读轮 #23 复核）：原在 launch 的 running=true 之后、runTurns
      // 调用之前裸调——writeHeader 抛错时 finally 复位永不执行（attempt 未创建），
      // running 永久卡死 + void launch() 拒绝无人处理；try 内抛错走统一 catch
      if (!this.headerWritten) {
        this.headerWritten = true;
        this.writeHeader?.();
      }
      result = await this.runWithRetry(prompts, hooks);
      // run 自然停：余量排队消息全量捞出续跑（followUp 唤醒——followUp 轮的
      // error 同样过检查点重试，骨架篇 §3.2 前置债①「检查点 = 每次 startRun 返回后」）
      while (!this.abortController.signal.aborted && this.queue.hasItems()) {
        const batch: AgentMessage[] = [];
        while (this.queue.hasItems()) batch.push(...this.queue.drain());
        result = await this.runWithRetry(batch, hooks);
      }
    } catch (error) {
      // 回调违约（loop 零 try/catch 的对价）：合成 error 消息补齐事件序列
      const message: AssistantMessage = {
        role: 'assistant',
        content: [],
        usage: NO_USAGE,
        stopReason: 'error',
        // 错误文案走统一口径（[CODE] 前缀进文本——骨架篇 §3.4 M1 过渡态），
        // 与 loop 工具结果 / stream-fn 流错误三处同款，杜绝 app 兜底吞码（生态读码 pi-2 补钉）
        errorMessage: describeError(error),
        timestamp: Date.now(),
      };
      this.emit({ type: 'message_start', message });
      this.emit({ type: 'message_end', message });
      // turn_end 必发（独立重读轮 #9 修复 b）：与 loop 自身 error 路径（loop 零重试
      // 短路处）同款纪律——catch 若只发 agent_end 不发 turn_end，日志留下敞开 turn，
      // 恢复协议对「孤儿 tool/call + 后续正常 turn」的复合形状判定失据
      this.emit({ type: 'turn_end', message, toolResults: [] });
      this.emit({ type: 'agent_end', status: 'failed', messages: [message] });
      result = {
        status: 'failed',
        messages: [message],
        stopReason: 'error',
        errorMessage: message.errorMessage,
      };
    }
    return result;
  }

  /**
   * 单次 run + 检查点重试（S4 前置债①——骨架篇 §3.2 会话层行落码主体）：
   * startRun 返回后查末轮 result——error 收尾 + 末消息 assistant error + 桶判定
   * transient + attempt < 帽 → 遮蔽续入循环。attempt 生命周期 = 本方法调用
   * （每次 startRun 新计数——成功复位/新 run 新名额，防跨 turn 累积吃名额）。
   *
   * 重试全程 run 未终结：isRunning 全程 true（TUI「工作中」自然覆盖，零新
   * AgentEvent 型）；重试与 followUp 合流——退避醒来 drain 队列，新消息与
   * 续入 startRun 同批带上（空批 = 无人插话的纯续入）。
   */
  private async runWithRetry(
    batch: AgentMessage[],
    hooks: { emit: AgentEventSink; signal: AbortSignal },
  ): Promise<RunResult> {
    let result = await startRun(batch, this.contextForBatch(batch), this.config, hooks);
    let attempt = 0;
    while (this.shouldRetryRun(result)) {
      const errorMessage = this.lastErrorText(result);
      // 达帽放弃：末次错误随行落 exhausted（错误 assistant 保留呈现——中间失败
      // 已被遮蔽，最终失败可见）
      if (attempt >= this.retryPolicy.maxRetries) {
        this.appendRetryFact(attempt, 0, 'exhausted', errorMessage);
        break;
      }
      attempt += 1;
      const delayMs = retryBackoffDelay(attempt, this.retryPolicy.baseDelayMs);
      // 遮蔽 + scheduled 落账一次 append 完成（llm/retry 信封携带 surfaceOp——
      // 会话篇 §2 第二消费者）。倒扫失败（形态异常）= 保守放弃：错误已保留直通
      if (!this.occludeFailedAssistant(attempt, delayMs, errorMessage)) break;
      // 投影重播种（私有路径：只重建活数组——错误 assistant 已不进投影，续入
      // 上下文末消息回到 user/toolResult）
      this.reseedTimelineFromProjection();
      // 退避（挂驱动 abort signal——requestQuit/retire 即取消，零新增机制）
      if (await sleepCancellable(delayMs, this.abortController.signal)) {
        this.appendRetryFact(attempt, delayMs, 'aborted', errorMessage);
        break;
      }
      // followUp 合流：退避期入队消息与续入同批（deliverMeta 保留——backgroundWake
      // 的工具收窄在续入批继续生效）
      const next: AgentMessage[] = [];
      while (this.queue.hasItems()) next.push(...this.queue.drain());
      result = await startRun(next, this.contextForBatch(next), this.config, hooks);
    }
    return result;
  }

  /**
   * 重试判定四条全过才重试（骨架篇 §3.2 会话层行①前半）：策略开 + session
   * 在场（无日志无重试——遮蔽与落账是构成要件）+ error 收尾 + 末消息 assistant
   * error 归 transient 桶（经装配注入的判定器；quota/overflow/non-retryable
   * 均不占重试名额——overflow 动作挂溢出兜底纵切）。
   */
  private shouldRetryRun(result: RunResult): boolean {
    if (!this.retryPolicy.enabled || this.session === undefined) return false;
    if (result.stopReason !== 'error') return false;
    const last = this.lastAssistantError(result);
    return last !== undefined && this.isTransientError(last);
  }

  /** 末消息是否 assistant 错误终态（CustomMessage.role 宽 string 不窄化——stopReason 成员判据窄出 assistant） */
  private lastAssistantError(result: RunResult): AssistantMessage | undefined {
    const last = result.messages[result.messages.length - 1];
    if (last === undefined || last.role !== 'assistant' || !('stopReason' in last)) return undefined;
    return last.stopReason === 'error' ? last : undefined;
  }

  /** 末条错误说明提取（llm/retry 载荷的 errorMessage 腿） */
  private lastErrorText(result: RunResult): string | undefined {
    return this.lastAssistantError(result)?.errorMessage;
  }

  /**
   * 遮蔽错误 assistant + 落 llm/retry scheduled（一次 append，S4——会话篇 §2）：
   * 倒扫日志找最后一条 assistant/message 作区间起点，区间尾取当前日志高水位
   * （盖住流中断终值消息伴生续落的 tool/call——无配对 tool/result 的悬空 toolUse
   * 不进续入上下文；垫底的 turn/end、llm/usage 对投影是 no-op 一并入区间无害）。
   * @returns false = 形态异常保守放弃（无 session 由 shouldRetryRun 先拦，不到这）
   */
  private occludeFailedAssistant(attempt: number, delayMs: number, errorMessage: string | undefined): boolean {
    const session = this.session!;
    const events = session.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (event.type === 'assistant/message') {
        const start = event.seq;
        const end = events.length - 1;
        // 溯源完整性（validateSurfaceOp）：sourceEventSeqs 须全列被遮蔽区间
        const sourceEventSeqs: number[] = [];
        for (let seq = start; seq <= end; seq++) sourceEventSeqs.push(seq);
        const data: LlmRetryData = {
          attempt,
          maxAttempts: this.retryPolicy.maxRetries,
          delayMs,
          phase: 'scheduled',
          ...(errorMessage !== undefined ? { errorMessage } : {}),
        };
        // 信封携带 surfaceOp：log-only 词不进投影 fold（无内容载体、纯删除语义），
        // derive occludedSeqs 按信封字段扫不分类型——落账与遮蔽一次完成
        session.append('llm/retry', data, { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs });
        return true;
      }
      // 垫底事件继续向前扫（伴生 tool/call / turn 边界 / 计量笔账）
      if (event.type === 'tool/call' || event.type === 'turn/end' || event.type === 'llm/usage') continue;
      return false; // 形态异常（user 等内容事件在 assistant 之后）——保守放弃
    }
    return false;
  }

  /** llm/retry aborted/exhausted 落账（无遮蔽随行——scheduled 已遮蔽过） */
  private appendRetryFact(
    attempt: number,
    delayMs: number,
    phase: 'aborted' | 'exhausted',
    errorMessage: string | undefined,
  ): void {
    const data: LlmRetryData = {
      attempt,
      maxAttempts: this.retryPolicy.maxRetries,
      delayMs,
      phase,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
    this.session?.append('llm/retry', data);
  }
}

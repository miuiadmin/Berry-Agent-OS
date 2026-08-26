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
import type { DurableSinks } from './durable.js';

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
  /** 会话首 run 前落 request/header 快照（chat 件闭包——驱动不知道快照内容） */
  readonly writeHeader?: () => void;
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
   * @returns run 进行中返回 false（拒绝热切换，时间线原样）
   */
  resetTimeline(seed: readonly AgentMessage[] = []): boolean {
    if (this.running) return false;
    const messages = this.context.messages;
    messages.length = 0;
    messages.push(...seed);
    this.headerWritten = false;
    // 时间线重置时旧投递元数据随之作废（防跨会话泄漏引用）
    this.deliverMeta.clear();
    return true;
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
    // ——工具执行/管道 sink/context_transform 桥/事件落账全链自然继承归属语境
    const attempt = runInSessionChain(this.sessionId, () => this.runTurns(prompts));
    // 结算通知序（骨架篇 §9.3 onRunSettled）：finally 先注册先执行——running
    // 复位先于订阅者派发，订阅回调内 deliver 见到的必是闲时（followUp 开轮
    // 判定不被 running 卡死）。订阅回调同步执行：goal 续跑等注入即在此点起轮
    const guarded = attempt.finally(() => {
      this.running = false;
    });
    // 调用链会话作用域写点②：结算回调显式重包——attempt.then 的注册点在包裹区外
    // （launch 自身可能运行于任意调用链语境），重包为不依赖包裹形状的确定位
    void attempt.then(
      (result) => runInSessionChain(this.sessionId, () => this.fireRunSettled(result.status)),
      () => runInSessionChain(this.sessionId, () => this.fireRunSettled('failed')),
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

  /** 派发 run 结算（快照遍历——派发中注销/新订不炸迭代；回调异常归服务层隔离壳） */
  private fireRunSettled(status: RunStatus): void {
    const settled: RunSettled = { status, sessionId: this.sessionId };
    for (const cb of [...this.runSettledListeners]) cb(settled);
  }

  /** run 序列：首 run + followUp 续跑循环；异常兜底合成 error 收尾 */
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
      result = await startRun(prompts, this.contextForBatch(prompts), this.config, hooks);
      // run 自然停：余量排队消息全量捞出续跑（followUp 唤醒）
      while (!this.abortController.signal.aborted && this.queue.hasItems()) {
        const batch: AgentMessage[] = [];
        while (this.queue.hasItems()) batch.push(...this.queue.drain());
        result = await startRun(batch, this.contextForBatch(batch), this.config, hooks);
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
}

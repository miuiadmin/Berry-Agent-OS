/**
 * L1 context — 插件运行时本体（内核五件之一；骨架篇 §9 签名的实现）。
 *
 * 结构：ContextRuntime（根运行时：服务注册表 + 事件总线，全体作用域共享）
 *      ContextScope（作用域：effect LIFO 栈 + AbortController + config + logger 前缀）。
 * 组合根 createContext() 建根作用域；插件加载器用 scope.fork() 派生插件作用域——
 * 插件拿到的 ctx 与根共享 get/provide/on/emit，但生命周期独立（卸载即回卷自己的注册）。
 */
import {
  AppError,
  CONTEXT_DISPOSED,
  CONTEXT_EFFECT_INVALID,
  CONTEXT_EFFECT_LIMIT,
  CONTEXT_SERVICE_EXISTS,
  CONTEXT_SERVICE_NOT_FOUND,
  EVENT_DUPLICATE,
  EVENT_MODE_MISMATCH,
  EVENT_UNKNOWN,
  PLUGIN_EVENT_RATE,
} from '../contracts/errors.js';
import { LIVE_EVENT_CATALOG } from '../contracts/events.js';
import type { EventName, LiveEventDefinition } from '../contracts/events.js';
import { registerPluginMessageRole } from '../contracts/messages.js';
import type { MessageRoleDefinition } from '../contracts/messages.js';
import { registerPluginSessionEventType } from '../contracts/session-events.js';
import type { SessionEventTypeDefinition } from '../contracts/session-events.js';
import { createLogger } from './logger.js';
import type { Logger } from './logger.js';
import { RateLimiter } from './rate-limit.js';
import type { Context, ContextOptions, ContextScope, Disposer, EventHandler } from './types.js';

/** 监听器登记项：handler + 注册方作用域名（失败归因——记「谁注册的」而非「谁触发的」）。
 * 第三十一批随守门行传导导出（宿主侧专用：snapshotHandlers/appendHandlers 两出口的载荷型）。 */
export interface HandlerEntry {
  readonly handler: EventHandler;
  readonly owner: string;
}

/** 频率护栏缺省参数：1000 次/分钟 + 1000 突发余量（研究 §2.2 #14 建议值） */
const DEFAULT_RATE_CAPACITY = 1000;
const DEFAULT_RATE_PER_MINUTE = 1000;
/**
 * per-scope 在册 effect 计数帽（契约篇 §1.6 资源护栏族 #9，2026-08-27 刀〇b）：
 * context 注册族（effect/on/provide 注销器/registerMessageRole/
 * registerSessionEventType/fork 级联）全走 pushEffect 单点，一条钟罩全族。
 */
const EFFECT_LIMIT = 10_000;
/** 单条 effect 回卷竞速时钟缺省（毫秒）——挂起 disposer 超此即放弃等待 */
const DEFAULT_DISPOSE_TIMEOUT_MS = 1000;

/** 判定值是否 thenable（异步 disposer 识别——Disposer 契约型 () => void，运行时宽收） */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as PromiseLike<unknown>).then === 'function';
}

/** 作用域 → 根运行时（宿主侧事件词汇登记的内部通道；插件面 ContextScope 无此入口——运行期词汇恒定的结构保证） */
const scopeRuntimes = new WeakMap<ContextScope, ContextRuntime>();

/** 根运行时：跨作用域共享状态（服务注册表 + 事件总线 + 事件词汇注册表）。仅宿主侧可见，不进插件面。 */
class ContextRuntime {
  /** 服务表：name → 实现实例（ctx.provide 写入 / ctx.get 读取） */
  readonly services = new Map<string, unknown>();
  /** 事件总线：事件名 → 登记项列表（注册序即派发序，prepend 插队头部；owner 供失败归因） */
  readonly handlers = new Map<EventName, HandlerEntry[]>();
  /**
   * 事件词汇注册表（契约篇 §1.1 词汇执法的数据源）：目录种子 ∪ 装载期 customs。
   * 运行期恒定不变式：只在 boot//reload 两时点由加载器经 registerLiveEvent 增删
   * （结构上插件面 ContextScope 无此入口，无需封口机制）。
   */
  readonly liveEvents = new Map<string, LiveEventDefinition>();
  /** 根 logger（子作用域 logger 由它派生前缀） */
  readonly rootLogger: Logger;
  /**
   * 根作用域名（B-1 冷读裁决，契约篇 §1.6 刀〇b）：宿主根作用域派发**免计费**——
   * durable→总线的 session/event 镜像与 tools_change 变更广播都在 root 面派发，
   * root 桶实为全部会话全部流量的复用汇（合法子代理舰队即触顶），触顶时
   * PLUGIN_EVENT_RATE 会在宿主写路径内爆炸（persistence sink → session.append）。
   * 插件永不持有 root 作用域（fork 派生新名——带 `:` 不可能等于 rootName）。
   */
  readonly rootName: string;
  /** per-scope 派发频率桶（键 = 派发方作用域名；root 键免扣费） */
  readonly limiter: RateLimiter;
  /** per-scope 派发累计计数（打点面，B2 P5——只增不清零，诊断面读；root 照计） */
  readonly eventStats = new Map<string, number>();
  /** 单条 effect 回卷竞速时钟（毫秒）——dispose 路径用（见 ContextScopeImpl.dispose） */
  readonly disposeTimeoutMs: number;

  constructor(
    rootName: string,
    logger?: Logger,
    rateLimit?: { capacity: number; perMinute: number },
    disposeTimeoutMs?: number,
  ) {
    this.rootName = rootName;
    this.rootLogger = logger ?? createLogger({ module: 'context' });
    this.limiter = new RateLimiter(
      rateLimit ?? { capacity: DEFAULT_RATE_CAPACITY, perMinute: DEFAULT_RATE_PER_MINUTE },
    );
    this.disposeTimeoutMs = disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
    for (const def of LIVE_EVENT_CATALOG) this.liveEvents.set(def.name, def);
  }

  /** 取某事件监听器的快照副本（派发期间注册/退订不影响本轮） */
  snapshot(event: EventName): HandlerEntry[] {
    return [...(this.handlers.get(event) ?? [])];
  }

  /**
   * 派发方计费：扣令牌（桶空抛 PLUGIN_EVENT_RATE）+ 累计打点。
   * 四派发模式（emit/parallel/serial/waterfall）入口统一走此——词汇执法
   * （requireEvent）先行，频率执法在后（拼错名的诊断优先于限流噪音）。
   * B-1 root 豁免（刀〇b）：宿主根作用域派发只计打点不扣桶——镜像/变更广播
   * 等宿主基础设施流量不占插件频率配额（归因对象是插件作用域的派发行为）。
   */
  chargeEvent(scopeName: string, event: EventName): void {
    this.eventStats.set(scopeName, (this.eventStats.get(scopeName) ?? 0) + 1);
    if (scopeName === this.rootName) return; // root 免计费（打点照计——负载数据完整）
    if (!this.limiter.tryCharge(scopeName)) {
      throw new AppError(
        PLUGIN_EVENT_RATE,
        `作用域 ${scopeName} 事件派发超频（事件 ${event}）——护栏 ${this.limiter.params.capacity} 次/分钟` +
          `（令牌桶：突发上限 ${this.limiter.params.capacity}、回填 ${this.limiter.params.perMinute}/min；fail-loud 非静默丢弃，契约篇 §1.6）`,
      );
    }
  }
}

/** context 模块实现类（Context 接口文档见 types.ts，此处只注释实现要点） */
class ContextScopeImpl implements ContextScope {
  private readonly runtime: ContextRuntime;
  private readonly name: string;
  /**
   * effect 栈：注册序入栈，dispose 时逆序回卷（LIFO）。内部宽型——once 包装
   * 可返回异步清理的 promise（CR-2-F8 dispose 语义升级，2026-08-27 刀〇a）：
   * Disposer 契约型仍是 () => void（手动调用面忽略返回值），但 disposer 返回
   * thenable 时 dispose 路径等待其结算。对外（effect 返回值）仍收窄 Disposer。
   */
  private readonly effects: Array<() => void | Promise<void>> = [];
  /** 作用域控制器：dispose 时 abort，对外只暴露 signal */
  private readonly controller = new AbortController();
  private readonly configView: Readonly<Record<string, unknown>>;
  readonly logger: Logger;
  /** 本插件组合树行 id（loader fork 时注入；根/宿主作用域 undefined——契约篇 §1.5 核心行） */
  readonly rowId: string | undefined;
  /** 是否已销毁——销毁后注册类 API 一律拒绝（stale ctx 护栏） */
  private disposed = false;

  constructor(
    runtime: ContextRuntime,
    name: string,
    config: Record<string, unknown> | undefined,
    logger: Logger,
    rowId?: string,
  ) {
    this.runtime = runtime;
    this.name = name;
    // 配置只读快照：浅冻结防插件改写组合树产物（深结构由配置层保证不可变）
    this.configView = Object.freeze({ ...(config ?? {}) });
    this.logger = logger;
    this.rowId = rowId;
  }

  get config(): Readonly<Record<string, unknown>> {
    return this.configView;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** stale ctx 护栏：销毁后的作用域上再注册副作用 = 编程错误，响亮失败 */
  private assertActive(): void {
    if (this.disposed) {
      throw new AppError(CONTEXT_DISPOSED, `作用域 ${this.name} 已销毁，禁止继续注册副作用`);
    }
  }

  effect(fn: () => Disposer): Disposer {
    this.assertActive();
    const disposer = fn(); // 立即执行注册（抛错 = 插件启动失败，直接上抛）
    // Disposer 形状注册期执法（2026-08-25 Hermes 探针 #13）：非函数返回值若放行
    // 入栈，要到作用域回卷期才以裸 TypeError 爆炸（栈指向此处不指调用方插件）。
    // jiti 直载的插件代码无类型护栏——文档化契约（fn 返回值入栈）必须运行时校验
    // 补位；常见病灶 = ctx.effect(() => d())（把已有 disposer 包进新箭头——注册
    // 即注销 + undefined 入栈），错误信息点名该习语。
    if (typeof disposer !== 'function') {
      throw new AppError(
        CONTEXT_EFFECT_INVALID,
        `ctx.effect 回调必须返回函数（Disposer）——实际返回 ${disposer === undefined ? 'undefined' : typeof disposer}。` +
          `若已持有 disposer，正确写法是直接传入：ctx.effect(d) 或把注册放进回调体 ctx.effect(() => register(…))；` +
          `ctx.effect(() => d()) 会在注册时立即执行 d（副作用即撤销）并把 undefined 入栈`,
      );
    }
    return this.pushEffect(disposer);
  }

  /**
   * 入栈一个已就绪的 Disposer 并返回幂等包装（手动调用与 dispose 回卷双保险，只跑一次）。
   *
   * 注册计数帽（契约篇 §1.6 资源护栏族 #9，2026-08-27 刀〇b）：在册 effect 合计
   * 达 10^4 抛 CONTEXT_EFFECT_LIMIT——context 注册族（effect/on/provide 注销器/
   * registerMessageRole/registerSessionEventType/fork 级联）全过此单点，一条钟罩
   * 全族；计数基准 = 活注册（once 内 splice 即减、dispose 回卷即减），非历史累计。
   *
   * 异步 disposer 支持（CR-2-F8，契约篇 §1.6 dispose 语义升级）：disposer 返回
   * thenable 时，once 把它包装为「结算后吞掉异常」的 promise 返回——dispose 循环
   * await 此返回值即等待异步清理完成；手动调用面（返回值被 Disposer 类型收窄为
   * void、调用方忽略）是 fire-and-forget，reject 已在包装内记日志不外泄。
   */
  private pushEffect(disposer: Disposer): Disposer {
    if (this.effects.length >= EFFECT_LIMIT) {
      throw new AppError(
        CONTEXT_EFFECT_LIMIT,
        `作用域 ${this.name} 在册 effect 达上限 ${EFFECT_LIMIT}（context 注册族：effect/on/provide/` +
          `registerMessageRole/registerSessionEventType/fork 级联——计数基准为活注册，注销/回卷即减；契约篇 §1.6 资源护栏族 #9）`,
      );
    }
    let done = false;
    const once = (): void | Promise<void> => {
      if (done) return;
      done = true;
      const index = this.effects.indexOf(once);
      if (index >= 0) this.effects.splice(index, 1);
      try {
        const returned = disposer();
        if (isThenable(returned)) {
          // 异步清理：结算异常记日志隔离（回卷异常隔离对异步同样成立），
          // dispose 路径拿到的是这个已吞异常的 promise——竞速超时与之正交
          return Promise.resolve(returned).then(
            (): void => {},
            (err) => {
              this.logger.error('effect 回卷异步异常', { scope: this.name, error: errorStack(err) });
            },
          );
        }
      } catch (err) {
        // 回卷异常隔离：单个清理失败不阻断其余回卷，但必须留痕
        // （errorStack 而非 String——独立重读轮 #23 复核：e021620 漏的第四处丢栈点）
        this.logger.error('effect 回卷异常', { scope: this.name, error: errorStack(err) });
      }
    };
    this.effects.push(once);
    return once;
  }

  /**
   * 事件词汇执法（契约篇 §1.1 落码）：未注册名 EVENT_UNKNOWN（拼错名从「监听器
   * 永不触发的静默死亡」变响亮失败）；派发方法与目录/声明 mode 不一致
   * EVENT_MODE_MISMATCH（mode 是事件公开契约——插件侧静态 CI 罩不住，运行时执法）。
   * @param dispatch 派发方法名；on() 订阅不区分模式（传 undefined 只查词汇 membership）
   */
  private requireEvent(event: EventName, dispatch: 'emit' | 'waterfall' | 'parallel' | 'serial' | undefined): void {
    const def = this.runtime.liveEvents.get(event);
    if (def === undefined) {
      throw new AppError(
        EVENT_UNKNOWN,
        `事件未注册：${event}——词汇 = 目录（LIVE_EVENT_CATALOG）∪ 插件 named export events 装载期登记；拼错名不再静默 no-op（契约篇 §1.1）`,
      );
    }
    if (dispatch !== undefined && def.mode !== dispatch) {
      throw new AppError(
        EVENT_MODE_MISMATCH,
        `事件「${event}」声明 mode=${def.mode}，不得以 ${dispatch} 派发（mode 是事件公开契约的一部分）`,
      );
    }
  }

  on(event: EventName, handler: EventHandler, opts?: { prepend?: boolean }): Disposer {
    this.assertActive();
    this.requireEvent(event, undefined);
    // 登记项携带注册方作用域名（归因纪律）：插件 A emit、插件 B 的监听器炸，
    // 失败日志必须指向 B（契约篇 §1.6「插件名 + 事件名 + 错误 + 栈」的插件名 = 注册方）
    const entry: HandlerEntry = { handler, owner: this.name };
    const list = this.runtime.handlers.get(event) ?? [];
    if (opts?.prepend) {
      list.unshift(entry);
    } else {
      list.push(entry);
    }
    this.runtime.handlers.set(event, list);
    // on 内部走 effect（契约篇）：退订器入栈，作用域卸载时随 LIFO 自动回卷。
    // 注意退订逻辑必须放在 Disposer 里（dispose 时才执行），不能写进 effect 的 setup 体——
    // setup 体在注册瞬间就会执行，等于注册即退订。
    return this.pushEffect(() => {
      const current = this.runtime.handlers.get(event);
      if (!current) return;
      // 按注册方作用域 + handler 双重定位退订（同一 handler 可能被多作用域注册）
      const index = current.findIndex((item) => item.owner === this.name && item.handler === handler);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.runtime.handlers.delete(event);
    });
  }

  /**
   * 派发辅助：包装单个监听器，异常隔离 + 异步返回值吞掉（emit 语义）。
   * 归因纪律（契约篇 §1.6 + 2026-08-23 独立重读轮 #23 落码）：失败记录**注册方**
   * 作用域名（entry.owner）——记 emit 方 scope 是归因错列，排查会追错插件；
   * 载荷完整携带 event/owner/stack，只记 String(err) 等于吞没（pi 生态实证反例）。
   */
  private fireIsolated(event: EventName, entry: HandlerEntry, args: unknown[]): void {
    try {
      const returned = entry.handler(...args);
      if (returned instanceof Promise) {
        returned.catch((err) => {
          this.logger.error('事件监听器异步失败', { event, owner: entry.owner, error: errorStack(err) });
        });
      }
    } catch (err) {
      this.logger.error('事件监听器同步失败', { event, owner: entry.owner, error: errorStack(err) });
    }
  }

  emit(event: EventName, ...args: unknown[]): void {
    this.requireEvent(event, 'emit');
    this.runtime.chargeEvent(this.name, event); // 频率护栏（§1.6）：桶空 fail-loud
    for (const entry of this.runtime.snapshot(event)) {
      this.fireIsolated(event, entry, args);
    }
  }

  async parallel(event: EventName, ...args: unknown[]): Promise<void> {
    this.requireEvent(event, 'parallel');
    this.runtime.chargeEvent(this.name, event); // 频率护栏（§1.6）：桶空 fail-loud
    // 并发语义：等待全部监听器完成；单个失败隔离（catch 记日志含注册方归因），Promise.all 不因此 reject
    await Promise.all(
      this.runtime.snapshot(event).map((entry) =>
        Promise.resolve()
          .then(() => entry.handler(...args))
          .catch((err) => {
            this.logger.error('parallel 监听器失败', { event, owner: entry.owner, error: errorStack(err) });
          }),
      ),
    );
  }

  async serial(event: EventName, ...args: unknown[]): Promise<void> {
    this.requireEvent(event, 'serial');
    this.runtime.chargeEvent(this.name, event); // 频率护栏（§1.6）：桶空 fail-loud
    for (const entry of this.runtime.snapshot(event)) {
      try {
        await entry.handler(...args);
      } catch (err) {
        // 异常隔离：单个失败记日志（含注册方归因）、继续下一个（保持串行派发不中断）
        this.logger.error('serial 监听器失败', { event, owner: entry.owner, error: errorStack(err) });
      }
    }
  }

  async waterfall<T>(event: EventName, ...argsWithNext: unknown[]): Promise<T> {
    this.requireEvent(event, 'waterfall');
    this.runtime.chargeEvent(this.name, event); // 频率护栏（§1.6）：桶空 fail-loud
    // 末位参数是链尾 next（骨架篇 §9.1 签名：waterfall(event, ...args, next)）
    const next = argsWithNext.pop() as (...finalArgs: unknown[]) => T | Promise<T>;
    const initialArgs = argsWithNext;
    const entries = this.runtime.snapshot(event);

    // koa-compose 式委托：dispatch(i, args) = 以当前 args 执行第 i 个监听器，其 next
    // 参数 = dispatch(i+1, …)；监听器不调 next 即短路（返回其返回值）；调
    // next(...newArgs) 即替换下游链的参数（变换传播——context_transform 依赖），
    // 无参 next() 沿用当前参数；链尾以最终参数调 next(...finalArgs)。
    // waterfall 无异常隔离（契约：抛错按事件契约语义短路——守门 fail-closed 等）
    const dispatch = (index: number, args: unknown[]): Promise<T> => {
      if (index >= entries.length) return Promise.resolve(next(...args));
      const entry = entries[index]!;
      return Promise.resolve(
        entry.handler(...args, (...nextArgs: unknown[]) => dispatch(index + 1, nextArgs.length > 0 ? nextArgs : args)),
      );
    };
    return dispatch(0, initialArgs);
  }

  get<T = unknown>(name: string): T {
    if (!this.runtime.services.has(name)) {
      throw new AppError(CONTEXT_SERVICE_NOT_FOUND, `服务未注册：${name}`);
    }
    return this.runtime.services.get(name) as T;
  }

  /** 软依赖探测（骨架篇 §9.1）：未注册返回 undefined 不抛错；语义与纪律见 types.ts 注释 */
  tryGet<T = unknown>(name: string): T | undefined {
    return this.runtime.services.has(name) ? (this.runtime.services.get(name) as T) : undefined;
  }

  provide<T>(name: string, impl: T): Disposer {
    this.assertActive();
    if (this.runtime.services.has(name)) {
      // 同名重复注册 = 组合树装配错误（两行 provide 同一服务），响亮失败而非后写覆盖
      throw new AppError(CONTEXT_SERVICE_EXISTS, `服务重复注册：${name}`);
    }
    this.runtime.services.set(name, impl);
    // 注销器：仅当仍是本实现时删除（防误撤他者后来的同位注册）
    const unregister: Disposer = () => {
      if (this.runtime.services.get(name) === impl) this.runtime.services.delete(name);
    };
    // 挂 effect 栈：作用域卸载时随 LIFO 回卷；返回值供插件手动提前撤销
    return this.pushEffect(unregister);
  }

  /**
   * 注册自定义消息角色（骨架篇 §2.3 插件面）：桥接 contracts 注册表（域名
   * 前缀校验/撞名拒绝在彼处），注销器挂本作用域 effect 栈——/reload 卸载即
   * 角色随插件回卷，重装重注册（dispose-unregister 与消息角色渲染面同款安全）。
   */
  registerMessageRole(name: string, definition: MessageRoleDefinition): Disposer {
    this.assertActive();
    return this.pushEffect(registerPluginMessageRole(name, definition));
  }

  /**
   * 注册插件自有会话事件词汇（会话篇 §2.1 插件面，#19 收口）：桥接 contracts
   * 注册表（核心词拒绝/格式校验在彼处），注销器挂本作用域 effect 栈——/reload
   * 卸载即词汇随插件回卷、重装重注册（与 registerMessageRole 同款安全：
   * jiti moduleCache:false 下裸模块级注册会撞重复注册，插件面必须作用域化）。
   */
  registerSessionEventType(def: SessionEventTypeDefinition): Disposer {
    this.assertActive();
    return this.pushEffect(registerPluginSessionEventType(def));
  }

  fork(opts: { name: string; config?: Record<string, unknown>; rowId?: string }): ContextScope {
    const child = new ContextScopeImpl(
      this.runtime,
      `${this.name}:${opts.name}`,
      opts.config,
      this.runtime.rootLogger.child(`${this.name}:${opts.name}`),
      // 行 id 缺省继承父作用域（显式注入优先）——插件内任意深度 fork 保持行归属
      opts.rowId ?? this.rowId,
    );
    // 登记内部通道（registerLiveEvent 经 WeakMap 找根运行时——fork 产物同样可作锚）
    scopeRuntimes.set(child, this.runtime);
    // 子作用域销毁接线进父 effect 栈（2026-08-23 独立重读轮 #23 落码）：父/根
    // dispose 时 LIFO 级联回卷全部子作用域——宿主忘显式 dispose 也兜底；dispose
    // 幂等（disposed 标记），显式销毁后父侧再调是空操作，双保险无害。
    // disposer 直接返回 child.dispose() 的 promise（不 void 丢弃——CR-2-F8）：
    // 父 dispose 循环经 once 拿到它并逐条等待，子树整树回卷被父侧等待（每条
    // 各自竞速 disposeTimeoutMs——深层级联的最坏总时长 = 深度 × 时钟，正常
    // 清理毫秒级返回不触发钟）
    this.effect(() => () => child.dispose());
    return child;
  }

  /**
   * 销毁本作用域：LIFO 回卷全部 effect → abort signal。根作用域销毁 = 停机序列的一环。
   *
   * dispose 语义升级（CR-2-F8，契约篇 §1.6 时钟族前提，2026-08-27 刀〇a）：
   * 逐条 **await** disposer（此前同步循环只触发不等待——异步清理被跳过，回卷
   * 时钟无从谈起）；单条与竞速时钟 race（缺省 1s），挂起的 disposer 超时记
   * warn 放弃等待继续下一条——一条挂起不阻塞整树回卷（挂起 disposer 的迟到
   * 结算已由 once 包装吞异常，无 unhandledRejection 面）。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // LIFO 回卷：逆序弹出并执行；单个失败已由 once 包装隔离记录
    while (this.effects.length > 0) {
      const once = this.effects.pop()!;
      const returned = once();
      if (returned === undefined) continue; // 同步 disposer：无等待面
      // 异步 disposer：与回卷时钟竞速（timedOut 标记区分胜者——超时即弃等下一条）
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clock = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, this.runtime.disposeTimeoutMs);
      });
      try {
        await Promise.race([returned, clock]);
        if (timedOut) {
          this.logger.warn('effect 回卷竞速超时（挂起 disposer，放弃等待继续下一条）', {
            scope: this.name,
            timeoutMs: this.runtime.disposeTimeoutMs,
          });
        }
      } finally {
        clearTimeout(timer);
      }
    }
    // 全部回卷后再 abort——监听器/副作用清理完成，长任务此刻感知取消
    this.controller.abort();
  }
}

/**
 * 创建根作用域（组合根入口；app 模块调用一次）。
 * 插件作用域一律由根/父作用域 fork 派生，不直接调用本函数。
 */
export function createContext(opts: ContextOptions = {}): ContextScope {
  const name = opts.name ?? 'root';
  const runtime = new ContextRuntime(name, opts.logger, opts.rateLimit, opts.disposeTimeoutMs);
  const scope = new ContextScopeImpl(runtime, name, opts.config, runtime.rootLogger.child(name));
  scopeRuntimes.set(scope, runtime);
  return scope;
}

/**
 * 读事件派发打点（B2 P5 打点先行，2026-08-27 刀〇a）：per-scope 累计派发计数
 * （键 = 作用域名，含宿主根作用域）。诊断面（dump-config / /plugins）展示用——
 * 每插件「发了多少事件」的负载数据，为护栏族阈值调校供数；只读快照，不参与控制流。
 */
export function eventDispatchStats(scope: ContextScope): ReadonlyMap<string, number> {
  const runtime = scopeRuntimes.get(scope);
  return runtime === undefined ? new Map() : runtime.eventStats;
}

/**
 * 宿主侧监听器枚举出口（2026-08-27 第三十一批守门行传导——骨架篇 §6.1「守门行传导 +
 * context 腿」条）：取某作用域树在某事件上的监听器登记项快照（含 owner 归因）。
 *
 * **宿主专用**：插件面结构不可达（依赖图白名单三道——插件 import 不到 context 模块，
 * 虚拟面六键不含本函数），「context 无监听器枚举 API」缺口在宿主侧收口。返回数组是
 * 副本（与派发期 snapshot 同款——调用方迭代期间注册/退订不影响本次结果）。
 *
 * @param scope 作用域（根 ctx 或其 fork 产物——fork 共享同一 runtime，取到的是整树行集）
 * @param event 事件名
 */
export function snapshotHandlers(scope: ContextScope, event: EventName): HandlerEntry[] {
  const runtime = scopeRuntimes.get(scope);
  return runtime === undefined ? [] : runtime.snapshot(event);
}

/**
 * 宿主侧监听器写入出口（守门行传导的落链半边）：把带原 owner 的登记项**直写**目标
 * 作用域的 handlers Map——不走 `on()`（on() 会把 owner 记成目标作用域名，原插件名
 * 归因丢失；且会挂 effect 栈使子回卷误撤根行——传导是引用非归属）。
 *
 * 生命周期：目标作用域通常是 fresh 子 ctx（自身 runtime 的 root）——其 dispose 后
 * runtime 整体无引用随 GC，传导行不需 effect 注销器（子的 dispose 不回卷根行是拍板
 * 语义；已出膛的子持旧 handler 引用照跑到收工）。
 *
 * @param scope 目标作用域（fresh 子 ctx）
 * @param event 事件名（waterfall 三段词汇——目录既有词，无词汇面变化）
 * @param entries 登记项集（snapshotHandlers 产物经调用方过滤）
 */
export function appendHandlers(scope: ContextScope, event: EventName, entries: readonly HandlerEntry[]): void {
  const runtime = scopeRuntimes.get(scope);
  if (runtime === undefined) {
    throw new AppError(CONTEXT_DISPOSED, 'appendHandlers：未知作用域（须为 createContext/fork 产物）');
  }
  const existing = runtime.handlers.get(event);
  if (existing === undefined) {
    runtime.handlers.set(event, [...entries]);
  } else {
    existing.push(...entries);
  }
}

/**
 * 登记一个自定义活体事件（契约篇 §1.1 逃生口——**宿主加载器专用**，插件面无此入口）。
 *
 * 词汇集运行期恒定不变式：本函数只应在加载器装载阶段（boot 与 /reload 两时点）被调，
 * 登记经 scope.effect 挂作用域栈（/reload 卸载锚作用域即 LIFO 注销词汇）。
 * def 的形状/格式校验（name/mode/note、小写含 `/`）归加载器（PLUGIN_SHAPE_INVALID）；
 * 此处只做撞名检查（EVENT_DUPLICATE——词汇表拒绝静默覆盖）。
 * @returns 注销器（从词汇表移除本 def——幂等，仅当仍是本 def 时移除）
 */
export function registerLiveEvent(scope: ContextScope, def: LiveEventDefinition): Disposer {
  const runtime = scopeRuntimes.get(scope);
  if (!runtime) {
    // 结构上不可达（createContext 必登记）；防御外部仿造作用域
    throw new AppError(CONTEXT_DISPOSED, 'registerLiveEvent：未知作用域（须为 createContext/fork 产物）');
  }
  if (runtime.liveEvents.has(def.name)) {
    throw new AppError(
      EVENT_DUPLICATE,
      `事件重复注册：${def.name}（词汇表已有同名项——目录或他插件已占用，拒绝静默覆盖）`,
    );
  }
  runtime.liveEvents.set(def.name, def);
  return () => {
    if (runtime.liveEvents.get(def.name) === def) runtime.liveEvents.delete(def.name);
  };
}

/** 异常 → 日志载荷（优先完整 stack；非 Error 值字符串化——与 describeError 文案口径互补） */
function errorStack(err: unknown): string {
  return err instanceof Error ? (err.stack ?? String(err)) : String(err);
}

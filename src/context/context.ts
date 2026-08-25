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
  CONTEXT_SERVICE_EXISTS,
  CONTEXT_SERVICE_NOT_FOUND,
  EVENT_DUPLICATE,
  EVENT_MODE_MISMATCH,
  EVENT_UNKNOWN,
} from '../contracts/errors.js';
import { LIVE_EVENT_CATALOG } from '../contracts/events.js';
import type { EventName, LiveEventDefinition } from '../contracts/events.js';
import { registerPluginMessageRole } from '../contracts/messages.js';
import type { MessageRoleDefinition } from '../contracts/messages.js';
import { registerPluginSessionEventType } from '../contracts/session-events.js';
import type { SessionEventTypeDefinition } from '../contracts/session-events.js';
import { createLogger } from './logger.js';
import type { Logger } from './logger.js';
import type { Context, ContextOptions, ContextScope, Disposer, EventHandler } from './types.js';

/** 监听器登记项：handler + 注册方作用域名（失败归因——记「谁注册的」而非「谁触发的」） */
interface HandlerEntry {
  readonly handler: EventHandler;
  readonly owner: string;
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

  constructor(logger?: Logger) {
    this.rootLogger = logger ?? createLogger({ module: 'context' });
    for (const def of LIVE_EVENT_CATALOG) this.liveEvents.set(def.name, def);
  }

  /** 取某事件监听器的快照副本（派发期间注册/退订不影响本轮） */
  snapshot(event: EventName): HandlerEntry[] {
    return [...(this.handlers.get(event) ?? [])];
  }
}

/** context 模块实现类（Context 接口文档见 types.ts，此处只注释实现要点） */
class ContextScopeImpl implements ContextScope {
  private readonly runtime: ContextRuntime;
  private readonly name: string;
  /** effect 栈：注册序入栈，dispose 时逆序回卷（LIFO） */
  private readonly effects: Disposer[] = [];
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

  /** 入栈一个已就绪的 Disposer 并返回幂等包装（手动调用与 dispose 回卷双保险，只跑一次） */
  private pushEffect(disposer: Disposer): Disposer {
    let done = false;
    const once: Disposer = () => {
      if (done) return;
      done = true;
      const index = this.effects.indexOf(once);
      if (index >= 0) this.effects.splice(index, 1);
      try {
        disposer();
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
    for (const entry of this.runtime.snapshot(event)) {
      this.fireIsolated(event, entry, args);
    }
  }

  async parallel(event: EventName, ...args: unknown[]): Promise<void> {
    this.requireEvent(event, 'parallel');
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
    // 幂等（disposed 标记），显式销毁后父侧再调是空操作，双保险无害
    this.effect(() => () => void child.dispose());
    return child;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // LIFO 回卷：逆序弹出并执行；单个失败已由 once 包装隔离记录
    while (this.effects.length > 0) {
      this.effects.pop()!();
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
  const runtime = new ContextRuntime(opts.logger);
  const name = opts.name ?? 'root';
  const scope = new ContextScopeImpl(runtime, name, opts.config, runtime.rootLogger.child(name));
  scopeRuntimes.set(scope, runtime);
  return scope;
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

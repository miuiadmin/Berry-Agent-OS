/**
 * L1 context — 插件运行时本体（内核五件之一；骨架篇 §9 签名的实现）。
 *
 * 结构：ContextRuntime（根运行时：服务注册表 + 事件总线，全体作用域共享）
 *      ContextScope（作用域：effect LIFO 栈 + AbortController + config + logger 前缀）。
 * 组合根 createContext() 建根作用域；插件加载器用 scope.fork() 派生插件作用域——
 * 插件拿到的 ctx 与根共享 get/provide/on/emit，但生命周期独立（卸载即回卷自己的注册）。
 */
import { AppError, CONTEXT_DISPOSED, CONTEXT_SERVICE_EXISTS, CONTEXT_SERVICE_NOT_FOUND } from '../contracts/errors.js';
import type { EventName } from '../contracts/events.js';
import { createLogger } from './logger.js';
import type { Logger } from './logger.js';
import type { Context, ContextOptions, ContextScope, Disposer, EventHandler } from './types.js';

/** 根运行时：跨作用域共享状态（服务注册表 + 事件总线）。仅宿主侧可见，不进插件面。 */
class ContextRuntime {
  /** 服务表：name → 实现实例（ctx.provide 写入 / ctx.get 读取） */
  readonly services = new Map<string, unknown>();
  /** 事件总线：事件名 → 监听器列表（注册序即派发序，prepend 插队头部） */
  readonly handlers = new Map<EventName, EventHandler[]>();
  /** 根 logger（子作用域 logger 由它派生前缀） */
  readonly rootLogger: Logger;

  constructor(logger?: Logger) {
    this.rootLogger = logger ?? createLogger({ module: 'context' });
  }

  /** 取某事件监听器的快照副本（派发期间注册/退订不影响本轮） */
  snapshot(event: EventName): EventHandler[] {
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
  /** 是否已销毁——销毁后注册类 API 一律拒绝（stale ctx 护栏） */
  private disposed = false;

  constructor(runtime: ContextRuntime, name: string, config: Record<string, unknown> | undefined, logger: Logger) {
    this.runtime = runtime;
    this.name = name;
    // 配置只读快照：浅冻结防插件改写组合树产物（深结构由配置层保证不可变）
    this.configView = Object.freeze({ ...(config ?? {}) });
    this.logger = logger;
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

  on(event: EventName, handler: EventHandler, opts?: { prepend?: boolean }): Disposer {
    this.assertActive();
    const list = this.runtime.handlers.get(event) ?? [];
    if (opts?.prepend) {
      list.unshift(handler);
    } else {
      list.push(handler);
    }
    this.runtime.handlers.set(event, list);
    // on 内部走 effect（契约篇）：退订器入栈，作用域卸载时随 LIFO 自动回卷。
    // 注意退订逻辑必须放在 Disposer 里（dispose 时才执行），不能写进 effect 的 setup 体——
    // setup 体在注册瞬间就会执行，等于注册即退订。
    return this.pushEffect(() => {
      const current = this.runtime.handlers.get(event);
      if (!current) return;
      const index = current.indexOf(handler);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.runtime.handlers.delete(event);
    });
  }

  /**
   * 派发辅助：包装单个监听器，异常隔离 + 异步返回值吞掉（emit 语义）。
   * 日志纪律（2026-08-23 生态读码补钉 dsh-11）：失败必须带 {event, scope} 与完整
   * stack——只记 String(err) 等于吞没（pi 生态监听器静默死亡排查无门的实证反例）。
   */
  private fireIsolated(event: EventName, handler: EventHandler, args: unknown[]): void {
    try {
      const returned = handler(...args);
      if (returned instanceof Promise) {
        returned.catch((err) => {
          this.logger.error('事件监听器异步失败', { event, scope: this.name, error: errorStack(err) });
        });
      }
    } catch (err) {
      this.logger.error('事件监听器同步失败', { event, scope: this.name, error: errorStack(err) });
    }
  }

  emit(event: EventName, ...args: unknown[]): void {
    for (const handler of this.runtime.snapshot(event)) {
      this.fireIsolated(event, handler, args);
    }
  }

  async parallel(event: EventName, ...args: unknown[]): Promise<void> {
    // 并发语义：等待全部监听器完成；单个失败隔离（catch 记日志），Promise.all 不因此 reject
    await Promise.all(
      this.runtime.snapshot(event).map((handler) =>
        Promise.resolve()
          .then(() => handler(...args))
          .catch((err) => {
            this.logger.error('parallel 监听器失败', { event, scope: this.name, error: errorStack(err) });
          }),
      ),
    );
  }

  async serial(event: EventName, ...args: unknown[]): Promise<void> {
    for (const handler of this.runtime.snapshot(event)) {
      try {
        await handler(...args);
      } catch (err) {
        // 异常隔离：单个失败记日志、继续下一个（保持串行派发不中断）
        this.logger.error('serial 监听器失败', { event, scope: this.name, error: errorStack(err) });
      }
    }
  }

  async waterfall<T>(event: EventName, ...argsWithNext: unknown[]): Promise<T> {
    // 末位参数是链尾 next（骨架篇 §9.1 签名：waterfall(event, ...args, next)）
    const next = argsWithNext.pop() as () => T | Promise<T>;
    const args = argsWithNext;
    const handlers = this.runtime.snapshot(event);

    // koa-compose 式委托：dispatch(i) = 执行第 i 个监听器，其 next 参数 = dispatch(i+1)；
    // 监听器不调 next 即短路（返回其返回值）；全部执行完则落到链尾 next()。
    const dispatch = (index: number): Promise<T> => {
      if (index >= handlers.length) return Promise.resolve(next());
      const handler = handlers[index]!;
      return Promise.resolve(handler(...args, () => dispatch(index + 1)));
    };
    return dispatch(0);
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

  fork(opts: { name: string; config?: Record<string, unknown> }): ContextScope {
    return new ContextScopeImpl(
      this.runtime,
      `${this.name}:${opts.name}`,
      opts.config,
      this.runtime.rootLogger.child(`${this.name}:${opts.name}`),
    );
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
  return new ContextScopeImpl(runtime, name, opts.config, runtime.rootLogger.child(name));
}

/** 异常 → 日志载荷（优先完整 stack；非 Error 值字符串化——与 describeError 文案口径互补） */
function errorStack(err: unknown): string {
  return err instanceof Error ? (err.stack ?? String(err)) : String(err);
}

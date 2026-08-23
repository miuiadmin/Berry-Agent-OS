/**
 * L1 context — ctx 类型面（运行时骨架篇 §9.1 核心层签名，逐字段照规范实现）。
 *
 * 插件契约唯一形状 `(ctx, config) => void` 里的 ctx 即本类型；服务层 / 动作层
 * （ctx.tools / ctx.sessions / …）由对应模块落地时挂到本接口的扩展视图上。
 */
import type { EventName } from '../contracts/events.js';
import type { Logger } from './logger.js';

/** 清理函数：effect / on / provide 的返回值，调用即回卷该注册 */
export type Disposer = () => void;

/** 事件处理器：参数由事件发布方约定；返回值仅 waterfall 采用 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 处理器参数形态由各事件定义方收口，M1 先宽收
export type EventHandler = (...args: any[]) => any;

/** ctx.on 选项 */
export interface OnOptions {
  /** 插队到监听器列表最前（高优先级拦截器；waterfall 链上先于普通监听器执行） */
  prepend?: boolean;
}

/**
 * 插件运行时核心 API（骨架篇 §9.1）。
 * 实现纪律：on/provide 挂到作用域 effect 栈随卸载自动回卷；dispose 后调用任何
 * 注册类 API 抛 AppError CONTEXT_DISPOSED（stale ctx 护栏）。
 */
export interface Context {
  /** 注册可逆副作用：立即执行 fn，其返回的 Disposer 入栈；插件卸载按注册逆序（LIFO）自动回卷 */
  effect(fn: () => Disposer): Disposer;
  /** 订阅事件；返回退订 Disposer（内部走 effect，随作用域卸载自动退订） */
  on(event: EventName, handler: EventHandler, opts?: OnOptions): Disposer;
  /** 广播事件：全部监听器触发（异步任务不等待）；单个失败隔离——记 error 日志，不中断其余 */
  emit(event: EventName, ...args: unknown[]): void;
  /** 并发触发全部监听器并等待完成；异常隔离同 emit（任何一个失败不影响其余） */
  parallel(event: EventName, ...args: unknown[]): Promise<void>;
  /** 按注册序串行触发全部监听器；异常隔离（失败记日志、继续下一个） */
  serial(event: EventName, ...args: unknown[]): Promise<void>;
  /**
   * 瀑布链：末位参数 next 是链尾委托；每个监听器收到 (...args, next)，
   * 必须调用 next() 才继续下游——不调即短路，其返回值为最终值（工具管道三段依赖此语义）。
   */
  waterfall<T>(event: EventName, ...argsWithNext: unknown[]): Promise<T>;
  /** 取服务实现；未注册抛 AppError CONTEXT_SERVICE_NOT_FOUND */
  get<T = unknown>(name: string): T;
  /**
   * 软依赖探测取服务（2026-08-23 生态读码补钉 dsh-4）：未注册返回 undefined、不抛错。
   * 与 get 的分工：必需依赖用 get（缺了 = 装配错误，响亮失败）；可选依赖用 tryGet。
   * 配套纪律（骨架篇 §9.1）：禁轮询重试、禁鸭子探测、禁监听内部注册事件——缺就是
   * 明确的 undefined，软依赖插件按「无此服务即降级」一次分支处理。
   */
  tryGet<T = unknown>(name: string): T | undefined;
  /** 注册服务（写入共享注册表）；返回注销 Disposer，且挂到当前作用域 effect 栈随卸载回卷 */
  provide<T>(name: string, impl: T): Disposer;
  /** 本作用域配置视图（只读快照；组合树解析产物） */
  readonly config: Readonly<Record<string, unknown>>;
  /** 带作用域前缀的子 logger */
  readonly logger: Logger;
  /** 生命周期信号：作用域销毁时 abort——长任务/定时器的取消依据 */
  readonly signal: AbortSignal;
}

/**
 * 作用域 ctx（宿主侧持有；插件面只见 Context）。
 * 组合根 createContext 建根作用域；插件加载器 fork 出插件作用域（共享注册表与事件总线）。
 */
export interface ContextScope extends Context {
  /** 派生子作用域：共享服务注册表与事件总线，独立 effect 栈 / signal / config / logger 前缀 */
  fork(opts: { name: string; config?: Record<string, unknown> }): ContextScope;
  /** 销毁本作用域：LIFO 回卷全部 effect → abort signal。根作用域销毁 = 停机序列的一环 */
  dispose(): Promise<void>;
}

/** createContext 选项 */
export interface ContextOptions {
  /** 作用域名（根默认 'root'；插件作用域 = 插件 id） */
  name?: string;
  /** 配置视图（只读冻结后暴露到 ctx.config） */
  config?: Record<string, unknown>;
  /** 注入 logger（缺省自建，级别走 APP_LOG_LEVEL / dev=debug） */
  logger?: Logger;
}

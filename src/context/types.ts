/**
 * L1 context — ctx 类型面（运行时骨架篇 §9.1 核心层签名，逐字段照规范实现）。
 *
 * 插件契约唯一形状 `(ctx, config) => void` 里的 ctx 即本类型；服务层 / 动作层
 * （ctx.tools / ctx.sessions / …）由对应模块落地时挂到本接口的扩展视图上。
 */
import type { EventName } from '../contracts/events.js';
import type { MessageRoleDefinition } from '../contracts/messages.js';
import type { SessionEventTypeDefinition } from '../contracts/session-events.js';
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
  /**
   * 注册自定义消息角色（骨架篇 §2.3 插件面——ctx 承诺面的兑现，2026-08-25）：
   * 角色名必含 `/` 域前缀（memory/recall 式）；挂作用域 effect 栈随卸载回卷
   * （与 on/provide 同纪律）。宿主自留角色（无 / 单段名）走 contracts 的
   * registerHostMessageRole 直调，不经本面。
   */
  registerMessageRole(name: string, definition: MessageRoleDefinition): Disposer;
  /**
   * 注册插件自有会话事件词汇（会话篇 §2.1 插件面——ctx.sessions.appendEvent
   * 的钥匙，2026-08-25 Hermes 探针 #19 收口）：核心词拒注册
   * SESSION_CORE_TYPE_FORBIDDEN；挂作用域 effect 栈随卸载回卷（与
   * registerMessageRole 同纪律）。宿主面 registerSessionEventType 模块级
   * 直调（官方件随包代码，组合无关），不经本面。
   */
  registerSessionEventType(def: SessionEventTypeDefinition): Disposer;
  /** 本作用域配置视图（只读快照；组合树解析产物） */
  readonly config: Readonly<Record<string, unknown>>;
  /**
   * 本插件组合树行 id（2026-08-26 挖矿批 P0-1，契约篇 §1.5 核心行）：件数据目录
   * 键的正规获取口（ctx.paths.pluginDataDir(ctx.rowId)）——loader 手持注入，插件
   * 禁从插件名/目录名自推（行 id 可改名，双键一桥见契约篇 §1.5 表尾）。根/宿主
   * 作用域 undefined；插件作用域内再 fork 的子作用域继承父行 id（行身份随深度
   * 保持——任意嵌套的插件代码都能拿到自己的行归属）。
   */
  readonly rowId: string | undefined;
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
  /**
   * 派生子作用域：共享服务注册表与事件总线，独立 effect 栈 / signal / config /
   * logger 前缀。rowId 缺省继承父作用域（行身份随 fork 深度保持）；装载器为
   * 插件行 fork 时显式传入行 id。
   */
  fork(opts: { name: string; config?: Record<string, unknown>; rowId?: string }): ContextScope;
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

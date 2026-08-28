/**
 * 调用链会话作用域 + 调用方身份链（多应用并行 S1，骨架篇 §9.3「调用链当前会话」机制定案）。
 *
 * 为什么在 context：作用域是本模块的家族职责（LIFO 作用域/fork/stale 护栏之外，异步链
 * 语境传播是作用域问题的第三形态）；载体 = node:async_hooks 的 AsyncLocalStorage——
 * Node 内建零新依赖。
 *
 * 会话链写点（唯一三类）：
 * 1. 驱动 launch 边界包裹本驱动 sessionId + background 列（runTurns 链上的一切——
 *    工具执行/管道/context_transform 桥/事件落账——都自然继承）；
 * 2. run 结算回调显式重包（包裹位置若只罩 runTurns 链，attempt.then 的结算回调注册
 *    在包裹区外——重包为不依赖包裹形状的确定位）；
 * 3. 子代理工厂 startRun 包裹子会话（S5 冷读闸 F3：无此包裹则子内工具执行继承
 *    委派工具所在父 run 的链——子内 goal 落账/审批归属全数错挂父账）。
 *
 * background 列（S5，骨架篇 §9.3）：本 run 开起批全部为 backgroundWake 即 true
 * （与 toolFilter 收窄同款批语义——用户消息混批即 interactive；run 中途 steering
 * 不翻级，下一 run 定型）。读点 = 审批 ask priority（两级出队取数）。
 *
 * 会话链读点 = 全局绑定面（装配期单份绑定、无 per-driver 闭包可用的面）：转发壳 gate/approval
 * sink、ctx.llm onUsage 计量、ctx.sessions 缺省路由、子代理子工厂 fork 源。驱动自身事件
 * 不走环境（chat 件工厂化后每驱动直接持自己的 durable sinks）。
 *
 * caller 链（会话篇 §5.1 导入者归因，2026-08-27 P1-1）：共享服务面（ctx.sessions 等）
 * 看不见调用方——应用身份不能靠入参自报（冻结签名 + 自报可伪造）。第二 ALS 在**应用
 * 身份天然已知的边界**进入链：装载器 apply 边界（应用激活期的一切注册/启动落该应用账）
 * 与工具执行段（管道链尾按注册归属包裹——工具体内的一切服务调用落注册者账）。读点 =
 * createSession importer 归因（chainCaller() ?? 'host'）。宿主自身/无链 = 'host' 兜底。
 *
 * loop/管道零会话知识不破：环境只在驱动边界注入，agent 模块不 import 本文件。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 调用链语境载荷——两键：
 * - sessionId：本异步链归属的会话（S1 起）；
 * - background：开起批是否全部 backgroundWake（S5 起——审批 priority 取数源）。
 */
interface SessionChainScope {
  readonly sessionId: string;
  readonly background: boolean;
}

/** 进程级唯一实例：全部写点/读点共享同一 ALS（多实例 = 各说各话的路由分裂） */
const sessionChain = new AsyncLocalStorage<SessionChainScope>();

/**
 * 调用方身份链（P1-1 导入者归因）：与 sessionChain 独立的第二 ALS——身份与路由
 * 是两个正交维度（宿主代码也跑在会话链上但不该落宿主以外的账），故不共载体。
 * 值 = 应用 row.id（装载器/工具管道两写点已归一）或 undefined（宿主自身）。
 */
const callerChain = new AsyncLocalStorage<string>();

/**
 * 在指定会话的调用链语境内执行 fn——驱动边界的包裹原语。
 * fn 的整个异步下游（await 链/内部注册的回调）都读得到 chainSessionId()。
 * @param scope.sessionId 归属会话 id
 * @param scope.background 本 run 开起批是否全 backgroundWake（缺省 false = 前台语义）
 */
export function runInSessionChain<T>(
  scope: { readonly sessionId: string; readonly background?: boolean },
  fn: () => T,
): T {
  return sessionChain.run({ sessionId: scope.sessionId, background: scope.background === true }, fn);
}

/**
 * 在指定调用方身份的链语境内执行 fn——应用身份已知边界的包裹原语。
 * 嵌套规则：内层覆盖外层（应用工具体内再起子代理等场景，最近身份即行为者）。
 * @param caller 调用方身份（装载器写点 = 应用 row.id；工具段写点 = 注册归属应用名）
 */
export function runInCallerChain<T>(caller: string, fn: () => T): T {
  return callerChain.run(caller, fn);
}

/**
 * 读取调用链当前会话 id——全局绑定面的路由取数口。
 * 无链（timer 面/诊断面/TUI 语境等）返回 undefined，由调用方决定兜底策略
 * （focus 前台聚焦 / 不落账只 debug——见各读点的规范语义）。
 */
export function chainSessionId(): string | undefined {
  return sessionChain.getStore()?.sessionId;
}

/**
 * 读取调用链 background 列（S5 审批 priority 取数口）：链上批全部 backgroundWake
 * 即 true；无链（exec 服务/timer 面/命令面）或缺省 interactive（前台语义）。
 */
export function chainBackground(): boolean {
  return sessionChain.getStore()?.background === true;
}

/**
 * 读取调用链当前调用方身份（P1-1 归因取数口）：应用账归属者。
 * 无链 = 宿主自身在调用（装配期/命令面/timer 面/内置工具 host 语义）——
 * 调用方约定俗成兜底 'host'（与 sessions.importer 列的宿主语义对齐）。
 */
export function chainCaller(): string | undefined {
  return callerChain.getStore();
}

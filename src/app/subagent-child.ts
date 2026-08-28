/**
 * L5 app — 子会话 dispose 序列（骨架篇 §6.2 pi-5 / §6.4 落码注记，subagent 纵切三）
 * + session_shutdown bounded 派发公共件（2026-08-27 第二十九批 P1-6，契约篇 §2.2
 * 增补 8②——主关停序与子代理 dispose 两发射位同享）。
 *
 * SubagentRun.dispose() 与 Job 结算在释放子所有权前，对子会话按 §1.3 优雅退出
 * **同序缩像**执行：session_flush 屏障 → session_shutdown 钩子（parallel bounded
 * 等待）→ effect 回卷——子会话也是会话，事件面不豁免（pi AgentSession.dispose
 * 不发 session_shutdown、逼 tintinweb/pi-subagents 手工补发的实证反例，
 * 2026-08-23 生态读码补钉）。
 *
 * 归属：组合根侧零件（需要 persistence/childCtx 闭包），工厂（纵切四真工厂）
 * 把它接进 InProcessChild.dispose 半边。bounded 等待的 session_shutdown 让应用
 * 钩子在 flush 之后、回卷之前观察终态并完成清理（清理器 Promise 不再被吞）。
 */

import type { Context, ContextScope } from '../context/types.js';

/** dispose 序列依赖的持久层结构面（定向 flush——测试可注入替身） */
export interface FlushBarrier {
  /** 屏障：排空指定会话的 write-behind 批量窗口后放行 */
  flush(sessionId?: string): Promise<void>;
}

/** session_shutdown 单会话条目等待预算（毫秒）——二十九批增补 8②：清理器常态亚秒，2s = best-effort 上限 */
export const SESSION_SHUTDOWN_BUDGET_MS = 2_000;

/**
 * session_shutdown 的 parallel bounded 派发（两发射位同享：主关停序逐条目 +
 * 子代理 dispose 转发根总线）。目录 mode = parallel（全等待 + 单失败隔离），
 * 装配层 Promise.race 限单条目 2s——超时 warn 后继续不阻塞退出（优雅退出是
 * best-effort 上限不是硬闸；超预算仍在跑的清理器由 close 后进程退出自然终结）。
 *
 * @param bus   派发总线（主序 = 根 ctx；子代理位经转发体最终也落根 ctx）
 * @param sessionId 载荷会话 id
 */
export async function emitSessionShutdownBounded(
  bus: Pick<Context, 'parallel' | 'logger'>,
  sessionId: string,
): Promise<void> {
  // 预算钟：到点先 resolve 'timeout' 让 race 胜出（unref 保险——不阻进程退出）
  const budget = new Promise<'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), SESSION_SHUTDOWN_BUDGET_MS);
    timer.unref?.();
  });
  const settled = bus.parallel('session_shutdown', { sessionId }).then(() => 'done' as const);
  if ((await Promise.race([settled, budget])) === 'timeout') {
    // 不抛错不重试：warn 可见后继续关停（与 fire-and-forget 唯一差异 = 多 2s 缓冲与可见告警）
    bus.logger.warn('session_shutdown 清理器超 2s 预算，放弃等待继续关停', { sessionId });
  }
}

/**
 * dispose 序列依赖的作用域结构面（shutdown 派发 + 日志 + dispose 回卷三件）。
 * 真工厂传转发体：parallel/logger 转发**根总线**（应用 keyed by payload——子 ctx
 * 上无应用，观察面在根，与 delegation fork 的 session_start 对称）；dispose 落
 * 子作用域本尊。Context 结构兼容，测试直接传真 ctx。
 */
export type ChildScopeFace = Pick<ContextScope, 'parallel' | 'logger' | 'dispose'>;

/** 子会话 dispose 序列构造选项 */
export interface ChildSessionDisposerOptions {
  /** 持久层（① session_flush 屏障——子会话事件先落盘再拆装配）；缺省 no-op 屏障（无持久层诊断面） */
  readonly persistence?: FlushBarrier;
  /** 子装配作用域（② session_shutdown 钩子派发面；③ dispose 即 effect LIFO 回卷） */
  readonly childCtx: ChildScopeFace;
  /** 子会话 id（flush 定向 + shutdown 载荷） */
  readonly sessionId: string;
}

/**
 * 创建子会话 dispose 序列（幂等——InProcessChild.dispose 契约的工厂半边）。
 *
 * @returns 序列执行体（重复调用 no-op：释放恰一次语义由 disposed 标记保证）
 */
export function createChildSessionDisposer(opts: ChildSessionDisposerOptions): () => Promise<void> {
  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    // ① session_flush 屏障：子会话事件全部落盘（结算通知先于本序列——顺序规则）
    await opts.persistence?.flush(opts.sessionId);
    // ② session_shutdown 钩子：应用最终清理锚点（契约篇 §2.2 session 层；parallel
    //    bounded 等待——该位经 jobs.drain 先于主序 ⑤ 执行，不设上限则挂死清理器
    //    把 drain 连同优雅退出整链挂死在保护罩外，二十九批增补 8②）
    await emitSessionShutdownBounded(opts.childCtx, opts.sessionId);
    // ③ effect 回卷：子装配注册的工具/监听/服务 LIFO 级联释放
    await opts.childCtx.dispose();
  };
}

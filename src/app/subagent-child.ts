/**
 * L5 app — 子会话 dispose 序列（骨架篇 §6.2 pi-5 / §6.4 落码注记，subagent 纵切三）。
 *
 * SubagentRun.dispose() 与 Job 结算在释放子所有权前，对子会话按 §1.3 优雅退出
 * **同序缩样**执行：session_flush 屏障 → session_shutdown 钩子 → effect 回卷——
 * 子会话也是会话，事件面不豁免（pi AgentSession.dispose 不发 session_shutdown、
 * 逼 tintinweb/pi-subagents 手工补发的实证反例，2026-08-23 生态读码补钉）。
 *
 * 归属：组合根侧零件（需要 persistence/childCtx 闭包），工厂（纵切四真工厂）
 * 把它接进 InProcessChild.dispose 半边。同步 emit 的 session_shutdown 让插件
 * 钩子在 flush 之后、回卷之前观察终态。
 */

import type { ContextScope } from '../context/types.js';

/** dispose 序列依赖的持久层结构面（定向 flush——测试可注入替身） */
export interface FlushBarrier {
  /** 屏障：排空指定会话的 write-behind 批量窗口后放行 */
  flush(sessionId?: string): Promise<void>;
}

/**
 * dispose 序列依赖的作用域结构面（emit 通知总线 + dispose 回卷）。
 * 真工厂传转发体：session_shutdown 发**根总线**（插件 keyed by payload——子 ctx
 * 上无插件，观察面在根，与 delegation fork 的 session_start 对称）；dispose 落
 * 子作用域本尊。ContextScope 结构兼容（方法双变），测试直接传真 ctx。
 */
export interface ChildScopeFace {
  /** ② session_shutdown 钩子挂载面 */
  emit(event: 'session_shutdown', data: { sessionId: string }): void;
  /** ③ effect LIFO 回卷 */
  dispose(): Promise<void>;
}

/** 子会话 dispose 序列构造选项 */
export interface ChildSessionDisposerOptions {
  /** 持久层（① session_flush 屏障——子会话事件先落盘再拆装配）；缺省 no-op 屏障（无持久层诊断面） */
  readonly persistence?: FlushBarrier;
  /** 子装配作用域（② session_shutdown 钩子挂载面；③ dispose 即 effect LIFO 回卷） */
  readonly childCtx: ContextScope | ChildScopeFace;
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
    // ② session_shutdown 钩子：插件最终清理锚点（契约篇 §2.2 session 层）
    opts.childCtx.emit('session_shutdown', { sessionId: opts.sessionId });
    // ③ effect 回卷：子装配注册的工具/监听/服务 LIFO 级联释放
    await opts.childCtx.dispose();
  };
}

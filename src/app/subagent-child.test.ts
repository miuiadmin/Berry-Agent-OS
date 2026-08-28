/**
 * L5 app — 子会话 dispose 序列测试（骨架篇 §6.2 pi-5 / §6.4，subagent 纵切三）。
 *
 * 真件：真 createContext（effect 栈真实回卷）+ 记录型 flush 屏障（持久层端口半边）。
 * 锁行为面：三步定序（flush 屏障 → session_shutdown 钩子 → effect 回卷）/
 * 载荷正确（sessionId）/ 幂等（重复调用 no-op）。
 */
import { describe, expect, it } from 'vitest';
import { createContext } from '../context/context.js';
import { createLogger } from '../context/logger.js';
import { createChildSessionDisposer, type FlushBarrier } from './subagent-child.js';

/* ---------------- 测试基建 ---------------- */

/** 记录型 flush 屏障（步骤序观测 + 参数观测） */
function recordingBarrier(): { barrier: FlushBarrier; flushes: (string | undefined)[] } {
  const flushes: (string | undefined)[] = [];
  const barrier: FlushBarrier = {
    async flush(sessionId) {
      flushes.push(sessionId);
    },
  };
  return { barrier, flushes };
}

/** 建子作用域 + 观测 effect 回卷序（effect 注册即挂栈——dispose 序 LIFO 可验） */
function childScope() {
  const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
  const unwindLog: string[] = [];
  ctx.effect(() => {
    unwindLog.push('effect-1 挂卷');
    return () => unwindLog.push('effect-1 回卷');
  });
  ctx.effect(() => {
    unwindLog.push('effect-2 挂卷');
    return () => unwindLog.push('effect-2 回卷');
  });
  return { ctx, unwindLog };
}

/* ---------------- 用例 ---------------- */

describe('createChildSessionDisposer（§6.2 三步定序）', () => {
  it('flush(sessionId) → session_shutdown 载荷 → effect LIFO 回卷——顺序即此不动摇', async () => {
    const { barrier, flushes } = recordingBarrier();
    const { ctx, unwindLog } = childScope();
    /** 全局步骤序（跨三个观测面的统一时间线） */
    const timeline: string[] = [];
    const originalFlush = barrier.flush.bind(barrier);
    barrier.flush = async (id) => {
      await originalFlush(id);
      timeline.push('flush');
    };
    ctx.on('session_shutdown', () => timeline.push('shutdown'));
    ctx.effect(() => () => timeline.push('unwind'));

    const disposer = createChildSessionDisposer({ persistence: barrier, childCtx: ctx, sessionId: 'child-1' });
    await disposer();
    // 三步定序：屏障先落盘、钩子次之、回卷最后（通知先于本序列——此处只见序列本身）
    expect(timeline).toEqual(['flush', 'shutdown', 'unwind']);
    expect(flushes).toEqual(['child-1']);
  });

  it('session_shutdown 载荷携带子会话 id（应用最终清理锚点的对账键）', async () => {
    const { barrier } = recordingBarrier();
    const { ctx } = childScope();
    const payloads: { sessionId?: string }[] = [];
    ctx.on('session_shutdown', (data) => payloads.push(data as { sessionId?: string }));
    await createChildSessionDisposer({ persistence: barrier, childCtx: ctx, sessionId: 'child-42' })();
    expect(payloads).toEqual([{ sessionId: 'child-42' }]);
  });

  it('effect LIFO：后注册先回卷（子装配释放序与装配序镜像）', async () => {
    const { barrier } = recordingBarrier();
    const { ctx, unwindLog } = childScope();
    await createChildSessionDisposer({ persistence: barrier, childCtx: ctx, sessionId: 'child-1' })();
    expect(unwindLog).toEqual(['effect-1 挂卷', 'effect-2 挂卷', 'effect-2 回卷', 'effect-1 回卷']);
  });

  it('幂等：重复调用 no-op（释放恰一次语义——flush/钩子/回卷都不重放）', async () => {
    const { barrier, flushes } = recordingBarrier();
    const { ctx } = childScope();
    const shutdowns: unknown[] = [];
    ctx.on('session_shutdown', (data) => shutdowns.push(data));
    const disposer = createChildSessionDisposer({ persistence: barrier, childCtx: ctx, sessionId: 'child-1' });
    await disposer();
    await disposer(); // 重复调用：静默返回
    await disposer(); // 三连：仍静默
    expect(flushes).toEqual(['child-1']);
    expect(shutdowns).toHaveLength(1);
  });
});

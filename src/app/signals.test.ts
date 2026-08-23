/**
 * L5 app — 信号编舞单测（骨架篇 §1.3 表逐行锁行为；注入假信号面，不真退进程）。
 *
 * 锁的内容：SIGINT 首次转优雅退出 / 二次立即 130；SIGTERM/SIGHUP 记账
 * 143/129；uncaught/unhandled 记日志（onFatal 调用形状）+ 限时等落盘 + exit(1)；
 * dispose 卸载干净。
 */

import { describe, expect, it } from 'vitest';
import { installExitSignals } from './signals.js';
import type { SignalSurface } from './signals.js';

/** 假信号面：收账监听器与 exit 调用（exit 不真退——记录后返回模拟） */
function fakeSurface() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const exitCalls: number[] = [];
  const surface: SignalSurface = {
    on: (event, listener) => {
      listeners.set(event, listener as (...args: unknown[]) => void);
    },
    removeListener: (event, listener) => {
      // 只在监听器未变时移除（防误删后注册的其他同事件监听器）
      if (listeners.get(event) === listener) listeners.delete(event);
    },
    exit: (code) => {
      exitCalls.push(code);
      // 真实 process.exit 永不返回；假面记录后直接返回（不抛——抛会制造
      // unhandledRejection 噪音），后续语句的重复执行由用例断言容差
      return undefined as never;
    },
  };
  return { surface, listeners, exitCalls };
}

/** 装配一套编舞 + 收账器（每用例独立） */
function rig(surface: SignalSurface) {
  const quits: number[] = [];
  const fatals: Array<{ kind: string; error: unknown }> = [];
  const handle = installExitSignals({
    onGracefulQuit: () => quits.push(quits.length),
    onFatal: (error, kind) => {
      fatals.push({ kind, error });
      return Promise.resolve();
    },
    surface,
  });
  return { handle, quits, fatals };
}

describe('installExitSignals（骨架篇 §1.3 信号表）', () => {
  it('SIGINT 首次：转优雅退出请求，退出码记账 0，不直接 exit', () => {
    const { surface, listeners, exitCalls } = fakeSurface();
    const { handle, quits } = rig(surface);

    listeners.get('SIGINT')!();
    expect(quits).toHaveLength(1); // requestQuit 恰好一次
    expect(exitCalls).toEqual([]); // 优雅路由入口自然走完，不在此处 exit
    expect(handle.exitCode).toBe(0); // SIGINT 首次优雅完成 = 0（用户中断不是错误）
  });

  it('SIGINT 二次：立即 exit(130)——不等优雅序列', () => {
    const { surface, listeners, exitCalls } = fakeSurface();
    rig(surface);

    listeners.get('SIGINT')!();
    listeners.get('SIGINT')!();
    expect(exitCalls).toEqual([130]);
  });

  it('SIGTERM：视同首次走优雅 + 退出码记账 143', () => {
    const { surface, listeners, exitCalls } = fakeSurface();
    const { handle, quits } = rig(surface);

    listeners.get('SIGTERM')!();
    expect(quits).toHaveLength(1);
    expect(exitCalls).toEqual([]);
    expect(handle.exitCode).toBe(143);
  });

  it('SIGHUP：视同首次走优雅 + 退出码记账 129', () => {
    const { surface, listeners } = fakeSurface();
    const { handle, quits } = rig(surface);

    listeners.get('SIGHUP')!();
    expect(quits).toHaveLength(1);
    expect(handle.exitCode).toBe(129);
  });

  it('uncaughtException：onFatal 收到异常与种类，限时等待后 exit(1)', async () => {
    const { surface, listeners, exitCalls } = fakeSurface();
    const { fatals } = rig(surface);

    const boom = new Error('栈炸了');
    listeners.get('uncaughtException')!(boom);
    expect(fatals).toEqual([{ kind: 'uncaughtException', error: boom }]);
    // exit 在 onFatal 的 promise 结算后异步发生——等微任务队列排空
    await new Promise((resolve) => setImmediate(resolve));
    expect(exitCalls).toEqual([1]); // 不吞：记日志 + 尽力落盘 + exit(1)
  });

  it('unhandledRejection：同致命路 exit(1)', async () => {
    const { surface, listeners, exitCalls } = fakeSurface();
    const { fatals } = rig(surface);

    listeners.get('unhandledRejection')!(new Error('没人接的拒绝'));
    expect(fatals[0]?.kind).toBe('unhandledRejection');
    await new Promise((resolve) => setImmediate(resolve));
    expect(exitCalls).toEqual([1]);
  });

  it('onFatal 超时不无限等：限时后仍 exit(1)（best-effort 不是 best-wait）', async () => {
    const { surface, listeners, exitCalls } = fakeSurface();
    installExitSignals({
      onGracefulQuit: () => undefined,
      // 永不结算的落盘——模拟 flush 卡死；1ms 限时后必须照常离场
      onFatal: () => new Promise(() => undefined),
      surface,
      fatalTimeoutMs: 1,
    });

    listeners.get('uncaughtException')!(new Error('flush 卡死'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exitCalls).toEqual([1]);
  });

  it('dispose：全部监听卸载（真实面 = process 上的五个监听器移除）', () => {
    const { surface, listeners, exitCalls } = fakeSurface();
    const { handle } = rig(surface);

    expect(listeners.size).toBe(5); // SIGINT/SIGTERM/SIGHUP/uncaught/unhandled
    handle.dispose();
    expect(listeners.size).toBe(0);
    expect(exitCalls).toEqual([]);
  });
});

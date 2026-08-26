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

/** 装配一套编舞 + 收账器（每用例独立；onGracefulQuit 记录 kind——S6 信号分种类断言依据） */
function rig(surface: SignalSurface) {
  const kinds: string[] = [];
  const fatals: Array<{ kind: string; error: unknown }> = [];
  const handle = installExitSignals({
    onGracefulQuit: (kind) => kinds.push(kind),
    onFatal: (error, kind) => {
      fatals.push({ kind, error });
      return Promise.resolve();
    },
    surface,
  });
  return { handle, kinds, fatals };
}

describe('installExitSignals（骨架篇 §1.3 信号表）', () => {
  it('SIGINT 首次：转优雅退出请求（kind=interrupt），退出码记账 0，不直接 exit', () => {
    const { surface, listeners, exitCalls } = fakeSurface();
    const { handle, kinds } = rig(surface);

    listeners.get('SIGINT')!();
    expect(kinds).toEqual(['interrupt']); // S6 形态④：SIGINT 可分档（多驱动 interrupt）
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

  it('SIGTERM：视同首次走优雅（kind=terminate——恒全序列不可分档）+ 退出码记账 143', () => {
    const { surface, listeners, exitCalls } = fakeSurface();
    const { handle, kinds } = rig(surface);

    listeners.get('SIGTERM')!();
    expect(kinds).toEqual(['terminate']); // S6 形态④：进程管理器要求退出——不可「不退 OS」
    expect(exitCalls).toEqual([]);
    expect(handle.exitCode).toBe(143);
  });

  it('SIGHUP：视同首次走优雅（kind=terminate）+ 退出码记账 129', () => {
    const { surface, listeners } = fakeSurface();
    const { handle, kinds } = rig(surface);

    listeners.get('SIGHUP')!();
    expect(kinds).toEqual(['terminate']);
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

describe('急停旗标了结（S6 形态⑥——acknowledgeQuitRequest）', () => {
  it('旗标 = 在身的未了结退出请求：interrupt 路结算后 acknowledge → 下次 SIGINT 又是首次语义', () => {
    const { surface, listeners, exitCalls } = fakeSurface();
    const { handle, kinds } = rig(surface);

    listeners.get('SIGINT')!(); // 首次：interrupt 请求在身
    handle.acknowledgeQuitRequest(); // 入口在 front.interrupt() 的 settle 了结时调——请求已了结
    listeners.get('SIGINT')!(); // 又是首次：优雅 interrupt（非 130 硬退）
    expect(kinds).toEqual(['interrupt', 'interrupt']);
    expect(exitCalls).toEqual([]); // 无硬退——「连续两次」的真语义 = run 未结算窗口内的两次
  });

  it('未了结窗口内二次 SIGINT：仍 130 立即硬退（acknowledge 缺席即旧语义）', () => {
    const { surface, listeners, exitCalls } = fakeSurface();
    rig(surface);

    listeners.get('SIGINT')!(); // 首次：interrupt 在身（run 尚未结算——acknowledge 未被调）
    listeners.get('SIGINT')!(); // 窗口期内第二次：用户坚持现在走
    expect(exitCalls).toEqual([130]);
  });

  it('terminate 路无了结语义：SIGTERM 后 acknowledge 不改变幂等重入（quits 照常）', () => {
    const { surface, listeners, exitCalls } = fakeSurface();
    const { handle, kinds } = rig(surface);

    listeners.get('SIGTERM')!();
    handle.acknowledgeQuitRequest(); // terminate 路进程本就走退出序列——复位无意义（容错 no-op）
    listeners.get('SIGTERM')!(); // 重复到达保持幂等（requestQuit 可重入）
    expect(kinds).toEqual(['terminate', 'terminate']);
    expect(exitCalls).toEqual([]); // SIGTERM 无 130 快捷（幂等重入非硬退）
  });
});

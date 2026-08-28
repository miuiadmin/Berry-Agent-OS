/**
 * L1 context 单元测试——调用链作用域（会话链既有行为不在此重测，本文件只锁
 * caller 链新面：会话篇 §5.1 导入者归因，2026-08-27 P1-1）。
 *
 * 锁的语义：
 * - 包裹内可见、包裹外不可见（无链 = undefined，读点约定 'host' 兜底）；
 * - 异步下游继承（await 链上的共享服务面调用能读到注册时身份）；
 * - 嵌套内层覆盖外层（最近身份即行为者）；
 * - 与会话链正交（caller 包裹不改会话链取数，反之亦然——两 ALS 独立）。
 */

import { describe, expect, it } from 'vitest';
import { runInSessionChain, runInCallerChain, chainCaller, chainSessionId } from './chain.js';

describe('caller 链（导入者归因取数口）', () => {
  it('包裹内可读、包裹外 undefined（host 兜底约定由读点承担）', () => {
    expect(chainCaller()).toBeUndefined();
    const inside = runInCallerChain('apps-a', () => chainCaller());
    expect(inside).toBe('apps-a');
    expect(chainCaller()).toBeUndefined(); // 包裹结束即出链
  });

  it('异步下游继承：await 之后仍读到身份（服务面跨 tick 调用的形态）', async () => {
    const readAfterTick = runInCallerChain('apps-b', async () => {
      await Promise.resolve(); // 让出微任务队列后再读
      return chainCaller();
    });
    expect(await readAfterTick).toBe('apps-b');
  });

  it('嵌套内层覆盖外层（最近身份即行为者）', () => {
    const result = runInCallerChain('outer', () => runInCallerChain('inner', () => chainCaller()));
    expect(result).toBe('inner');
  });

  it('与会话链正交：caller 包裹不染会话链，会话包裹不染 caller 链', () => {
    const both = runInSessionChain({ sessionId: 's1' }, () =>
      runInCallerChain('apps-c', () => ({ caller: chainCaller(), session: chainSessionId() })),
    );
    expect(both).toEqual({ caller: 'apps-c', session: 's1' });
    // 单独会话链内 caller 仍无身份
    const sessionOnly = runInSessionChain({ sessionId: 's2' }, () => chainCaller());
    expect(sessionOnly).toBeUndefined();
  });
});

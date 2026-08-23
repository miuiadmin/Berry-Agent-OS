/**
 * L1 context 单元测试——覆盖骨架篇 §9.1 核心层全部语义：
 * effect LIFO 回卷 / 事件四模式（含异常隔离与 prepend）/ provide-get /
 * stale ctx 护栏 / signal / config 只读 / fork 作用域隔离与共享。
 */
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../contracts/errors.js';
import { createContext } from './context.js';
import { createLogger } from './logger.js';
import type { ContextScope } from './types.js';

/** 静默 logger：测试不向 stderr 喷日志（异常隔离用例会走 error 通道） */
function silentRoot() {
  return createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
}

describe('effect 生命周期', () => {
  it('dispose 按注册逆序（LIFO）回卷', async () => {
    const scope = silentRoot();
    const order: number[] = [];
    scope.effect(() => () => order.push(1));
    scope.effect(() => () => order.push(2));
    scope.effect(() => () => order.push(3));
    await scope.dispose();
    expect(order).toEqual([3, 2, 1]);
  });

  it('手动调用 Disposer 幂等，且从回卷栈中摘除（dispose 不重复执行）', async () => {
    const scope = silentRoot();
    let count = 0;
    const dispose = scope.effect(() => () => count++);
    dispose();
    dispose(); // 第二次调用应是空操作
    await scope.dispose();
    expect(count).toBe(1);
  });

  it('回卷抛异常被隔离：后续 effect 照常回卷', async () => {
    const scope = silentRoot();
    const order: string[] = [];
    scope.effect(() => () => {
      order.push('first');
      throw new Error('cleanup boom');
    });
    scope.effect(() => () => order.push('second'));
    await scope.dispose();
    expect(order).toEqual(['second', 'first']);
  });
});

describe('事件四模式', () => {
  it('emit：全部监听器触发；单个同步失败隔离、不中断其余', () => {
    const scope = silentRoot();
    const ok = vi.fn();
    scope.on('evt/x', () => {
      throw new Error('boom');
    });
    scope.on('evt/x', ok);
    scope.emit('evt/x', 1, 'a');
    expect(ok).toHaveBeenCalledWith(1, 'a');
  });

  it('on 返回的 Disposer 可退订；作用域 dispose 自动退订', async () => {
    const scope = silentRoot();
    const handler = vi.fn();
    const off = scope.on('evt/x', handler);
    off();
    scope.emit('evt/x');
    expect(handler).not.toHaveBeenCalled();

    const scope2 = silentRoot();
    const handler2 = vi.fn();
    scope2.on('evt/y', handler2);
    await scope2.dispose();
    // dispose 后根上再 emit（新作用域共享总线）：已退订的监听器不再触发
    const other = silentRoot();
    other.on('evt/y', () => {});
    other.emit('evt/y');
    expect(handler2).not.toHaveBeenCalled();
  });

  it('emit 基线：无异常路径下单监听器确实被触发（防空跑假阳性）', () => {
    const scope = silentRoot();
    const handler = vi.fn();
    scope.on('evt/base', handler);
    scope.emit('evt/base', 'x');
    expect(handler).toHaveBeenCalledWith('x');
  });

  it('prepend 插队：先于普通注册执行', async () => {
    const scope = silentRoot();
    const order: string[] = [];
    scope.on('evt/x', () => order.push('normal'));
    scope.on('evt/x', () => order.push('prepended'), { prepend: true });
    await scope.serial('evt/x');
    expect(order).toEqual(['prepended', 'normal']);
  });

  it('serial：按注册序串行执行，失败隔离不阻断后续', async () => {
    const scope = silentRoot();
    const order: number[] = [];
    scope.on('evt/s', () => order.push(1));
    scope.on('evt/s', () => {
      order.push(2);
      throw new Error('mid boom');
    });
    scope.on('evt/s', async () => {
      await Promise.resolve();
      order.push(3);
    });
    await scope.serial('evt/s');
    expect(order).toEqual([1, 2, 3]);
  });

  it('parallel：全部触发且等待完成，失败隔离', async () => {
    const scope = silentRoot();
    const seen: number[] = [];
    scope.on('evt/p', async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(1);
    });
    scope.on('evt/p', () => {
      throw new Error('boom');
    });
    scope.on('evt/p', async () => {
      seen.push(2);
    });
    await scope.parallel('evt/p');
    expect(seen.sort()).toEqual([1, 2]);
  });

  it('waterfall：监听器调 next 委托下游，链尾 next 兜底', async () => {
    const scope = silentRoot();
    const visited: string[] = []; // 显式留痕：防「零监听器空跑」假阳性
    scope.on('evt/w', (_value: number, next: () => Promise<number>) => {
      visited.push('h1');
      return next();
    });
    scope.on('evt/w', (_value: number, next: () => Promise<number>) => {
      visited.push('h2');
      return next();
    });
    const result = await scope.waterfall<number>('evt/w', 42, () => 100);
    expect(result).toBe(100);
    expect(visited).toEqual(['h1', 'h2']);
  });

  it('waterfall：监听器不调 next 即短路，其返回值为最终值', async () => {
    const scope = silentRoot();
    const downstream = vi.fn();
    scope.on('evt/w', (value: number, next: () => unknown) => `intercepted:${value}`);
    scope.on('evt/w', downstream);
    const result = await scope.waterfall<string>('evt/w', 7, () => 'tail');
    expect(result).toBe('intercepted:7');
    expect(downstream).not.toHaveBeenCalled();
  });

  it('waterfall：prepend 拦截器先执行（工具管道守门段依赖）', async () => {
    const scope = silentRoot();
    scope.on('evt/w', (v: string, next: () => unknown) => `${v}-normal`);
    scope.on(
      'evt/w',
      // next() 返回 Promise（链是异步的）——拦截器须 await 才能拿到下游结果
      async (v: string, next: () => Promise<unknown>) => `gate(${await next()})`,
      { prepend: true },
    );
    const result = await scope.waterfall<string>('evt/w', 'x', () => 'tail');
    expect(result).toBe('gate(x-normal)');
  });

  it('waterfall：无监听器直接落链尾 next', async () => {
    const scope = silentRoot();
    const result = await scope.waterfall<number>('evt/none', () => 9);
    expect(result).toBe(9);
  });
});

describe('服务注册表 provide/get', () => {
  it('注册后可取用；注销后取用抛 CONTEXT_SERVICE_NOT_FOUND', () => {
    const scope = silentRoot();
    const off = scope.provide('demo.svc', { hello: () => 'hi' });
    expect(scope.get<{ hello: () => string }>('demo.svc').hello()).toBe('hi');
    off();
    expect(() => scope.get('demo.svc')).toThrowError(AppError);
    try {
      scope.get('demo.svc');
    } catch (err) {
      expect((err as AppError).code).toBe('CONTEXT_SERVICE_NOT_FOUND');
    }
  });

  it('同名重复注册抛 CONTEXT_SERVICE_EXISTS', () => {
    const scope = silentRoot();
    scope.provide('demo.dup', 1);
    try {
      scope.provide('demo.dup', 2);
      expect.unreachable('重复注册应抛错');
    } catch (err) {
      expect((err as AppError).code).toBe('CONTEXT_SERVICE_EXISTS');
    }
  });

  it('作用域 dispose 自动注销其注册的服务', async () => {
    const root = silentRoot();
    const plugin = root.fork({ name: 'plugin-a' });
    plugin.provide('plugin.a.svc', 'value');
    expect(root.get('plugin.a.svc')).toBe('value');
    await plugin.dispose();
    expect(() => root.get('plugin.a.svc')).toThrowError(/未注册/);
  });

  // 软依赖探测（2026-08-23 生态读码补钉 dsh-4）：缺 = 明确 undefined，禁轮询禁鸭子探测
  it('tryGet：已注册返回实现；未注册返回 undefined 不抛错', () => {
    const scope = silentRoot();
    const off = scope.provide('optional.svc', { n: 7 });
    expect(scope.tryGet<{ n: number }>('optional.svc')?.n).toBe(7);
    expect(scope.tryGet('missing.svc')).toBeUndefined();
    off();
    expect(scope.tryGet('optional.svc')).toBeUndefined(); // 注销后同样软缺，不抛
  });
});

describe('fork 作用域', () => {
  it('子作用域共享事件总线与服务表，effect 栈独立（LIFO 各自回卷）', async () => {
    const root = silentRoot();
    const order: string[] = [];
    root.effect(() => () => order.push('root'));
    const a = root.fork({ name: 'a' });
    const b = root.fork({ name: 'b' });
    a.effect(() => () => order.push('a'));
    b.effect(() => () => order.push('b'));
    const seenByA = vi.fn();
    b.on('evt/shared', () => order.push('b-handler'));
    a.on('evt/shared', seenByA);

    await a.dispose(); // 只回卷 a 的 effect；b 与 root 的监听器不受影响
    expect(order).toEqual(['a']);
    root.emit('evt/shared');
    expect(order).toEqual(['a', 'b-handler']);
    expect(seenByA).not.toHaveBeenCalled();
  });

  it('config 只读快照：外部改源对象不影响 ctx.config', () => {
    const source = { key: 'v1' };
    const root = createContext({
      config: source,
      logger: createLogger({ module: 'test', level: 'silent' }),
    });
    source['key'] = 'v2';
    expect(root.config['key']).toBe('v1');
    expect(() => {
      (root.config as Record<string, unknown>)['key'] = 'x';
    }).toThrowError(TypeError);
  });
});

describe('stale ctx 护栏', () => {
  it('dispose 后注册类 API 抛 CONTEXT_DISPOSED；signal 已 abort', async () => {
    const scope: ContextScope = silentRoot();
    await scope.dispose();
    expect(scope.signal.aborted).toBe(true);
    for (const attempt of [
      () => scope.effect(() => () => {}),
      () => scope.on('evt/x', () => {}),
      () => scope.provide('svc.after', 1),
    ]) {
      try {
        attempt();
        expect.unreachable('销毁后注册应抛错');
      } catch (err) {
        expect((err as AppError).code).toBe('CONTEXT_DISPOSED');
      }
    }
  });

  it('dispose 幂等（二次调用空操作）', async () => {
    const scope = silentRoot();
    await scope.dispose();
    await scope.dispose();
  });
});

describe('context 运行时三补（2026-08-23 独立重读轮 #23 落码）', () => {
  /** 捕获 sink：收集 JSON 行供断言（不向 stderr 喷） */
  function captureSink() {
    const lines: string[] = [];
    return { lines, sink: (line: string) => lines.push(line) };
  }

  it('on 归因：监听器失败日志记注册方作用域名（owner），不记 emit 方', () => {
    const { lines, sink } = captureSink();
    // 归因错列场景：root emit、插件 B 的监听器炸——日志必须指向 B
    const root = createContext({ logger: createLogger({ module: 'test', level: 'debug', sink }) });
    const pluginB = root.fork({ name: 'plugin-b' });
    pluginB.on('evt/boom', () => {
      throw new Error('handler boom');
    });
    root.emit('evt/boom');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as { event: string; owner: string; error: string };
    expect(record.event).toBe('evt/boom');
    expect(record.owner).toBe('root:plugin-b'); // 注册方（修复前错记 emit 方 'root'）
    expect(record.error).toContain('handler boom');
    expect(record.error).toContain('at '); // 完整 stack 而非 String(err)
  });

  it('fork 级联回卷：根 dispose 自动回卷子作用域（宿主忘显式 dispose 也兜底）', async () => {
    const root = silentRoot();
    const child = root.fork({ name: 'plugin-a' });
    child.provide('plugin.a.svc', 'v');
    await root.dispose();
    // 子作用域已随根回卷：服务注销 + 子作用域进入 stale 态
    expect(root.tryGet('plugin.a.svc')).toBeUndefined();
    expect(() => child.provide('late.svc', 1)).toThrowError(AppError);
    expect(child.signal.aborted).toBe(true);
  });

  it('logger setLevel 沿子树级联：child 继承创建时快照、父调级后随之', () => {
    const { lines, sink } = captureSink();
    const parent = createLogger({ module: 'test', level: 'error', sink });
    const child = parent.child('mod');
    child.debug('调级前不可见'); // error 阈值下被过滤
    expect(lines).toHaveLength(0);
    parent.setLevel('debug');
    child.debug('调级后可见'); // 级联生效——不级联则插件日志永远按创建时旧阈值过滤
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as { module: string; msg: string };
    expect(record.module).toBe('test:mod');
    expect(record.msg).toBe('调级后可见');
  });
});

/**
 * L1 context 单元测试——覆盖骨架篇 §9.1 核心层全部语义：
 * effect LIFO 回卷 / 事件四模式（含异常隔离与 prepend）/ provide-get /
 * stale ctx 护栏 / signal / config 只读 / fork 作用域隔离与共享。
 */
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../contracts/errors.js';
import { createContext, registerLiveEvent } from './context.js';
import { createLogger } from './logger.js';
import type { ContextScope } from './types.js';

/** 静默 logger：测试不向 stderr 喷日志（异常隔离用例会走 error 通道） */
function silentRoot() {
  return createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
}

/**
 * 带自定义词汇的测试根作用域（2026-08-23 词汇执法落码后）：createContext 产物
 * 只含目录词汇，用例里的自定义事件名须先经 registerLiveEvent 登记（装载器在
 * 真实路径对插件 events 声明做同样的事）。
 */
function scopedRoot(
  events: ReadonlyArray<{ name: string; mode: 'emit' | 'waterfall' | 'parallel' | 'serial' }>,
): ContextScope {
  const scope = silentRoot();
  for (const evt of events) {
    registerLiveEvent(scope, { name: evt.name, mode: evt.mode, note: '测试词汇' });
  }
  return scope;
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
    const scope = scopedRoot([{ name: 'evt/x', mode: 'emit' }]);
    const ok = vi.fn();
    scope.on('evt/x', () => {
      throw new Error('boom');
    });
    scope.on('evt/x', ok);
    scope.emit('evt/x', 1, 'a');
    expect(ok).toHaveBeenCalledWith(1, 'a');
  });

  it('on 返回的 Disposer 可退订；作用域 dispose 自动退订', async () => {
    const scope = scopedRoot([{ name: 'evt/x', mode: 'emit' }]);
    const handler = vi.fn();
    const off = scope.on('evt/x', handler);
    off();
    scope.emit('evt/x');
    expect(handler).not.toHaveBeenCalled();

    const scope2 = scopedRoot([{ name: 'evt/y', mode: 'emit' }]);
    const handler2 = vi.fn();
    scope2.on('evt/y', handler2);
    await scope2.dispose();
    // dispose 后根上再 emit（新作用域共享总线）：已退订的监听器不再触发
    const other = scopedRoot([{ name: 'evt/y', mode: 'emit' }]);
    other.on('evt/y', () => {});
    other.emit('evt/y');
    expect(handler2).not.toHaveBeenCalled();
  });

  it('emit 基线：无异常路径下单监听器确实被触发（防空跑假阳性）', () => {
    const scope = scopedRoot([{ name: 'evt/base', mode: 'emit' }]);
    const handler = vi.fn();
    scope.on('evt/base', handler);
    scope.emit('evt/base', 'x');
    expect(handler).toHaveBeenCalledWith('x');
  });

  it('prepend 插队：先于普通注册执行', async () => {
    // 本用例经 serial 派发等序（serial 语义：注册序 = 执行序）——evt/x 按 serial 登记
    const scope = scopedRoot([{ name: 'evt/x', mode: 'serial' }]);
    const order: string[] = [];
    scope.on('evt/x', () => order.push('normal'));
    scope.on('evt/x', () => order.push('prepended'), { prepend: true });
    await scope.serial('evt/x');
    expect(order).toEqual(['prepended', 'normal']);
  });

  it('serial：按注册序串行执行，失败隔离不阻断后续', async () => {
    const scope = scopedRoot([{ name: 'evt/s', mode: 'serial' }]);
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
    const scope = scopedRoot([{ name: 'evt/p', mode: 'parallel' }]);
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
    const scope = scopedRoot([{ name: 'evt/w', mode: 'waterfall' }]);
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
    const scope = scopedRoot([{ name: 'evt/w', mode: 'waterfall' }]);
    const downstream = vi.fn();
    scope.on('evt/w', (value: number, next: () => unknown) => `intercepted:${value}`);
    scope.on('evt/w', downstream);
    const result = await scope.waterfall<string>('evt/w', 7, () => 'tail');
    expect(result).toBe('intercepted:7');
    expect(downstream).not.toHaveBeenCalled();
  });

  it('waterfall：prepend 拦截器先执行（工具管道守门段依赖）', async () => {
    const scope = scopedRoot([{ name: 'evt/w', mode: 'waterfall' }]);
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

  it('waterfall：next(newArgs) 变换传播——下游收新参数、链尾收最终值（context_transform 依赖；2026-08-24 修：旧实现丢弃 next 参数）', async () => {
    const scope = scopedRoot([{ name: 'evt/w', mode: 'waterfall' }]);
    const seen: unknown[][] = [];
    // 两个变换 handler 链式传播：各 append 一个元素
    scope.on('evt/w', (args: string[], next: (a: string[]) => Promise<string[]>) => {
      seen.push([...args]);
      return next([...args, 'A']);
    });
    scope.on('evt/w', (args: string[], next: (a: string[]) => Promise<string[]>) => {
      seen.push([...args]);
      return next([...args, 'B']);
    });
    const tail = vi.fn((final: string[]) => ['tail', ...final]);
    const result = await scope.waterfall<string[]>('evt/w', ['init'], tail);
    // 下游各收到上游变换后的参数；链尾收到最终参数（不是初始值）
    expect(seen).toEqual([['init'], ['init', 'A']]);
    expect(tail).toHaveBeenCalledWith(['init', 'A', 'B']); // 链尾收到最终参数（载荷单参——消息数组本身）
    expect(result).toEqual(['tail', 'init', 'A', 'B']);
  });

  it('waterfall：无参 next() 沿用当前参数（短路外的零变换直通语义不回归）', async () => {
    const scope = scopedRoot([{ name: 'evt/w', mode: 'waterfall' }]);
    scope.on('evt/w', (v: string, next: () => Promise<string>) => next());
    scope.on('evt/w', (v: string, next: () => Promise<string>) => next());
    const result = await scope.waterfall<string>('evt/w', 'kept', (final: string) => `tail:${final}`);
    expect(result).toBe('tail:kept'); // 两层无参 next 后参数原样到达链尾
  });

  it('waterfall：无监听器直接落链尾 next', async () => {
    const scope = scopedRoot([{ name: 'evt/none', mode: 'waterfall' }]);
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
    const root = scopedRoot([{ name: 'evt/shared', mode: 'emit' }]);
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
    registerLiveEvent(root, { name: 'evt/boom', mode: 'emit', note: '测试词汇' });
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

describe('事件词汇执法（契约篇 §1.1 落码，2026-08-23 /reload 纵切）', () => {
  it('五面未注册名一律 EVENT_UNKNOWN——拼错名从「监听器永不触发的静默死亡」变响亮失败', async () => {
    const scope = silentRoot(); // 仅目录词汇，evt/typo 未登记
    // on 是同步面：直接抛
    try {
      scope.on('evt/typo', () => {});
      expect.unreachable('on 未注册名应抛');
    } catch (err) {
      expect((err as AppError).code).toBe('EVENT_UNKNOWN');
    }
    // 派发四面是 async 方法（同步抛会化成 rejection）——统一 async 包装后断言拒绝
    for (const dispatch of [
      () => scope.emit('evt/typo'),
      () => scope.parallel('evt/typo'),
      () => scope.serial('evt/typo'),
      () => scope.waterfall('evt/typo', () => 1),
    ]) {
      await expect(async () => dispatch()).rejects.toMatchObject({ code: 'EVENT_UNKNOWN' });
    }
  });

  it('派发方法与声明 mode 不一致抛 EVENT_MODE_MISMATCH（mode 是事件公开契约）', async () => {
    const scope = silentRoot();
    registerLiveEvent(scope, { name: 'emit/only', mode: 'emit', note: '测试词汇' });
    await expect(async () => scope.serial('emit/only')).rejects.toMatchObject({ code: 'EVENT_MODE_MISMATCH' });
    registerLiveEvent(scope, { name: 'wf/only', mode: 'waterfall', note: '测试词汇' });
    await expect(async () => scope.emit('wf/only')).rejects.toMatchObject({ code: 'EVENT_MODE_MISMATCH' });
  });

  it('registerLiveEvent 撞名抛 EVENT_DUPLICATE——custom 互撞与撞目录名同罪', () => {
    const scope = silentRoot();
    registerLiveEvent(scope, { name: 'dup/name', mode: 'emit', note: '测试词汇' });
    try {
      registerLiveEvent(scope, { name: 'dup/name', mode: 'emit', note: '测试词汇' });
      expect.unreachable('custom 互撞应抛');
    } catch (err) {
      expect((err as AppError).code).toBe('EVENT_DUPLICATE');
    }
    try {
      registerLiveEvent(scope, { name: 'tools_change', mode: 'emit', note: '撞目录名' });
      expect.unreachable('撞目录名应抛');
    } catch (err) {
      expect((err as AppError).code).toBe('EVENT_DUPLICATE');
    }
  });

  it('注销器摘词后派发回归 EVENT_UNKNOWN（词汇表成员资格实时生效）', async () => {
    const scope = silentRoot();
    const off = registerLiveEvent(scope, { name: 'temp/evt', mode: 'emit', note: '测试词汇' });
    scope.on('temp/evt', () => {}); // 词汇在册——on 不抛即通过
    off();
    await expect(async () => scope.emit('temp/evt')).rejects.toMatchObject({ code: 'EVENT_UNKNOWN' });
  });

  it('锚作用域 dispose 级联注销装载期词汇（/reload 卸载基底回归锁）', async () => {
    const anchor = silentRoot();
    const pluginScope = anchor.fork({ name: 'p' });
    // 加载器形态：词汇登记经 effect 挂派生作用域栈（装载阶段①的真实接线方式）
    pluginScope.effect(() => registerLiveEvent(anchor, { name: 'p/done', mode: 'emit', note: '测试词汇' }));
    anchor.emit('p/done'); // 词汇在册——派发不抛即通过（无监听器为合法 no-op）
    await anchor.dispose(); // 锚回卷 → 级联回卷子作用域 → 词汇随 effect LIFO 注销
    // 派发面无 stale 护栏（emit 不查 disposed）——词汇已摘即应响 EVENT_UNKNOWN
    try {
      anchor.emit('p/done');
      expect.unreachable('dispose 后词汇应已注销');
    } catch (err) {
      expect((err as AppError).code).toBe('EVENT_UNKNOWN');
    }
  });

  it('registerLiveEvent 拒绝仿造作用域（CONTEXT_DISPOSED——登记通道只认 createContext/fork 产物）', () => {
    try {
      registerLiveEvent({} as ContextScope, { name: 'fake/evt', mode: 'emit', note: '测试词汇' });
      expect.unreachable('仿造作用域应抛');
    } catch (err) {
      expect((err as AppError).code).toBe('CONTEXT_DISPOSED');
    }
  });
});

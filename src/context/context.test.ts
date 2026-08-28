/**
 * L1 context 单元测试——覆盖骨架篇 §9.1 核心层全部语义：
 * effect LIFO 回卷 / 事件四模式（含异常隔离与 prepend）/ provide-get /
 * stale ctx 护栏 / signal / config 只读 / fork 作用域隔离与共享。
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { AppError } from '../contracts/errors.js';
import type { AppContext } from '../contracts/app.js';
import { createContext, eventDispatchStats, registerLiveEvent } from './context.js';
import { createLogger } from './logger.js';
import type { Context, ContextScope } from './types.js';

/**
 * 类型面锁（探针 #11，契约篇 §1.2 注记④）：宿主 Context 必须结构性覆盖
 * contracts 声明的 AppContext——应用作者经虚拟面拿到的类型承诺即本面。
 * 漂移（宿主改签名忘同步 contracts，或反向）在此编译期即红，不待第三方撞墙。
 * 双向锁：AppContext 的 logger 面收窄自宿主 Logger——收得过窄同样红。
 */
expectTypeOf<Context>().toExtend<AppContext>();
expectTypeOf<Context['logger']>().toExtend<AppContext['logger']>();

/** 静默 logger：测试不向 stderr 喷日志（异常隔离用例会走 error 通道） */
function silentRoot() {
  return createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
}

/**
 * 带自定义词汇的测试根作用域（2026-08-23 词汇执法落码后）：createContext 产物
 * 只含目录词汇，用例里的自定义事件名须先经 registerLiveEvent 登记（装载器在
 * 真实路径对应用 events 声明做同样的事）。
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

  it('effect 回调返回非函数：注册期即拒（CONTEXT_EFFECT_INVALID），不延迟到回卷期爆炸（探针 #13 回归锁）', () => {
    const scope = silentRoot();
    // 病灶习语：把已有 disposer 包进新箭头——fn 返回 undefined
    const disposer = () => {};
    expect(() => scope.effect(() => (disposer(), undefined) as unknown as () => void)).toThrowError(AppError);
    try {
      scope.effect(() => undefined as unknown as () => void);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('CONTEXT_EFFECT_INVALID');
      // 错误信息点名正确习语（第三方无类型护栏——运行时指引是唯一帮助面）
      expect((err as AppError).message).toContain('ctx.effect(d)');
    }
    // 坏注册未入栈：作用域照常可用、dispose 干净（不再有裸 TypeError）
    let cleaned = false;
    scope.effect(() => () => (cleaned = true));
    return scope.dispose().then(() => expect(cleaned).toBe(true));
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
    const off = scope.provide('demo-svc', { hello: () => 'hi' });
    expect(scope.get<{ hello: () => string }>('demo-svc').hello()).toBe('hi');
    off();
    expect(() => scope.get('demo-svc')).toThrowError(AppError);
    try {
      scope.get('demo-svc');
    } catch (err) {
      expect((err as AppError).code).toBe('CONTEXT_SERVICE_NOT_FOUND');
    }
  });

  it('同名重复注册抛 CONTEXT_SERVICE_EXISTS', () => {
    const scope = silentRoot();
    scope.provide('demo-dup', 1);
    try {
      scope.provide('demo-dup', 2);
      expect.unreachable('重复注册应抛错');
    } catch (err) {
      expect((err as AppError).code).toBe('CONTEXT_SERVICE_EXISTS');
    }
  });

  it('作用域 dispose 自动注销其注册的服务', async () => {
    const root = silentRoot();
    const plugin = root.fork({ name: 'apps-a' });
    plugin.provide('plugin-a-svc', 'value');
    expect(root.get('plugin-a-svc')).toBe('value');
    await plugin.dispose();
    expect(() => root.get('plugin-a-svc')).toThrowError(/未注册/);
  });

  // 软依赖探测（2026-08-23 生态读码补钉 dsh-4）：缺 = 明确 undefined，禁轮询禁鸭子探测
  it('tryGet：已注册返回实现；未注册返回 undefined 不抛错', () => {
    const scope = silentRoot();
    const off = scope.provide('optional-svc', { n: 7 });
    expect(scope.tryGet<{ n: number }>('optional-svc')?.n).toBe(7);
    expect(scope.tryGet('missing-svc')).toBeUndefined();
    off();
    expect(scope.tryGet('optional-svc')).toBeUndefined(); // 注销后同样软缺，不抛
  });
});

describe('provide 服务名两段式分级（契约篇 §1.5，2026-08-27 第三十三批 P2-1）', () => {
  it('官方名位（根作用域）：单段小写名通过；斜杠形/非法字符拒', () => {
    const root = silentRoot();
    root.provide('agent', 1); // 单段小写——官方自留地
    root.provide('fetch-2', 2); // 连字符/数字合法
    for (const bad of ['acme/store', 'Agent', 'a_b', 'demo.svc', '']) {
      try {
        root.provide(bad, 1);
        expect.unreachable(`官方名位应拒 ${bad}`);
      } catch (err) {
        expect((err as AppError).code).toBe('CONTEXT_SERVICE_NAME_INVALID');
      }
    }
  });

  it('第三方行（fork builtinRow:false）：恰一 / 域前缀通过；单段名/多斜杠/非法段拒', () => {
    const root = silentRoot();
    const third = root.fork({ name: 'row-x', rowId: 'row-x', builtinRow: false });
    third.provide('acme/store', 1); // 恰一斜杠两段——第三方正形
    third.provide('fx/taps-1', 2); // 段内连字符数字合法
    for (const bad of ['agent', 'acme/store/extra', 'Acme/store', 'acme/', '/store', 'acme//store']) {
      try {
        third.provide(bad, 1);
        expect.unreachable(`第三方行应拒 ${bad}`);
      } catch (err) {
        expect((err as AppError).code).toBe('CONTEXT_SERVICE_NAME_INVALID');
      }
    }
  });

  it('行籍旗标 fork 级联：官方行内再 fork 保持官方名位；报文带行 id 归因', () => {
    const root = silentRoot();
    // 官方行 fork 后应用内再 fork——行籍级联继承（与 rowId 同律）
    const officialDeep = root.fork({ name: 'apps-c', rowId: 'chat', builtinRow: true }).fork({ name: 'inner' });
    expect(officialDeep.builtinRow).toBe(true);
    officialDeep.provide('agent', 1); // 深层官方名位仍收单段名
    // 第三方行内再 fork 同理保持第三方
    const thirdDeep = root.fork({ name: 'apps-d', rowId: 'plug-x', builtinRow: false }).fork({ name: 'inner' });
    expect(thirdDeep.builtinRow).toBe(false);
    try {
      thirdDeep.provide('agent', 1);
      expect.unreachable('第三方深层 fork 应拒单段名');
    } catch (err) {
      const appErr = err as AppError;
      expect(appErr.code).toBe('CONTEXT_SERVICE_NAME_INVALID');
      expect(appErr.message).toContain('plug-x'); // 报文带行 id——装载期可归因到行
    }
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
      () => scope.provide('svc-after', 1),
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
    // 归因错列场景：root emit、应用 B 的监听器炸——日志必须指向 B
    const root = createContext({ logger: createLogger({ module: 'test', level: 'debug', sink }) });
    registerLiveEvent(root, { name: 'evt/boom', mode: 'emit', note: '测试词汇' });
    const appB = root.fork({ name: 'apps-b' });
    appB.on('evt/boom', () => {
      throw new Error('handler boom');
    });
    root.emit('evt/boom');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as { event: string; owner: string; error: string };
    expect(record.event).toBe('evt/boom');
    expect(record.owner).toBe('root:apps-b'); // 注册方（修复前错记 emit 方 'root'）
    expect(record.error).toContain('handler boom');
    expect(record.error).toContain('at '); // 完整 stack 而非 String(err)
  });

  it('fork 级联回卷：根 dispose 自动回卷子作用域（宿主忘显式 dispose 也兜底）', async () => {
    const root = silentRoot();
    const child = root.fork({ name: 'apps-a' });
    child.provide('plugin-a-svc', 'v');
    await root.dispose();
    // 子作用域已随根回卷：服务注销 + 子作用域进入 stale 态
    expect(root.tryGet('plugin-a-svc')).toBeUndefined();
    expect(() => child.provide('late-svc', 1)).toThrowError(AppError);
    expect(child.signal.aborted).toBe(true);
  });

  it('logger setLevel 沿子树级联：child 继承创建时快照、父调级后随之', () => {
    const { lines, sink } = captureSink();
    const parent = createLogger({ module: 'test', level: 'error', sink });
    const child = parent.child('mod');
    child.debug('调级前不可见'); // error 阈值下被过滤
    expect(lines).toHaveLength(0);
    parent.setLevel('debug');
    child.debug('调级后可见'); // 级联生效——不级联则应用日志永远按创建时旧阈值过滤
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
    const appScope = anchor.fork({ name: 'p' });
    // 加载器形态：词汇登记经 effect 挂派生作用域栈（装载阶段①的真实接线方式）
    appScope.effect(() => registerLiveEvent(anchor, { name: 'p/done', mode: 'emit', note: '测试词汇' }));
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

describe('dispose 语义升级（CR-2-F8 + §1.6 时钟族，2026-08-27 刀〇a）', () => {
  it('异步 disposer 被 dispose 等待：Disposer 契约型不变，返回 thenable 即等其结算', async () => {
    const scope = silentRoot();
    const done: string[] = [];
    // 异步清理：500ms 后标记完成——旧实现（同步循环不等待）会在它结算前就跑完 dispose
    scope.effect(
      () => () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            done.push('async-clean');
            resolve();
          }, 30);
        }) as unknown as void,
    );
    scope.effect(() => () => done.push('sync-clean'));
    await scope.dispose();
    // 同步条（LIFO 先弹）先执行；异步条被等待到结算后才继续——两序都在 dispose 返回前完成
    expect(done).toEqual(['sync-clean', 'async-clean']);
  });

  it('挂起 disposer 触发回卷竞速时钟：超时弃等继续下一条，整树回卷不卡死（§1.6 时钟缺省 1s，此处注小值）', async () => {
    const scope = createContext({
      logger: createLogger({ module: 'test', level: 'silent' }),
      disposeTimeoutMs: 20, // 小钟：20ms 即放弃等待
    });
    const done: string[] = [];
    // 永挂 disposer（永不 resolve——挂起转化条款的目标形态）
    scope.effect(() => () => new Promise<void>(() => {}) as unknown as void);
    scope.effect(() => () => done.push('after-hang'));
    const startedAt = Date.now();
    await scope.dispose();
    // 挂起条被放弃后，下一条照常回卷；总时长受小钟约束（< 1s，远小于 vitest 默认 5s）
    expect(done).toEqual(['after-hang']);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('fork 级联回卷被父 dispose 等待（子树异步清理完成后父才继续）', async () => {
    const scope = silentRoot();
    const done: string[] = [];
    const child = scope.fork({ name: 'child' });
    child.effect(
      () => () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            done.push('child-clean');
            resolve();
          }, 30);
        }) as unknown as void,
    );
    scope.effect(() => () => done.push('parent-clean'));
    await scope.dispose();
    // LIFO 序：parent-clean（后注册先弹）→ 级联 disposer（child.dispose）；
    // 验证点 = 级联被**等待**——dispose 返回时子树异步清理已结算（旧实现不等待，
    // child-clean 会缺席）
    expect(done).toEqual(['parent-clean', 'child-clean']);
  });
});

describe('事件派发频率护栏（§1.6 时钟族，2026-08-27 刀〇a）', () => {
  /** 小桶根作用域：容量 3、每分钟回填 6 万（≈ 即时回满——回落语义可测） */
  function tinyBucketRoot() {
    return createContext({
      logger: createLogger({ module: 'test', level: 'silent' }),
      rateLimit: { capacity: 3, perMinute: 60_000 },
    });
  }

  /**
   * 计费锚点重铸（刀〇b B-1 root 豁免）：宿主根作用域派发免计费后，计费断言
   * 一律锚在 fork 作用域上（应用永不持有 root——fork 派生新名是结构性保证）。
   * 词汇注册锚在宿主根上（runtime 全体作用域共享——fork 与 root 同词汇表）。
   */
  function tinyBucketHostAndFork(): {
    host: ReturnType<typeof tinyBucketRoot>;
    scope: ReturnType<typeof tinyBucketRoot>;
  } {
    const host = tinyBucketRoot();
    return { host, scope: host.fork({ name: 'charger' }) };
  }

  it('桶满 fail-loud：APP_EVENT_RATE 抛错（非静默丢弃），回填后恢复可发', async () => {
    const { host, scope } = tinyBucketHostAndFork();
    registerLiveEvent(host, { name: 'test/evt', mode: 'emit', note: '测试词汇' });
    const seen: number[] = [];
    scope.on('test/evt', (n: number) => seen.push(n));
    scope.emit('test/evt', 1);
    scope.emit('test/evt', 2);
    scope.emit('test/evt', 3); // 容量 3：至此桶空
    expect(seen).toEqual([1, 2, 3]);
    expect(() => scope.emit('test/evt', 4)).toThrowError(AppError);
    try {
      scope.emit('test/evt', 5);
    } catch (err) {
      expect((err as AppError).code).toBe('APP_EVENT_RATE');
    }
    // 超限那次未送达（fail-loud ≠ 静默丢弃——抛错即拒发）
    expect(seen).toEqual([1, 2, 3]);
    // 回填：perMinute 6 万 → 1ms 回满 1 令牌以上，稍候即恢复
    await new Promise((resolve) => setTimeout(resolve, 5));
    scope.emit('test/evt', 6);
    expect(seen).toEqual([1, 2, 3, 6]);
  });

  it('四派发模式统一计费：waterfall 派发同样占桶（执法面不分模式）', async () => {
    const { host, scope } = tinyBucketHostAndFork();
    registerLiveEvent(host, { name: 'test/chain', mode: 'waterfall', note: '测试词汇' });
    // 耗掉 3 令牌
    await scope.waterfall('test/chain', () => 'ok');
    await scope.waterfall('test/chain', () => 'ok');
    await scope.waterfall('test/chain', () => 'ok');
    // 第 4 次 waterfall 派发撞桶
    await expect(scope.waterfall('test/chain', () => 'ok')).rejects.toMatchObject({
      code: 'APP_EVENT_RATE',
    });
  });

  it('per-scope 分桶：应用作用域打满不影响宿主根作用域（失控隔离半径 = 单作用域）', () => {
    const scope = tinyBucketRoot();
    registerLiveEvent(scope, { name: 'test/evt', mode: 'emit', note: '测试词汇' });
    const plugin = scope.fork({ name: 'naughty' });
    // 应用作用域 3 连发打满自己的桶
    plugin.emit('test/evt', 1);
    plugin.emit('test/evt', 2);
    plugin.emit('test/evt', 3);
    expect(() => plugin.emit('test/evt', 4)).toThrowError(AppError);
    // 宿主根作用域独立桶：照常可发
    expect(() => scope.emit('test/evt', 'host-ok')).not.toThrow();
  });

  it('B-1 root 豁免（刀〇b 冷读裁决）：宿主根作用域派发免计费、打点照计——镜像/tools_change 大流量不触顶', () => {
    // 回归锁：durable→总线的 session/event 镜像与 tools_change 变更广播都在
    // root 面派发（assembly onLiveEvent / registry 两写点）——豁免前 root 桶是
    // 全部会话流量的复用汇，合法子代理舰队即触顶且 APP_EVENT_RATE 在宿主
    // 写路径内爆炸（persistence sink → session.append）
    const scope = tinyBucketRoot(); // 容量仅 3
    registerLiveEvent(scope, { name: 'test/evt', mode: 'emit', note: '测试词汇' });
    const seen: number[] = [];
    scope.on('test/evt', (n: number) => seen.push(n));
    // 远超容量的宿主面流量：不抛（豁免）、全送达
    for (let i = 0; i < 50; i++) scope.emit('test/evt', i);
    expect(seen.length).toBe(50);
    // 打点照计：root 免扣桶不免计量（负载数据完整）
    expect(eventDispatchStats(scope).get('root')).toBe(50);
    // 同根下应用作用域照常计费（豁免半径 = root 名，不含 fork 派生名）
    const plugin = scope.fork({ name: 'still-charged' });
    plugin.emit('test/evt', 1);
    plugin.emit('test/evt', 2);
    plugin.emit('test/evt', 3);
    expect(() => plugin.emit('test/evt', 4)).toThrowError(AppError);
  });

  it('词汇执法先行于频率执法：拼错名报 EVENT_UNKNOWN 而非限流噪音', () => {
    const { scope } = tinyBucketHostAndFork();
    try {
      scope.emit('not/registered' as never);
      expect.unreachable('未注册词汇应抛');
    } catch (err) {
      expect((err as AppError).code).toBe('EVENT_UNKNOWN');
    }
  });

  it('打点面：eventDispatchStats 按作用域累计派发数（B2 P5——只增不清零，诊断面读）', async () => {
    const scope = tinyBucketRoot();
    registerLiveEvent(scope, { name: 'test/evt', mode: 'emit', note: '测试词汇' });
    registerLiveEvent(scope, { name: 'test/chain', mode: 'waterfall', note: '测试词汇' });
    const plugin = scope.fork({ name: 'p1' });
    plugin.emit('test/evt', 1);
    plugin.emit('test/evt', 2);
    await scope.waterfall('test/chain', () => 'ok');
    const stats = eventDispatchStats(scope);
    expect(stats.get('root:p1')).toBe(2);
    expect(stats.get('root')).toBe(1);
  });
});

describe('注册计数帽（§1.6 资源护栏族 #9，2026-08-27 刀〇b）', () => {
  it('在册 effect 达 10^4 抛 CONTEXT_EFFECT_LIMIT；注销即减（活注册基准非历史累计）', () => {
    const scope = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
    // 前 10^4 个注册合法（一条箭头函数 disposer 即一条在册 effect）
    const disposers: Array<() => void> = [];
    for (let i = 0; i < 10_000; i++) {
      disposers.push(scope.effect(() => () => {}));
    }
    // 第 10^4+1 条：CONTEXT_EFFECT_LIMIT fail-loud
    try {
      scope.effect(() => () => {});
      expect.unreachable('超帽注册应抛');
    } catch (err) {
      expect((err as AppError).code).toBe('CONTEXT_EFFECT_LIMIT');
    }
    // 手动注销两条即腾出两条额度（活注册基准）
    disposers.pop()!();
    disposers.pop()!();
    expect(() => scope.effect(() => () => {})).not.toThrow();
    expect(() => scope.effect(() => () => {})).not.toThrow();
    expect(() => scope.effect(() => () => {})).toThrowError(AppError);
  });

  it('注册族同钟：on/provide/registerMessageRole 同占额度（pushEffect 单点执法）', () => {
    const scope = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
    registerLiveEvent(scope, { name: 'test/evt', mode: 'emit', note: '测试词汇' });
    // effect 先耗 9_999 条（帽缺省钉 10^4，不可注入——按缺省帽构造边界）
    for (let i = 0; i < 9_999; i++) scope.effect(() => () => {});
    // on 内部走 effect：第 10_000 条合法占满
    scope.on('test/evt', () => {});
    // provide 的注销器同样入栈：第 10_001 条撞帽
    try {
      scope.provide('svc-x', {});
      expect.unreachable('provide 超帽应抛');
    } catch (err) {
      expect((err as AppError).code).toBe('CONTEXT_EFFECT_LIMIT');
    }
  });
});

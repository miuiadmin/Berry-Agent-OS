/**
 * bridge — BridgeEndpoint 协议语义测试（契约篇 §1.7 桥接协议 v0）。
 *
 * 载体用 node:worker_threads MessageChannel 端口对（同线程、结构化克隆语义
 * 与真 worker 一致）——K3-a 不起真 worker（worker bootstrap 是 K3-b 的接线面）。
 * 每条用例锚定协议的一条语义条款；PoC 补票（eee3e45）的桩语义在此产品化为
 * 回归锁：迟到纪律、本地结算不等往返、取消消息化。
 */
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { PassThrough } from 'node:stream';
import { AppError, APP_CONFIG_INVALID, BRIDGE_HANDLER_FAILED, BRIDGE_WORKER_EXITED } from '../contracts/errors.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeEndpoint, type BridgeEndpointOptions, type BridgePort } from './session.js';
import { StdioBridgePort } from './port-stdio.js';

/** 本文件全部开过的端口——afterEach 统一收口（防事件循环悬挂） */
const openPorts: MessagePort[] = [];

afterEach(() => {
  for (const p of openPorts) p.close();
  openPorts.length = 0;
});

/**
 * 搭一对经 MessageChannel 相连的端点（端口自动登记收口）。
 * 两侧选项各自透传——协议对称，无角色区分。
 */
function makePair(optsA: BridgeEndpointOptions = {}, optsB: BridgeEndpointOptions = {}) {
  const { port1, port2 } = new MessageChannel();
  openPorts.push(port1, port2);
  const a = new BridgeEndpoint(toBridgePort(port1), optsA);
  const b = new BridgeEndpoint(toBridgePort(port2), optsB);
  return { a, b, port1, port2 };
}

/** MessagePort 结构性满足 BridgePort（结构化类型兼容——收窄给 TS 看的门面） */
function toBridgePort(port: MessagePort): BridgePort {
  return { postMessage: (m) => port.postMessage(m), on: (e, l) => port.on(e, l) };
}

describe('BridgeEndpoint：ask/result 往返', () => {
  it('双向调用各自成立（callId 两方向独立编号、按 kind 分派无歧义——回归锁）', async () => {
    const { a, b } = makePair();
    a.handle('host', 'svc', () => '来自a');
    b.handle('worker', 'svc', () => '来自b');
    // 两方向都从 callId=1 起号——同号 ask/result/cancel 在同一载体上无歧义
    expect(await a.call('worker', 'svc', [])).toBe('来自b');
    expect(await b.call('host', 'svc', [])).toBe('来自a');
  });

  it('参数数组过界并原样抵达处理器', async () => {
    const { a, b } = makePair();
    const seen: unknown[][] = [];
    b.handle('svc', 'echo', (args) => {
      seen.push(args);
      return { echo: args };
    });
    const out = await a.call('svc', 'echo', [1, 'x', { k: true }]);
    expect(seen[0]).toEqual([1, 'x', { k: true }]);
    expect(out).toEqual({ echo: [1, 'x', { k: true }] });
  });

  it('无处理方即以 BRIDGE_METHOD_NOT_FOUND 拒绝（宁响亮不静默）', async () => {
    const { a } = makePair();
    const err = await a.call('不存在的', '方法', []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('BRIDGE_METHOD_NOT_FOUND');
  });
});

describe('BridgeEndpoint：错误信封', () => {
  it('AppError 家族词保码过界（code 原样回卷为 AppError）', async () => {
    const { a, b } = makePair();
    b.handle('svc', 'boom', () => {
      throw new AppError(APP_CONFIG_INVALID, '配置非法');
    });
    const err = await a.call('svc', 'boom', []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('APP_CONFIG_INVALID');
    expect((err as AppError).message).toContain('配置非法');
  });

  it('非 AppError 异常入桶 BRIDGE_HANDLER_FAILED（message 保原文）', async () => {
    const { a, b } = makePair();
    b.handle('svc', 'boom', () => {
      throw new Error('普通炸');
    });
    const err = await a.call('svc', 'boom', []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('BRIDGE_HANDLER_FAILED');
    expect((err as AppError).message).toContain('普通炸');
  });

  it('处理器抛错时错误信封带对端归因前缀（哪个域出的错一眼可辨）', async () => {
    const { a, b } = makePair({}, { origin: { workerId: 'w-域1', app: 'demo' } });
    b.handle('svc', 'boom', () => {
      throw new Error('域内错');
    });
    const err = (await a.call('svc', 'boom', []).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toContain('w-域1');
    expect(err.message).toContain('demo');
  });
});

describe('BridgeEndpoint：取消消息化（PoC ④ 桩语义回归锁）', () => {
  it('abort → 本地立即结算 BRIDGE_CANCELLED + 对端入站信号掐断 + 迟到 result 丢弃', async () => {
    const dropped: string[] = [];
    const { a, b } = makePair({ onDropped: (m) => dropped.push(m.kind) });

    let inboundSignal: AbortSignal | undefined;
    b.handle('slow', 'run', (_args, signal) => {
      inboundSignal = signal;
      // 协作式处理器：守 signal 契约，但故意迟 500ms 才收尾——
      // 若结算在对端往返之后，本地结算断言（<400ms）必失败
      return new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            setTimeout(() => resolve({ stopped: true }), 500);
          },
          { once: true },
        );
      });
    });

    const ac = new AbortController();
    const caught = a.call('slow', 'run', [], { signal: ac.signal }).catch((e: unknown) => e);
    const t0 = Date.now();
    ac.abort();
    const err = (await caught) as AppError;
    // 本地结算不等对端往返（对端 500ms 后才回 result——本地路径是同步监听器
    // + 微任务，400ms 上界给调度留足裕度仍远小于对端延迟）
    expect(Date.now() - t0).toBeLessThan(400);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('BRIDGE_CANCELLED');
    // 对端入站调用随后被 cancel 掐断（signal 契约翻译）
    await vi.waitFor(() => expect(inboundSignal?.aborted).toBe(true));
    // 对端 150ms 后的迟到 result 到达本端 → 丢弃分支吸收（不复活、不二次结算）
    await vi.waitFor(() => expect(dropped).toContain('result'), { timeout: 1000 });
  });

  it('迟到 cancel（入站调用已不在簿记）走丢弃观测不炸', async () => {
    const dropped: string[] = [];
    const { port1, port2 } = new MessageChannel();
    openPorts.push(port1, port2);
    new BridgeEndpoint(toBridgePort(port1), { onDropped: (m) => dropped.push(m.kind) });
    // 直接从对端裸发 cancel——a 侧无该入站条目
    port2.postMessage({ kind: 'cancel', callId: 999 });
    await vi.waitFor(() => expect(dropped).toContain('cancel'));
  });
});

describe('BridgeEndpoint：在途超时', () => {
  it('timeoutMs 到点 → 本地结算 BRIDGE_CALL_TIMEOUT + 发 cancel 掐对端', async () => {
    const { a, b } = makePair();
    let inboundAborted = false;
    b.handle('slow', 'hang', (_args, signal) => {
      // 挂死处理器：永不 resolve（紧密同步循环的近似）——簿记侧仍应被掐
      signal.addEventListener('abort', () => {
        inboundAborted = true;
      });
      return new Promise(() => {});
    });
    const err = (await a.call('slow', 'hang', [], { timeoutMs: 15 }).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('BRIDGE_CALL_TIMEOUT');
    await vi.waitFor(() => expect(inboundAborted).toBe(true));
  });
});

describe('BridgeEndpoint：域死结算（dispose）', () => {
  it('在途调用以 BRIDGE_WORKER_EXITED 结算，此后新调用即刻拒绝', async () => {
    const { a, b } = makePair();
    b.handle('slow', 'hang', () => new Promise(() => {}));
    const caught = a.call('slow', 'hang', []).catch((e: unknown) => (e as AppError).code);
    a.dispose('测试模拟域死');
    expect(await caught).toBe('BRIDGE_WORKER_EXITED');
    // dispose 后新调用即刻拒绝（不进载体）
    const again = await a.call('slow', 'hang', []).catch((e: unknown) => (e as AppError).code);
    expect(again).toBe('BRIDGE_WORKER_EXITED');
  });

  it('dispose 后入站消息走丢弃观测', async () => {
    const dropped: string[] = [];
    const { port1, port2 } = new MessageChannel();
    openPorts.push(port1, port2);
    const a = new BridgeEndpoint(toBridgePort(port1), { onDropped: (m) => dropped.push(m.kind) });
    a.dispose('先收尾');
    port2.postMessage({ kind: 'tell', event: 'app/x', payload: null });
    await vi.waitFor(() => expect(dropped).toContain('tell'));
  });

  it('dispose 掐断本端入站在途调用的取消信号（执行侧域死——守 signal 契约的处理器可自收尾）', async () => {
    const { a, b } = makePair();
    let inboundSignal: AbortSignal | undefined;
    b.handle('slow', 'hang', (_args, signal) => {
      inboundSignal = signal;
      return new Promise(() => {});
    });
    a.call('slow', 'hang', []).catch(() => {});
    await vi.waitFor(() => expect(inboundSignal).toBeDefined());
    // 入站控制器住 b（执行侧）——b 域死时掐自己簿记里的在途处理器
    b.dispose('执行域死——掐断在途处理器');
    expect(inboundSignal?.aborted).toBe(true);
    // 调用侧结算由调用侧自己的 dispose/超时负责（真接线里 = 宿主监听 worker
    // exit 后 dispose——K3-c 生命周期编舞的辖区），此处收尾防悬挂
    a.dispose('测试收尾');
  });
});

describe('BridgeEndpoint：单向通知 tell', () => {
  it('tell fire-and-forget 抵达对端 onTell（event 用宿主事件词汇）', async () => {
    const told: Array<{ event: string; payload: unknown }> = [];
    const { a } = makePair({}, { onTell: (event, payload) => told.push({ event, payload }) });
    a.tell('app/demo/thing', { n: 1 });
    await vi.waitFor(() => expect(told).toEqual([{ event: 'app/demo/thing', payload: { n: 1 } }]));
  });
});

describe('BridgeEndpoint：心跳冻结检测', () => {
  it('对端无应答 → 连续丢拍超限一次性 onFreeze 并停表', async () => {
    const freezes: Array<{ missed: number }> = [];
    const { port1, port2 } = new MessageChannel();
    openPorts.push(port1, port2);
    new BridgeEndpoint(toBridgePort(port1), {
      heartbeatMs: 5,
      heartbeatMissLimit: 2,
      onFreeze: (info) => freezes.push(info),
    });
    // port2 不包端点 = 永远不应答 → 冻结
    await vi.waitFor(() => expect(freezes.length).toBe(1));
    expect(freezes[0]?.missed ?? 0).toBeGreaterThan(2);
    // 一次性：停表后不再触发
    await new Promise((r) => setTimeout(r, 30));
    expect(freezes.length).toBe(1);
  });

  it('对端活体应答 ping → 不冻结（必答语义走真往返）', async () => {
    const freezes: unknown[] = [];
    const { a } = makePair({
      // missLimit=8：冻结需连续 9 拍无 pong（≈45ms 完全阻塞）——负载尖峰下
      // 偶发排队不至假冻结；而窗口 100ms = 20 拍 > 9，持续哑场仍会触发，
      // 断言保持非平凡
      heartbeatMs: 5,
      heartbeatMissLimit: 8,
      onFreeze: () => freezes.push(1),
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(freezes.length).toBe(0);
    a.stopHeartbeat();
  });
});

/* ---------------- 消息级编码失败分桶（20260901-c #4 修死） ---------------- */

/**
 * 搭一对 JSON 通道端点（StdioBridgePort × PassThrough）：编码失败面
 * （BigInt/循环引用——JSON.stringify 抛）只有这条腿有，MessageChannel 腿
 * 结构化克隆对 BigInt/循环引用天然可过（两腿失败集不同，契约篇 §1.7）。
 */
function makeJsonPair(optsA: BridgeEndpointOptions = {}, optsB: BridgeEndpointOptions = {}) {
  const ab = new PassThrough(); // A→B 向
  const ba = new PassThrough(); // B→A 向
  const a = new BridgeEndpoint(new StdioBridgePort(ba, ab), optsA);
  const b = new BridgeEndpoint(new StdioBridgePort(ab, ba), optsB);
  return { a, b };
}

describe('BridgeEndpoint：载荷不可编码的失败分桶（20260901-c #4）', () => {
  it('ask 参数不可编码 → 只结算该调用（BRIDGE_ENCODE_FAILED），端点不 dispose——同端点后续调用照常（修前：坏一条消息株连全端点 dispose）', async () => {
    const { a, b } = makeJsonPair();
    b.handle('svc', 'echo', (args) => ({ got: args[0] }));
    // BigInt 过不了 JSON.stringify——消息级编码失败
    const err = await a.call('svc', 'echo', [10n]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('BRIDGE_ENCODE_FAILED');
    // 端点活着：后续好调用照常往返（修前此处 BRIDGE_WORKER_EXITED——dispose 已株连）
    await expect(a.call('svc', 'echo', ['ok'])).resolves.toEqual({ got: 'ok' });
    expect(a.isDisposed).toBe(false);
    expect(a.pendingCount).toBe(0); // 坏调用簿记已清
  });

  it('处理方返回值不可编码 → 降级错误信封回应（对端不挂死），端点不 dispose', async () => {
    const { a, b } = makeJsonPair();
    b.handle('svc', 'big', () => 99n); // 返回值过不了 JSON——result 帧编码失败
    const err = await a.call('svc', 'big', []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(BRIDGE_HANDLER_FAILED);
    expect((err as AppError).message).toContain('不可编码');
    expect(b.isDisposed).toBe(false);
    // 端点活着：同 handler 路后续好往返照常
    b.handle('svc', 'fine', () => 'good');
    await expect(a.call('svc', 'fine', [])).resolves.toBe('good');
  });

  it('tell 载荷不可编码 → 单消息丢弃（onDropped 可观测）不 dispose；后续 tell 照达', async () => {
    const dropped: unknown[] = [];
    const tells: unknown[] = [];
    const { a } = makeJsonPair({ onDropped: (m) => dropped.push(m) }, { onTell: (_e, p) => tells.push(p) });
    a.tell('log', { v: 1n }); // fire-and-forget：丢单是正确语义
    a.tell('log', { v: 'good' });
    await new Promise((r) => setTimeout(r, 30)); // 流异步面到达
    expect(dropped.length).toBe(1);
    expect((dropped[0] as { kind: string }).kind).toBe('tell');
    expect(tells).toEqual([{ v: 'good' }]);
    expect(a.isDisposed).toBe(false);
  });

  it('载体真死（非编码型抛错）→ 仍按域死 dispose 收尾（fail-loud 不随本修窄化）', async () => {
    // postMessage 抛非 BRIDGE_ENCODE_FAILED 错误 = 载体级失败（端口已死形态）
    const bad = new BridgeEndpoint(
      {
        postMessage() {
          throw new Error('EPIPE-ish 载体已死');
        },
        on() {},
      },
      {},
    );
    const err = await bad.call('svc', 'x', []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(BRIDGE_WORKER_EXITED); // 域死结算（在途全结算）
    expect(bad.isDisposed).toBe(true);
  });
});

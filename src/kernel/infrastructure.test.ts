import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { composeSendChain, composeEmitChain, createMetricsMiddleware, createLoggingMiddleware } from './middleware.js';
import type { Middleware } from './middleware.js';
import { setPolicy, getPolicy, clearPolicies, matchesPattern } from './bus-policies.js';
import { createStallWatchdog } from './stall-watchdog.js';
import { MessageBus } from './message-bus.js';
import type { MessageType } from '../contracts/messages.js';

describe('Middleware chain', () => {
  it('executes send middleware in order (onion model)', async () => {
    const order: string[] = [];
    const mw1: Middleware = {
      name: 'first',
      onSend: async (_type, _payload, _ctx, next) => {
        order.push('first-before');
        const r = await next();
        order.push('first-after');
        return r;
      },
    };
    const mw2: Middleware = {
      name: 'second',
      onSend: async (_type, _payload, _ctx, next) => {
        order.push('second-before');
        const r = await next();
        order.push('second-after');
        return r;
      },
    };

    const chain = composeSendChain([mw1, mw2], async () => {
      order.push('handler');
      return 'result';
    });

    const result = await chain('test' as MessageType, {}, {});
    expect(result).toBe('result');
    expect(order).toEqual(['first-before', 'second-before', 'handler', 'second-after', 'first-after']);
  });

  it('skips middleware without onSend', async () => {
    const mw: Middleware = { name: 'noop' };
    const chain = composeSendChain([mw], async () => 'ok');
    expect(await chain('test' as MessageType, {}, {})).toBe('ok');
  });

  it('executes emit middleware in order', () => {
    const order: string[] = [];
    const mw1: Middleware = {
      name: 'first',
      onEmit: (_type, _payload, next) => {
        order.push('first-before');
        next();
        order.push('first-after');
      },
    };
    const mw2: Middleware = {
      name: 'second',
      onEmit: (_type, _payload, next) => {
        order.push('second-before');
        next();
        order.push('second-after');
      },
    };

    const chain = composeEmitChain([mw1, mw2], () => {
      order.push('handler');
    });

    chain('test' as MessageType, {});
    expect(order).toEqual(['first-before', 'second-before', 'handler', 'second-after', 'first-after']);
  });

  it('empty middleware list passes through directly', async () => {
    const sendChain = composeSendChain([], async () => 42);
    expect(await sendChain('t' as MessageType, {}, {})).toBe(42);

    let called = false;
    const emitChain = composeEmitChain([], () => { called = true; });
    emitChain('t' as MessageType, {});
    expect(called).toBe(true);
  });

  it('middleware can short-circuit by not calling next', async () => {
    const mw: Middleware = {
      name: 'blocker',
      onSend: async () => 'blocked',
    };
    const chain = composeSendChain([mw], async () => 'never');
    expect(await chain('t' as MessageType, {}, {})).toBe('blocked');
  });

  it('createMetricsMiddleware does not throw', async () => {
    const mw = createMetricsMiddleware();
    expect(mw.name).toBe('metrics');
    const chain = composeSendChain([mw], async () => 'ok');
    await expect(chain('test' as MessageType, {}, {})).resolves.toBe('ok');
  });

  it('createLoggingMiddleware does not throw', async () => {
    const mw = createLoggingMiddleware('trace');
    expect(mw.name).toBe('logging');
    const chain = composeSendChain([mw], async () => 'ok');
    await expect(chain('test' as MessageType, {}, {})).resolves.toBe('ok');
  });
});

describe('Bus policies', () => {
  beforeEach(() => clearPolicies());

  it('returns default policy for unknown types', () => {
    const p = getPolicy('unknown.type');
    expect(p.timeoutMs).toBe(30_000);
    expect(p.priority).toBe('normal');
  });

  it('stores and retrieves custom policy', () => {
    setPolicy('socket:message' as MessageType, { timeoutMs: 120_000, priority: 'high' });
    const p = getPolicy('socket:message' as MessageType);
    expect(p.timeoutMs).toBe(120_000);
    expect(p.priority).toBe('high');
  });

  describe('matchesPattern', () => {
    it('exact match', () => {
      expect(matchesPattern('event:task.progress', 'event:task.progress')).toBe(true);
      expect(matchesPattern('event:task.progress', 'event:task.complete')).toBe(false);
    });

    it('wildcard * matches all', () => {
      expect(matchesPattern('anything', '*')).toBe(true);
      expect(matchesPattern('event:task.progress', '*')).toBe(true);
    });

    it('glob-style wildcard in segment', () => {
      expect(matchesPattern('event:task.progress', 'event:task.*')).toBe(true);
      expect(matchesPattern('event:task.complete', 'event:task.*')).toBe(true);
      expect(matchesPattern('event:agent.ready', 'event:task.*')).toBe(false);
    });

    it('wildcard matches within segment (does not cross colon)', () => {
      expect(matchesPattern('event:task.progress', 'event:*')).toBe(true);
      expect(matchesPattern('socket:message', 'socket:*')).toBe(true);
      expect(matchesPattern('event:task:nested', 'event:*')).toBe(false);
    });
  });
});

describe('Stall watchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires onStall after timeout', () => {
    const onStall = vi.fn();
    createStallWatchdog({ label: 'test', timeoutMs: 1000, checkIntervalMs: 250, onStall });

    vi.advanceTimersByTime(900);
    expect(onStall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(onStall).toHaveBeenCalledOnce();
    expect(onStall).toHaveBeenCalledWith(expect.objectContaining({ label: 'test', timeoutMs: 1000 }));
  });

  it('touch() resets the idle timer', () => {
    const onStall = vi.fn();
    const wd = createStallWatchdog({ label: 'test', timeoutMs: 1000, checkIntervalMs: 250, onStall });

    vi.advanceTimersByTime(800);
    wd.touch();
    vi.advanceTimersByTime(900);
    expect(onStall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    expect(onStall).toHaveBeenCalledOnce();
  });

  it('stop() prevents further stall events', () => {
    const onStall = vi.fn();
    const wd = createStallWatchdog({ label: 'test', timeoutMs: 500, checkIntervalMs: 100, onStall });

    wd.stop();
    vi.advanceTimersByTime(2000);
    expect(onStall).not.toHaveBeenCalled();
    expect(wd.isActive()).toBe(false);
  });

  it('only fires once per stall (requires touch to re-arm)', () => {
    const onStall = vi.fn();
    const wd = createStallWatchdog({ label: 'test', timeoutMs: 500, checkIntervalMs: 100, onStall });

    vi.advanceTimersByTime(1500);
    expect(onStall).toHaveBeenCalledOnce();

    wd.touch();
    vi.advanceTimersByTime(600);
    expect(onStall).toHaveBeenCalledTimes(2);
  });
});

describe('MessageBus enhanced features', () => {
  let bus: MessageBus;
  beforeEach(() => { bus = new MessageBus(); });

  it('middleware is applied to send', async () => {
    const order: string[] = [];
    bus.use({
      name: 'test-mw',
      onSend: async (_type, _payload, _ctx, next) => {
        order.push('before');
        const r = await next();
        order.push('after');
        return r;
      },
    });
    bus.handle('test:action' as MessageType, async () => {
      order.push('handler');
      return 'done';
    });

    const result = await bus.send('test:action' as MessageType, {} as any);
    expect(result).toBe('done');
    expect(order).toEqual(['before', 'handler', 'after']);
  });

  it('middleware is applied to emit', () => {
    const emitted: string[] = [];
    bus.use({
      name: 'test-mw',
      onEmit: (_type, _payload, next) => {
        emitted.push('mw');
        next();
      },
    });
    bus.on('event:test' as MessageType, () => emitted.push('listener'));
    bus.emit('event:test' as MessageType, {} as any);
    expect(emitted).toEqual(['mw', 'listener']);
  });

  it('onPattern receives matching events', () => {
    const received: Array<[string, unknown]> = [];
    bus.onPattern('event:task.*', (type, payload) => {
      received.push([type, payload]);
    });

    bus.emit('event:task.progress' as MessageType, { pct: 50 } as any);
    bus.emit('event:task.complete' as MessageType, { ok: true } as any);
    bus.emit('event:agent.ready' as MessageType, {} as any);

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(['event:task.progress', { pct: 50 }]);
    expect(received[1]).toEqual(['event:task.complete', { ok: true }]);
  });

  it('onPattern unsubscribe works', () => {
    const received: string[] = [];
    const unsub = bus.onPattern('*', (type) => received.push(type));

    bus.emit('event:a' as MessageType, {} as any);
    unsub();
    bus.emit('event:b' as MessageType, {} as any);

    expect(received).toEqual(['event:a']);
  });

  it('drain rejects new sends', async () => {
    bus.handle('test:x' as MessageType, async () => 'ok');
    await bus.drain(100);
    await expect(bus.send('test:x' as MessageType, {} as any)).rejects.toThrow('draining');
  });

  it('drain waits for in-flight handlers', async () => {
    let resolveHandler: () => void;
    const handlerDone = new Promise<void>((r) => { resolveHandler = r; });

    bus.handle('test:slow' as MessageType, async () => {
      await handlerDone;
      return 'ok';
    });

    const sendPromise = bus.send('test:slow' as MessageType, {} as any);
    const drainPromise = bus.drain(5000);

    let drained = false;
    drainPromise.then(() => { drained = true; });

    await new Promise((r) => setTimeout(r, 50));
    expect(drained).toBe(false);

    resolveHandler!();
    await sendPromise;
    await drainPromise;
    expect(drained).toBe(true);
  });

  it('isDraining returns correct state', async () => {
    expect(bus.isDraining()).toBe(false);
    bus.handle('x' as MessageType, async () => 'ok');
    await bus.drain();
    expect(bus.isDraining()).toBe(true);
  });
});

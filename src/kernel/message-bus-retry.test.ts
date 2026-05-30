import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageBus } from './message-bus.js';
import { setPolicy, clearPolicies } from './bus-policies.js';
import { BackpressureError, TimeoutError } from './errors.js';
import type { MessageType } from '../contracts/messages.js';

describe('MessageBus retry logic', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
    clearPolicies();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on timeout error with retryCount > 0', async () => {
    let attempts = 0;
    setPolicy('test:retry' as MessageType, { retryCount: 2, retryBackoff: 'fixed', timeoutMs: 5000 });

    bus.handle('test:retry' as MessageType, async () => {
      attempts++;
      if (attempts < 3) throw new TimeoutError('timed out');
      return 'success';
    });

    const promise = bus.send('test:retry' as MessageType, {} as any);
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;

    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    let attempts = 0;
    setPolicy('test:noretry' as MessageType, { retryCount: 3, timeoutMs: 5000 });

    bus.handle('test:noretry' as MessageType, async () => {
      attempts++;
      const err = new Error('permanent failure');
      throw err;
    });

    await expect(bus.send('test:noretry' as MessageType, {} as any)).rejects.toThrow('permanent failure');
    expect(attempts).toBe(1);
  });

  it('retries errors with retryable=true flag', async () => {
    let attempts = 0;
    setPolicy('test:retryable' as MessageType, { retryCount: 1, retryBackoff: 'fixed', timeoutMs: 5000 });

    bus.handle('test:retryable' as MessageType, async () => {
      attempts++;
      if (attempts < 2) {
        const err = Object.assign(new Error('transient'), { retryable: true });
        throw err;
      }
      return 'ok';
    });

    const promise = bus.send('test:retryable' as MessageType, {} as any);
    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('throws after exhausting retries', async () => {
    let attempts = 0;
    setPolicy('test:exhaust' as MessageType, { retryCount: 2, retryBackoff: 'fixed', timeoutMs: 5000 });

    bus.handle('test:exhaust' as MessageType, async () => {
      attempts++;
      throw new TimeoutError('always fails');
    });

    let caughtError: Error | undefined;
    const promise = bus.send('test:exhaust' as MessageType, {} as any).catch((e) => { caughtError = e; });

    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(600);
    await promise;

    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toBe('always fails');
    expect(attempts).toBe(3);
  });

  it('respects retryCount=0 (no retries)', async () => {
    let attempts = 0;
    setPolicy('test:noretry0' as MessageType, { retryCount: 0, timeoutMs: 5000 });

    bus.handle('test:noretry0' as MessageType, async () => {
      attempts++;
      throw new TimeoutError('fail');
    });

    await expect(bus.send('test:noretry0' as MessageType, {} as any)).rejects.toThrow('fail');
    expect(attempts).toBe(1);
  });
});

describe('MessageBus maxPending', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
    clearPolicies();
  });

  it('throws BackpressureError when maxPending exceeded', async () => {
    setPolicy('test:limited' as MessageType, { maxPending: 2, timeoutMs: 5000 });

    let resolvers: Array<() => void> = [];
    bus.handle('test:limited' as MessageType, async () => {
      await new Promise<void>((r) => resolvers.push(r));
      return 'ok';
    });

    const p1 = bus.send('test:limited' as MessageType, {} as any);
    const p2 = bus.send('test:limited' as MessageType, {} as any);

    await expect(bus.send('test:limited' as MessageType, {} as any)).rejects.toThrow(BackpressureError);

    resolvers[0]();
    resolvers[1]();
    await p1;
    await p2;
  });

  it('allows sends after pending count decreases', async () => {
    setPolicy('test:limited2' as MessageType, { maxPending: 1, timeoutMs: 5000 });

    let resolver: () => void;
    bus.handle('test:limited2' as MessageType, async () => {
      await new Promise<void>((r) => { resolver = r; });
      return 'done';
    });

    const p1 = bus.send('test:limited2' as MessageType, {} as any);
    await expect(bus.send('test:limited2' as MessageType, {} as any)).rejects.toThrow(BackpressureError);

    resolver!();
    await p1;

    let resolve2: () => void;
    bus.handle('test:limited2' as MessageType, async () => {
      await new Promise<void>((r) => { resolve2 = r; });
      return 'done2';
    });
    const p2 = bus.send('test:limited2' as MessageType, {} as any);
    resolve2!();
    await expect(p2).resolves.toBe('done2');
  });
});

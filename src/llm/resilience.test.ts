import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker, RateLimiter, ConcurrencySemaphore, getSharedSemaphore, resetSharedSemaphore } from './resilience.js';

describe('CircuitBreaker', () => {
  it('starts closed and allows attempts', () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe('closed');
    expect(cb.canAttempt()).toBe(true);
  });

  it('opens after reaching failure threshold', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 10000 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    expect(cb.canAttempt()).toBe(false);
  });

  it('transitions to half-open after recovery time', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeMs: 50 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');

    vi.useFakeTimers();
    vi.advanceTimersByTime(60);
    // getState() returns internal state; canAttempt() triggers transition
    expect(cb.getState()).toBe('open');
    expect(cb.canAttempt()).toBe(true);
    expect(cb.getState()).toBe('half_open');
    vi.useRealTimers();
  });

  it('closes on success in half-open state', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, recoveryTimeMs: 60000 });
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    expect(cb.canAttempt()).toBe(false);

    // Simulate time passing for recovery
    vi.useFakeTimers();
    vi.advanceTimersByTime(61000);
    expect(cb.canAttempt()).toBe(true);
    expect(cb.getState()).toBe('half_open');
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
    vi.useRealTimers();
  });

  it('re-opens on failure in half-open state', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, recoveryTimeMs: 60000 });
    cb.recordFailure();
    expect(cb.getState()).toBe('open');

    vi.useFakeTimers();
    vi.advanceTimersByTime(61000);
    expect(cb.canAttempt()).toBe(true);
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.useRealTimers();
  });

  it('limits attempts in half-open state to halfOpenMaxAttempts', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, recoveryTimeMs: 50, halfOpenMaxAttempts: 2 });
    cb.recordFailure();
    expect(cb.getState()).toBe('open');

    vi.useFakeTimers();
    vi.advanceTimersByTime(60);
    // First attempt triggers transition and counts as attempt #1
    expect(cb.canAttempt()).toBe(true);
    // Second attempt is still within limit
    expect(cb.canAttempt()).toBe(true);
    // Third attempt exceeds halfOpenMaxAttempts
    expect(cb.canAttempt()).toBe(false);
    vi.useRealTimers();
  });

  it('resets half-open attempts on success allowing future probes', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, recoveryTimeMs: 50, halfOpenMaxAttempts: 1 });
    cb.recordFailure();

    vi.useFakeTimers();
    vi.advanceTimersByTime(60);
    expect(cb.canAttempt()).toBe(true);
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');

    // Trigger another failure cycle
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.advanceTimersByTime(60);
    // Should allow another probe since attempts were reset
    expect(cb.canAttempt()).toBe(true);
    vi.useRealTimers();
  });
});

describe('RateLimiter', () => {
  it('allows requests within limit', async () => {
    const rl = new RateLimiter({ requestsPerMinute: 100 });
    const start = Date.now();
    await rl.acquire();
    await rl.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('waits when tokens exhausted', async () => {
    // 2 RPM = 2 tokens total, refill 1 every 30000ms
    const rl = new RateLimiter({ requestsPerMinute: 2 });
    await rl.acquire();
    await rl.acquire();

    // Third acquire should wait since tokens are at 0
    vi.useFakeTimers();
    const acquirePromise = rl.acquire();
    let resolved = false;
    acquirePromise.then(() => { resolved = true; });

    // Advance partway — should not resolve yet
    await vi.advanceTimersByTimeAsync(15000);
    expect(resolved).toBe(false);

    // Advance enough for 1 token to refill (30000ms total for refill rate of 2/min)
    await vi.advanceTimersByTimeAsync(16000);
    await acquirePromise;
    expect(resolved).toBe(true);
    vi.useRealTimers();
  });

  it('updateLimit changes rate dynamically', () => {
    const rl = new RateLimiter({ requestsPerMinute: 10 });
    rl.updateLimit(100);

    // After updateLimit, maxTokens is 100 and refillRate = 100/60000
    // Exhaust some tokens then verify refill uses new rate
    // The internal state uses the new rate immediately
    expect(true).toBe(true); // updateLimit doesn't throw

    // Verify by acquiring many tokens (only possible if maxTokens was updated)
    const acquires: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      acquires.push(rl.acquire());
    }
    // Should not hang since we have 100 tokens now (minus the 0 already used)
    return Promise.all(acquires);
  });

  it('refills tokens over time', async () => {
    const rl = new RateLimiter({ requestsPerMinute: 60 });
    // 60 RPM = 1 token/sec refill, 60 max tokens
    // Exhaust all tokens
    for (let i = 0; i < 60; i++) {
      await rl.acquire();
    }

    vi.useFakeTimers();
    // After 5 seconds at 1 token/sec, 5 tokens should be available
    vi.advanceTimersByTime(5000);

    // These 5 should resolve immediately
    const start = Date.now();
    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    expect(Date.now() - start).toBeLessThan(10);
    vi.useRealTimers();
  });
});

describe('ConcurrencySemaphore', () => {
  it('allows up to max concurrent acquires', async () => {
    const sem = new ConcurrencySemaphore({ maxConcurrent: 3 });
    await sem.acquire();
    await sem.acquire();
    await sem.acquire();
    expect(sem.getRunning()).toBe(3);
    expect(sem.getQueueLength()).toBe(0);
  });

  it('blocks when max concurrency reached', async () => {
    const sem = new ConcurrencySemaphore({ maxConcurrent: 2 });
    await sem.acquire();
    await sem.acquire();

    let thirdResolved = false;
    const thirdPromise = sem.acquire().then(() => { thirdResolved = true; });

    await Promise.resolve();
    expect(thirdResolved).toBe(false);
    expect(sem.getQueueLength()).toBe(1);

    sem.release();
    await thirdPromise;
    expect(thirdResolved).toBe(true);
    expect(sem.getRunning()).toBe(2);
  });

  it('releases in FIFO order', async () => {
    const sem = new ConcurrencySemaphore({ maxConcurrent: 1 });
    await sem.acquire();

    const order: number[] = [];
    const p1 = sem.acquire().then(() => { order.push(1); });
    const p2 = sem.acquire().then(() => { order.push(2); });
    const p3 = sem.acquire().then(() => { order.push(3); });

    sem.release(); // unblocks p1
    await p1;
    sem.release(); // unblocks p2
    await p2;
    sem.release(); // unblocks p3
    await p3;

    expect(order).toEqual([1, 2, 3]);
  });

  it('uses default maxConcurrent of 10', async () => {
    const sem = new ConcurrencySemaphore();
    for (let i = 0; i < 10; i++) {
      await sem.acquire();
    }
    expect(sem.getRunning()).toBe(10);

    let blocked = false;
    sem.acquire().then(() => { blocked = true; });
    await Promise.resolve();
    expect(blocked).toBe(false);
  });
});

describe('getSharedSemaphore', () => {
  it('returns the same instance on multiple calls', () => {
    resetSharedSemaphore();
    const s1 = getSharedSemaphore({ maxConcurrent: 5 });
    const s2 = getSharedSemaphore({ maxConcurrent: 20 });
    expect(s1).toBe(s2);
    resetSharedSemaphore();
  });
});


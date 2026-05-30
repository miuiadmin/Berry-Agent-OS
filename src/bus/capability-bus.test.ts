import { describe, it, expect, beforeEach } from 'vitest';
import { CapabilityBus } from './capability-bus.js';
import type { CapabilityDescriptor, CapabilityExecutor, InvokeContext } from './contract.js';

function makeCtx(overrides?: Partial<InvokeContext>): InvokeContext {
  return {
    callChain: [],
    sessionId: 'sess-1',
    correlationId: 'corr-1',
    ...overrides,
  };
}

function makeCapability(name: string, dangerLevel: 'safe' | 'moderate' | 'dangerous' = 'safe'): CapabilityDescriptor {
  return {
    name,
    description: `Test capability: ${name}`,
    dangerLevel,
    provider: { type: 'builtin', name: 'test' },
  };
}

describe('CapabilityBus', () => {
  let bus: CapabilityBus;

  beforeEach(() => {
    bus = new CapabilityBus();
  });

  describe('register/discover', () => {
    it('registers and discovers capabilities', () => {
      const executor: CapabilityExecutor = async () => 'ok';
      bus.register(makeCapability('test-cap'), executor);

      expect(bus.has('test-cap')).toBe(true);
      expect(bus.has('nonexistent')).toBe(false);

      const found = bus.discover();
      expect(found).toHaveLength(1);
      expect(found[0].name).toBe('test-cap');
    });

    it('throws on duplicate registration', () => {
      bus.register(makeCapability('dup'), async () => 'a');
      expect(() => bus.register(makeCapability('dup'), async () => 'b')).toThrow('already registered');
    });

    it('unregisters capabilities', () => {
      bus.register(makeCapability('temp'), async () => 'x');
      expect(bus.has('temp')).toBe(true);
      bus.unregister('temp');
      expect(bus.has('temp')).toBe(false);
    });

    it('discovers by query', () => {
      bus.register(makeCapability('safe-cap', 'safe'), async () => 'a');
      bus.register(makeCapability('danger-cap', 'dangerous'), async () => 'b');

      const safe = bus.discover({ dangerLevel: 'safe' });
      expect(safe).toHaveLength(1);
      expect(safe[0].name).toBe('safe-cap');
    });
  });

  describe('invoke', () => {
    it('invokes a registered capability', async () => {
      bus.register(makeCapability('echo'), async (input) => `echo: ${input}`);

      const result = await bus.invoke('echo', 'hello', makeCtx());
      expect(result.ok).toBe(true);
      expect(result.data).toBe('echo: hello');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns error for unregistered capability', async () => {
      const result = await bus.invoke('missing', {}, makeCtx());
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('catches executor errors', async () => {
      bus.register(makeCapability('broken'), async () => { throw new Error('boom'); });

      const result = await bus.invoke('broken', {}, makeCtx());
      expect(result.ok).toBe(false);
      expect(result.error).toBe('boom');
    });

    it('detects call depth overflow', async () => {
      bus.register(makeCapability('deep'), async () => 'ok');

      const chain = Array.from({ length: 16 }, (_, i) => `agent${i}:cap${i}`);
      const result = await bus.invoke('deep', {}, makeCtx({ callChain: chain }));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Call depth exceeded');
    });

    it('detects cycles', async () => {
      bus.register(makeCapability('cyclic'), async () => 'ok');

      const result = await bus.invoke('cyclic', {}, makeCtx({
        callerAgent: 'agent-a',
        callChain: ['agent-a:cyclic'],
      }));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Cycle detected');
    });

    it('respects timeout', async () => {
      bus.register(makeCapability('slow'), async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return 'done';
      });

      const result = await bus.invoke('slow', {}, makeCtx({ timeout: 50 }));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('timed out');
    }, 10000);
  });

  describe('permission gate', () => {
    it('blocks dangerous capabilities without permission', async () => {
      bus.register(makeCapability('danger', 'dangerous'), async () => 'secret');

      bus.setPermissionGate({
        async check() {
          return { allowed: false, reason: 'not authorized', source: 'brain' };
        },
      });

      const result = await bus.invoke('danger', {}, makeCtx());
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Permission denied');
    });

    it('allows safe capabilities without checking gate', async () => {
      bus.register(makeCapability('safe-op', 'safe'), async () => 'public');

      let gateCalled = false;
      bus.setPermissionGate({
        async check() {
          gateCalled = true;
          return { allowed: false, reason: 'should not reach', source: 'brain' };
        },
      });

      const result = await bus.invoke('safe-op', {}, makeCtx());
      expect(result.ok).toBe(true);
      expect(gateCalled).toBe(false);
    });
  });

  describe('invokeAll', () => {
    it('runs capabilities in parallel', async () => {
      bus.register(makeCapability('a'), async () => 'result-a');
      bus.register(makeCapability('b'), async () => 'result-b');

      const results = await bus.invokeAll([
        { name: 'a', input: {} },
        { name: 'b', input: {} },
      ], makeCtx());

      expect(results).toHaveLength(2);
      expect(results[0].ok).toBe(true);
      expect(results[1].ok).toBe(true);
    });
  });

  describe('pipeline', () => {
    it('chains capabilities sequentially', async () => {
      bus.register(makeCapability('double'), async (n) => (n as number) * 2);
      bus.register(makeCapability('add-one'), async (n) => (n as number) + 1);

      const result = await bus.pipeline(3, ['double', 'add-one'], makeCtx());
      expect(result.ok).toBe(true);
      expect(result.data).toBe(7); // (3 * 2) + 1
    });

    it('stops on first error', async () => {
      bus.register(makeCapability('fail'), async () => { throw new Error('stop'); });
      bus.register(makeCapability('never'), async () => 'should not run');

      const result = await bus.pipeline(1, ['fail', 'never'], makeCtx());
      expect(result.ok).toBe(false);
      expect(result.error).toBe('stop');
    });
  });

  describe('race', () => {
    it('returns first successful result', async () => {
      bus.register(makeCapability('slow-win'), async () => {
        await new Promise((r) => setTimeout(r, 100));
        return 'slow';
      });
      bus.register(makeCapability('fast-win'), async () => 'fast');

      const result = await bus.race([
        { name: 'slow-win', input: {} },
        { name: 'fast-win', input: {} },
      ], makeCtx());

      expect(result.ok).toBe(true);
      // Both complete but we return first OK
    });
  });
});

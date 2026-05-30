import { describe, it, expect, beforeEach } from 'vitest';
import {
  traceStore,
  getCurrentTrace,
  withTrace,
  withTraceAsync,
  injectTraceIntoIpc,
  extractTraceFromIpc,
} from './trace-context.js';
import { initTracer } from './tracer.js';
import type { IpcMessage } from '../kernel/types.js';

beforeEach(() => {
  initTracer([]);
});

describe('trace-context', () => {
  describe('getCurrentTrace', () => {
    it('returns undefined outside a trace context', () => {
      expect(getCurrentTrace()).toBeUndefined();
    });

    it('returns context inside withTrace', () => {
      let captured: ReturnType<typeof getCurrentTrace>;
      withTrace('test-op', () => {
        captured = getCurrentTrace();
      });
      expect(captured!).toBeDefined();
      expect(captured!.traceId).toBeTruthy();
      expect(captured!.spanId).toBeTruthy();
    });
  });

  describe('withTrace', () => {
    it('returns the function result', () => {
      const result = withTrace('op', () => 42);
      expect(result).toBe(42);
    });

    it('propagates parent trace to nested calls', () => {
      let parentCtx: ReturnType<typeof getCurrentTrace>;
      let childCtx: ReturnType<typeof getCurrentTrace>;

      withTrace('parent', () => {
        parentCtx = getCurrentTrace();
        withTrace('child', () => {
          childCtx = getCurrentTrace();
        });
      });

      expect(parentCtx!.traceId).toBe(childCtx!.traceId);
      expect(childCtx!.parentSpanId).toBe(parentCtx!.spanId);
      expect(childCtx!.spanId).not.toBe(parentCtx!.spanId);
    });
  });

  describe('withTraceAsync', () => {
    it('works with async functions', async () => {
      const result = await withTraceAsync('async-op', async () => {
        await new Promise(r => setTimeout(r, 1));
        return getCurrentTrace();
      });
      expect(result).toBeDefined();
      expect(result!.traceId).toBeTruthy();
    });
  });

  describe('IPC trace injection/extraction', () => {
    const baseMsg: IpcMessage = {
      id: 'msg-1',
      type: 'user.message',
      from: 'a',
      to: 'b',
      payload: {},
      timestamp: Date.now(),
    };

    it('injects traceId and spanId from current context', () => {
      let injected: IpcMessage;
      withTrace('ipc-test', () => {
        injected = injectTraceIntoIpc(baseMsg);
      });
      expect(injected!.traceId).toBeTruthy();
      expect(injected!.spanId).toBeTruthy();
    });

    it('returns msg unchanged when no context', () => {
      const result = injectTraceIntoIpc(baseMsg);
      expect(result).toBe(baseMsg);
      expect(result.traceId).toBeUndefined();
    });

    it('extractTraceFromIpc returns context when fields present', () => {
      const msg: IpcMessage = { ...baseMsg, traceId: 'trace-abc', spanId: 'span-xyz' };
      const ctx = extractTraceFromIpc(msg);
      expect(ctx).toEqual({ traceId: 'trace-abc', spanId: 'span-xyz', parentSpanId: null });
    });

    it('extractTraceFromIpc returns undefined when fields missing', () => {
      expect(extractTraceFromIpc(baseMsg)).toBeUndefined();
    });

    it('roundtrip: inject then extract preserves ids', () => {
      let extracted: ReturnType<typeof extractTraceFromIpc>;
      withTrace('roundtrip', () => {
        const injected = injectTraceIntoIpc(baseMsg);
        extracted = extractTraceFromIpc(injected);
      });
      expect(extracted!).toBeDefined();
      expect(extracted!.traceId).toBeTruthy();
      expect(extracted!.spanId).toBeTruthy();
    });
  });
});

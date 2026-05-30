import { AsyncLocalStorage } from 'node:async_hooks';
import { getTracer, type SpanHandle } from './tracer.js';
import type { IpcMessage } from '../contracts/infrastructure.js';

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
}

export const traceStore = new AsyncLocalStorage<TraceContext>();

export function getCurrentTrace(): TraceContext | undefined {
  return traceStore.getStore();
}

export function withTrace<T>(name: string, fn: () => T): T {
  const parent = getCurrentTrace();
  const tracer = getTracer();

  let span: SpanHandle;
  if (parent) {
    span = tracer.startSpan(name, parent.traceId, parent.spanId);
  } else {
    span = tracer.startTrace(name);
  }

  const ctx: TraceContext = {
    traceId: span.traceId,
    spanId: span.id,
    parentSpanId: parent?.spanId ?? null,
  };

  const result = traceStore.run(ctx, fn);

  if (result instanceof Promise) {
    return result.then(
      (v) => { span.setStatus('ok'); span.end(); return v; },
      (err) => { span.setStatus('error', (err as Error).message); span.end(); throw err; },
    ) as T;
  }

  span.setStatus('ok');
  span.end();
  return result;
}

export async function withTraceAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return withTrace(name, fn) as Promise<T>;
}

export function injectTraceIntoIpc<T>(msg: IpcMessage<T>): IpcMessage<T> {
  const ctx = getCurrentTrace();
  if (!ctx) return msg;
  return { ...msg, traceId: ctx.traceId, spanId: ctx.spanId };
}

export function extractTraceFromIpc(msg: IpcMessage): TraceContext | undefined {
  if (!msg.traceId || !msg.spanId) return undefined;
  return {
    traceId: msg.traceId,
    spanId: msg.spanId,
    parentSpanId: null,
  };
}

import type { MessageType, MessagePayload, MessageResult, MessageContext } from '../contracts/messages.js';
import { getLogger } from '../utils/logger.js';
import { metrics } from '../observability/metrics.js';

const logger = getLogger('middleware');

export type SendInterceptor = (
  type: MessageType,
  payload: unknown,
  ctx: MessageContext,
  next: () => Promise<unknown>,
) => Promise<unknown>;

export type EmitInterceptor = (
  type: MessageType,
  payload: unknown,
  next: () => void,
) => void;

export interface Middleware {
  readonly name: string;
  onSend?: SendInterceptor;
  onEmit?: EmitInterceptor;
}

export function composeSendChain(
  middlewares: Middleware[],
  finalHandler: (type: MessageType, payload: unknown, ctx: MessageContext) => Promise<unknown>,
): (type: MessageType, payload: unknown, ctx: MessageContext) => Promise<unknown> {
  if (middlewares.length === 0) return finalHandler;

  return (type, payload, ctx) => {
    let index = 0;
    const dispatch = (): Promise<unknown> => {
      if (index >= middlewares.length) {
        return finalHandler(type, payload, ctx);
      }
      const mw = middlewares[index++];
      if (mw.onSend) {
        return mw.onSend(type, payload, ctx, dispatch);
      }
      return dispatch();
    };
    return dispatch();
  };
}

export function composeEmitChain(
  middlewares: Middleware[],
  finalHandler: (type: MessageType, payload: unknown) => void,
): (type: MessageType, payload: unknown) => void {
  if (middlewares.length === 0) return finalHandler;

  return (type, payload) => {
    let index = 0;
    const dispatch = (): void => {
      if (index >= middlewares.length) {
        finalHandler(type, payload);
        return;
      }
      const mw = middlewares[index++];
      if (mw.onEmit) {
        mw.onEmit(type, payload, dispatch);
      } else {
        dispatch();
      }
    };
    dispatch();
  };
}

export function createMetricsMiddleware(): Middleware {
  return {
    name: 'metrics',
    onSend: async (type, _payload, _ctx, next) => {
      const t0 = Date.now();
      try {
        const result = await next();
        metrics.histogram('bus_send_duration_ms').observe(Date.now() - t0, { type });
        metrics.counter('bus_send_total').inc({ type, status: 'ok' });
        return result;
      } catch (err) {
        metrics.histogram('bus_send_duration_ms').observe(Date.now() - t0, { type });
        metrics.counter('bus_send_total').inc({ type, status: 'error' });
        throw err;
      }
    },
    onEmit: (type, _payload, next) => {
      metrics.counter('bus_emit_total').inc({ type });
      next();
    },
  };
}

export function createLoggingMiddleware(level: 'debug' | 'trace' = 'debug'): Middleware {
  return {
    name: 'logging',
    onSend: async (type, _payload, ctx, next) => {
      logger[level]({ type, correlationId: ctx.correlationId }, 'bus.send');
      const result = await next();
      logger[level]({ type }, 'bus.send.complete');
      return result;
    },
    onEmit: (type, _payload, next) => {
      logger[level]({ type }, 'bus.emit');
      next();
    },
  };
}

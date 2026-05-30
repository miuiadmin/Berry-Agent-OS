import type { Middleware } from './middleware.js';
import { getLogger } from '../utils/logger.js';
import { metrics } from '../observability/metrics.js';

const logger = getLogger('auth');

export interface AuthConfig {
  enabled: boolean;
  gracePeriodMs: number;
  validateToken: (token: string) => boolean | Promise<boolean>;
}

export interface ConnectionAuthState {
  authenticated: boolean;
  connectedAt: number;
  token?: string;
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  enabled: false,
  gracePeriodMs: 5_000,
  validateToken: () => false,
};

export async function authenticateConnection(
  token: string | undefined,
  config: AuthConfig,
): Promise<{ ok: boolean; error?: string }> {
  if (!config.enabled) return { ok: true };
  if (!token) return { ok: false, error: 'Authentication token required' };

  const valid = await config.validateToken(token);
  if (!valid) {
    metrics.counter('auth_failures_total').inc();
    logger.warn('Authentication failed: invalid token');
    return { ok: false, error: 'Invalid authentication token' };
  }
  return { ok: true };
}

export function createAuthMiddleware(
  getAuthState: (connectionId: string) => ConnectionAuthState | undefined,
  config: AuthConfig,
): Middleware {
  return {
    name: 'auth',
    onSend: async (type, _payload, ctx, next) => {
      if (!config.enabled) return next();
      if (!ctx.connectionId) return next();

      const state = getAuthState(ctx.connectionId);
      if (!state) return next();
      if (state.authenticated) return next();

      const elapsed = Date.now() - state.connectedAt;
      if (elapsed < config.gracePeriodMs) return next();

      metrics.counter('auth_rejections_total').inc({ type });
      throw new Error(`Unauthenticated connection ${ctx.connectionId}: message ${type} rejected`);
    },
  };
}

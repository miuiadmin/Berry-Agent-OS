import { describe, it, expect, vi } from 'vitest';
import { authenticateConnection, createAuthMiddleware, DEFAULT_AUTH_CONFIG } from './auth-middleware.js';
import { composeSendChain } from './middleware.js';
import type { MessageType, MessageContext } from '../contracts/messages.js';
import type { ConnectionAuthState } from './auth-middleware.js';

describe('authenticateConnection', () => {
  it('returns ok when auth is disabled', async () => {
    const result = await authenticateConnection(undefined, { ...DEFAULT_AUTH_CONFIG, enabled: false });
    expect(result.ok).toBe(true);
  });

  it('returns error when no token provided and auth enabled', async () => {
    const config = { enabled: true, gracePeriodMs: 5000, validateToken: () => true };
    const result = await authenticateConnection(undefined, config);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('token required');
  });

  it('returns error when token is invalid', async () => {
    const config = { enabled: true, gracePeriodMs: 5000, validateToken: () => false };
    const result = await authenticateConnection('bad-token', config);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid');
  });

  it('returns ok when token is valid', async () => {
    const config = { enabled: true, gracePeriodMs: 5000, validateToken: (t: string) => t === 'secret' };
    const result = await authenticateConnection('secret', config);
    expect(result.ok).toBe(true);
  });

  it('supports async validateToken', async () => {
    const config = {
      enabled: true,
      gracePeriodMs: 5000,
      validateToken: async (t: string) => t === 'async-secret',
    };
    expect((await authenticateConnection('async-secret', config)).ok).toBe(true);
    expect((await authenticateConnection('wrong', config)).ok).toBe(false);
  });
});

describe('createAuthMiddleware', () => {
  const config = { enabled: true, gracePeriodMs: 1000, validateToken: () => true };

  it('passes through when auth is disabled', async () => {
    const disabledConfig = { ...config, enabled: false };
    const mw = createAuthMiddleware(() => undefined, disabledConfig);
    const chain = composeSendChain([mw], async () => 'ok');
    const result = await chain('test' as MessageType, {}, { connectionId: 'conn1' });
    expect(result).toBe('ok');
  });

  it('passes through when no connectionId in context', async () => {
    const mw = createAuthMiddleware(() => undefined, config);
    const chain = composeSendChain([mw], async () => 'ok');
    const result = await chain('test' as MessageType, {}, {});
    expect(result).toBe('ok');
  });

  it('passes through when connection is authenticated', async () => {
    const state: ConnectionAuthState = { authenticated: true, connectedAt: Date.now() - 10000 };
    const mw = createAuthMiddleware(() => state, config);
    const chain = composeSendChain([mw], async () => 'ok');
    const result = await chain('test' as MessageType, {}, { connectionId: 'conn1' });
    expect(result).toBe('ok');
  });

  it('passes through during grace period even if unauthenticated', async () => {
    const state: ConnectionAuthState = { authenticated: false, connectedAt: Date.now() };
    const mw = createAuthMiddleware(() => state, config);
    const chain = composeSendChain([mw], async () => 'ok');
    const result = await chain('test' as MessageType, {}, { connectionId: 'conn1' });
    expect(result).toBe('ok');
  });

  it('rejects unauthenticated connection after grace period', async () => {
    const state: ConnectionAuthState = { authenticated: false, connectedAt: Date.now() - 2000 };
    const mw = createAuthMiddleware(() => state, config);
    const chain = composeSendChain([mw], async () => 'ok');
    await expect(
      chain('test' as MessageType, {}, { connectionId: 'conn1' }),
    ).rejects.toThrow('Unauthenticated');
  });
});

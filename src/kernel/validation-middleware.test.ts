import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { SchemaRegistry, createValidationMiddleware, ValidationError } from './validation-middleware.js';
import { composeSendChain } from './middleware.js';
import type { MessageType } from '../contracts/messages.js';

describe('ValidationMiddleware', () => {
  it('passes valid payload through to handler', async () => {
    const registry = new SchemaRegistry();
    registry.register('test:action' as MessageType, z.object({ name: z.string() }));

    const mw = createValidationMiddleware(registry);
    const chain = composeSendChain([mw], async (_type, payload) => payload);

    const result = await chain('test:action' as MessageType, { name: 'hello' }, {});
    expect(result).toEqual({ name: 'hello' });
  });

  it('throws ValidationError for invalid payload', async () => {
    const registry = new SchemaRegistry();
    registry.register('test:action' as MessageType, z.object({ name: z.string(), age: z.number() }));

    const mw = createValidationMiddleware(registry);
    const chain = composeSendChain([mw], async () => 'never');

    try {
      await chain('test:action' as MessageType, { name: 123 }, {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.messageType).toBe('test:action');
      expect(ve.issues.length).toBeGreaterThan(0);
    }
  });

  it('passes through for unregistered message types', async () => {
    const registry = new SchemaRegistry();
    const mw = createValidationMiddleware(registry);
    const chain = composeSendChain([mw], async () => 'ok');

    const result = await chain('unknown:type' as MessageType, { anything: true }, {});
    expect(result).toBe('ok');
  });

  it('SchemaRegistry tracks registrations', () => {
    const registry = new SchemaRegistry();
    expect(registry.has('foo')).toBe(false);
    registry.register('foo', z.string());
    expect(registry.has('foo')).toBe(true);
    expect(registry.get('foo')).toBeDefined();
  });
});

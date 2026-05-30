import { z, type ZodSchema } from 'zod';
import type { Middleware } from './middleware.js';
import type { MessageType } from '../contracts/messages.js';
import { getLogger } from '../utils/logger.js';
import { metrics } from '../observability/metrics.js';

const logger = getLogger('validation');

export class SchemaRegistry {
  private schemas = new Map<string, ZodSchema>();

  register(type: MessageType | string, schema: ZodSchema): void {
    this.schemas.set(type, schema);
  }

  get(type: string): ZodSchema | undefined {
    return this.schemas.get(type);
  }

  has(type: string): boolean {
    return this.schemas.has(type);
  }
}

export class ValidationError extends Error {
  readonly code = 'VALIDATION_FAILED';
  constructor(
    message: string,
    readonly messageType: string,
    readonly issues: Array<{ path: (string | number | symbol)[]; message: string }>,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function createValidationMiddleware(registry: SchemaRegistry): Middleware {
  return {
    name: 'validation',
    onSend: async (type, payload, _ctx, next) => {
      const schema = registry.get(type);
      if (schema) {
        const result = schema.safeParse(payload);
        if (!result.success) {
          metrics.counter('bus_validation_failures_total').inc({ type });
          const issues = result.error.issues.map((i) => ({
            path: i.path,
            message: i.message,
          }));
          logger.warn({ type, issues }, 'Message validation failed');
          throw new ValidationError(
            `Validation failed for ${type}: ${result.error.message}`,
            type,
            issues,
          );
        }
      }
      return next();
    },
  };
}

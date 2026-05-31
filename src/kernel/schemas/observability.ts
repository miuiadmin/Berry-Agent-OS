import { z } from 'zod';

export const ObservabilityConfigSchema = z.object({
  level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  captureOutput: z.boolean().default(false),
  terminal: z.enum(['human', 'json', 'silent']).default('silent'),
});

export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;

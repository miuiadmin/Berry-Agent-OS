import { z } from 'zod';

export const AutonomyConfigSchema = z.object({
  willLoopEnabled: z.boolean().default(false),
  willLoopIntervalMs: z.number().default(300_000),
  maxAutoDangerLevel: z.enum(['safe', 'moderate']).default('moderate'),
  maxActionsPerHour: z.number().default(5),
}).default({
  willLoopEnabled: false,
  willLoopIntervalMs: 300_000,
  maxAutoDangerLevel: 'moderate',
  maxActionsPerHour: 5,
});

export type AutonomyConfig = z.infer<typeof AutonomyConfigSchema>;

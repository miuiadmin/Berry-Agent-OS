import { z } from 'zod';

export const DaemonConfigSchema = z.object({
  enabled: z.boolean().default(false),
  autoStart: z.boolean().default(true),
  maxSlots: z.number().default(2),
  heartbeatIntervalMs: z.number().default(5000),
  heartbeatTimeoutMs: z.number().default(15000),
  taskTimeoutMs: z.number().default(300000),
  runtimes: z.record(z.string(), z.object({
    enabled: z.boolean().default(true),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  })).default({}),
});

export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

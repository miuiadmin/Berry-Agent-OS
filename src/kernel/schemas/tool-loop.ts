import { z } from 'zod';

export const ToolLoopConfigSchema = z.object({
  maxCalls: z.number().default(20),
  timeoutMs: z.number().default(30000),
});

export type ToolLoopConfig = z.infer<typeof ToolLoopConfigSchema>;

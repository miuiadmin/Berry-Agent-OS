import { z } from 'zod';

export const ToolOutputConfigSchema = z.object({
  maxBytes: z.number().default(40_000),
  maxLines: z.number().default(500),
});

export const ToolLoopConfigSchema = z.object({
  maxCalls: z.number().default(20),
  timeoutMs: z.number().default(30000),
  toolOutput: ToolOutputConfigSchema.default({ maxBytes: 40_000, maxLines: 500 }),
});

export type ToolLoopConfig = z.infer<typeof ToolLoopConfigSchema>;

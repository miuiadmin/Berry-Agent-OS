import { z } from 'zod';

export const StreamingConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

export type StreamingConfig = z.infer<typeof StreamingConfigSchema>;

import { z } from 'zod';

export const MemoryConfigSchema = z.object({
  evolutionEnabled: z.boolean().default(true),
  consolidationInterval: z.number().default(50),
  maxResults: z.number().default(5),
});

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

import { z } from 'zod';

export const WebConfigSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().default(3888),
  host: z.string().default('127.0.0.1'),
  secret: z.string().default(''),
});

export type WebConfig = z.infer<typeof WebConfigSchema>;

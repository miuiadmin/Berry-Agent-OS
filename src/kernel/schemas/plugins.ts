import { z } from 'zod';

export const PluginsConfigSchema = z.object({
  unified: z.boolean().default(false),
  pluginsDir: z.string().default(''),
});

export type PluginsConfig = z.infer<typeof PluginsConfigSchema>;

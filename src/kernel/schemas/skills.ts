import { z } from 'zod';

export const SkillsConfigSchema = z.object({
  promptMode: z.enum(['summary', 'full', 'hybrid']).default('full'),
  maxPromptChars: z.number().default(8000),
  maxDescriptionChars: z.number().default(512),
  shellInjection: z.boolean().default(false),
});

export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

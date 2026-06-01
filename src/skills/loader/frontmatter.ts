import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

const HookSchema = z.object({
  command: z.string(),
  timeout: z.number().default(5000),
});

export const SkillFrontmatterSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string().default('0.1.0'),
  origin: z.enum(['bundled', 'generated', 'user']).default('user'),
  created_by: z.enum(['system', 'agent', 'user']).default('user'),
  tags: z.array(z.string()).optional(),

  arguments: z.array(z.string()).optional(),
  model_invocable: z.boolean().default(true),
  user_invocable: z.boolean().default(true),
  description_hidden: z.boolean().default(false),

  platforms: z.array(z.string()).optional(),
  paths: z.array(z.string()).optional(),
  requires_toolsets: z.array(z.string()).optional(),
  fallback_for_toolsets: z.array(z.string()).optional(),
  required_environment: z.array(z.string()).optional(),

  allowed_tools: z.array(z.string()).optional(),
  denied_tools: z.array(z.string()).optional(),

  effort: z.enum(['low', 'medium', 'high']).optional(),
  timeout: z.number().optional(),
  context_fork: z.boolean().default(false),

  hooks: z.object({
    before_execution: HookSchema.optional(),
    after_execution: HookSchema.optional(),
    on_error: HookSchema.optional(),
  }).optional(),

  prompt_priority: z.number().default(0),
  auto_load: z.boolean().default(false),
  when_to_use: z.string().optional(),
  fingerprint: z.string().optional(),
  disabled: z.boolean().default(false),
  absorbed_into: z.string().optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export function parseFrontmatter(content: string): SkillFrontmatter | null {
  const raw = extractRawFrontmatter(content);
  if (!raw) return null;

  try {
    const parsed = parseYaml(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const result = SkillFrontmatterSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function parseFrontmatterLoose(content: string): Record<string, unknown> | null {
  const raw = extractRawFrontmatter(content);
  if (!raw) return null;

  try {
    const parsed = parseYaml(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function extractRawFrontmatter(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

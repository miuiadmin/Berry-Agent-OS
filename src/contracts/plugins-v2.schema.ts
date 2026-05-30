import { z } from 'zod';

// ══════════════════════════════════════════════════════════════════════
// Plugin v2 — Zod Schemas for Runtime Validation
// ══════════════════════════════════════════════════════════════════════

export const PluginScopeSchema = z.enum(['private', 'workspace', 'global']);
export const PluginSourceSchema = z.enum(['bundled', 'evolved', 'user', 'installed', 'mcp-bridge']);
export const PluginStatusSchema = z.enum([
  'draft', 'validating', 'pending_review', 'pending_user_confirm',
  'enabled', 'disabled', 'quarantined', 'rolled_back', 'failed',
]);
export const PluginRiskLevelSchema = z.enum(['low', 'medium', 'high']);
export const PermissionScopeSchema = z.enum(['readonly', 'workspace', 'network', 'dangerous']);

export const HookEventSchema = z.enum([
  'beforePromptAssembly', 'afterPromptAssembly',
  'beforeExecution', 'afterExecution',
  'onToolCall', 'onReviewSubmit', 'onError',
  'onMessage', 'onTaskCreated', 'onScheduleTick',
  'onFileChanged', 'onAgentIdle',
]);

// --- Facet Schemas ---

export const PromptFacetConfigSchema = z.object({
  content: z.string().min(1),
  injection: z.enum(['system', 'assistant', 'context']).default('system'),
  priority: z.number().min(0).max(1).default(0.5),
  activationRules: z.object({
    taskTags: z.array(z.string()).optional(),
    always: z.boolean().default(false),
  }).default({ always: false }),
});

export const ToolFacetDefSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'tool name must be lowercase snake_case'),
  title: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  permissionScope: PermissionScopeSchema.default('readonly'),
});

export const CodeFacetConfigSchema = z.object({
  entrypoint: z.string().min(1),
  sandbox: z.literal('worker'),
  timeout: z.number().int().min(1000).max(120_000).default(30_000),
});

export const HookFacetDefSchema = z.object({
  event: HookEventSchema,
  handlerPath: z.string().min(1),
  priority: z.number().int().min(0).max(100).default(50),
});

export const ServiceFacetConfigSchema = z.object({
  entrypoint: z.string().min(1),
  schedule: z.string().optional(),
  restartPolicy: z.enum(['on-failure', 'always', 'never']).default('on-failure'),
});

// --- Permissions Schema ---

export const PluginPermissionsSchema = z.object({
  network: z.object({ allow: z.array(z.string()) }).optional(),
  filesystem: z.enum(['none', 'workspace-only', 'readonly', 'full']).optional(),
  storage: z.object({ maxBytes: z.number().int().positive() }).optional(),
  tools: z.array(z.string()).optional(),
  secrets: z.array(z.string()).optional(),
});

// --- Evolution Metadata Schema ---

export const PluginEvolutionMetaSchema = z.object({
  confidence: z.number().min(0).max(1),
  observations: z.array(z.string()),
  sourceAgent: z.string().optional(),
  sourceEpisodes: z.array(z.string()).optional(),
});

// --- Facets Container ---

export const PluginFacetsSchema = z.object({
  prompt: PromptFacetConfigSchema.optional(),
  tools: z.array(ToolFacetDefSchema).optional(),
  code: CodeFacetConfigSchema.optional(),
  hooks: z.array(HookFacetDefSchema).optional(),
  service: ServiceFacetConfigSchema.optional(),
}).refine(
  (facets) => facets.prompt || facets.tools || facets.code || facets.hooks || facets.service,
  { message: 'Plugin must have at least one facet' },
);

// --- Full Manifest v2 Schema ---

export const PluginManifestV2Schema = z.object({
  apiVersion: z.literal('berry.plugin.v2'),
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'plugin name must be lowercase kebab-case').min(2).max(64),
  version: z.string().min(1),
  description: z.string().min(1).max(500),
  source: PluginSourceSchema,
  riskLevel: PluginRiskLevelSchema,
  scope: PluginScopeSchema,
  facets: PluginFacetsSchema,
  permissions: PluginPermissionsSchema.default({}),
  evolution: PluginEvolutionMetaSchema.optional(),
});

// --- Hook Action Schema (runtime validation of hook returns) ---

export const HookActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pass') }),
  z.object({ action: z.literal('flag'), reason: z.string() }),
  z.object({ action: z.literal('block'), reason: z.string() }),
  z.object({ action: z.literal('modify'), data: z.unknown() }),
]);

import type { PluginContext } from '../plugins/sdk.js';
import type { ToolDefinition } from '../tools/types.js';

// ══════════════════════════════════════════════════════════════════════
// Plugin v2 — 统一插件系统类型定义
// ══════════════════════════════════════════════════════════════════════

// --- Enums & Literals ---

export type PluginScope = 'private' | 'workspace' | 'global';
export type PluginSource = 'bundled' | 'evolved' | 'user' | 'installed' | 'mcp-bridge';
export type PluginStatus =
  | 'draft'
  | 'validating'
  | 'pending_review'
  | 'pending_user_confirm'
  | 'enabled'
  | 'disabled'
  | 'quarantined'
  | 'rolled_back'
  | 'failed';

export type HookEvent =
  | 'beforePromptAssembly'
  | 'afterPromptAssembly'
  | 'beforeExecution'
  | 'afterExecution'
  | 'onToolCall'
  | 'onReviewSubmit'
  | 'onError'
  | 'onMessage'
  | 'onTaskCreated'
  | 'onScheduleTick'
  | 'onFileChanged'
  | 'onAgentIdle';

export type HookAction =
  | { action: 'pass' }
  | { action: 'flag'; reason: string }
  | { action: 'block'; reason: string }
  | { action: 'modify'; data: unknown };

export type PermissionScope = 'readonly' | 'workspace' | 'network' | 'dangerous';

// --- Facet Definitions ---

export interface PromptFacetConfig {
  content: string;
  injection: 'system' | 'assistant' | 'context';
  priority: number;
  activationRules: {
    taskTags?: string[];
    always: boolean;
  };
}

export interface ToolFacetDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  permissionScope: PermissionScope;
}

export interface CodeFacetConfig {
  entrypoint: string;
  sandbox: 'worker';
  timeout: number;
}

export interface HookFacetDef {
  event: HookEvent;
  handlerPath: string;
  priority: number;
}

export interface ServiceFacetConfig {
  entrypoint: string;
  schedule?: string;
  restartPolicy: 'on-failure' | 'always' | 'never';
}

// --- Permissions ---

export interface PluginPermissions {
  network?: { allow: string[] };
  filesystem?: 'none' | 'workspace-only' | 'readonly' | 'full';
  storage?: { maxBytes: number };
  tools?: string[];
  secrets?: string[];
}

// --- Evolution Metadata ---

export interface PluginEvolutionMeta {
  confidence: number;
  observations: string[];
  sourceAgent?: string;
  sourceEpisodes?: string[];
}

// --- Manifest v2 ---

export interface PluginFacets {
  prompt?: PromptFacetConfig;
  tools?: ToolFacetDef[];
  code?: CodeFacetConfig;
  hooks?: HookFacetDef[];
  service?: ServiceFacetConfig;
}

export interface PluginManifestV2 {
  apiVersion: 'berry.plugin.v2';
  name: string;
  version: string;
  description: string;
  source: PluginSource;
  riskLevel: 'low' | 'medium' | 'high';
  scope: PluginScope;
  facets: PluginFacets;
  permissions: PluginPermissions;
  evolution?: PluginEvolutionMeta;
}

// --- Persisted Record (DB row representation) ---

export interface PluginRecord {
  id: string;
  name: string;
  version: number;
  description: string;
  scope: PluginScope;
  ownerAgentId: string | null;
  workspaceId: string | null;
  userId: string;
  source: PluginSource;
  riskLevel: 'low' | 'medium' | 'high';
  status: PluginStatus;
  hasPrompt: boolean;
  hasTools: boolean;
  hasCode: boolean;
  hasHooks: boolean;
  hasService: boolean;
  promptContent: string | null;
  promptPriority: number;
  promptActivationRules: { taskTags?: string[]; always: boolean } | null;
  manifestJson: PluginManifestV2 | null;
  permissionsJson: PluginPermissions | null;
  evolutionJson: PluginEvolutionMeta | null;
  importance: number;
  useCount: number;
  successCount: number;
  failureCount: number;
  lastUsedAt: number | null;
  previousVersions: Array<{ version: number; manifestJson: unknown; updatedAt: number }> | null;
  promotedFromId: string | null;
  promotedAt: number | null;
  tags: string[] | null;
  createdAt: number;
  updatedAt: number;
}

// --- Plugin Tool Record (plugin_tools row) ---

export interface PluginToolRecord {
  id: string;
  pluginId: string;
  toolName: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  permissionScope: PermissionScope;
  createdAt: number;
}

// --- Plugin Hook Record (plugin_hooks row) ---

export interface PluginHookRecord {
  id: string;
  pluginId: string;
  event: HookEvent;
  handlerPath: string;
  priority: number;
  enabled: boolean;
  createdAt: number;
}

// --- Agent-Plugin Binding ---

export type BindingSource = 'self' | 'assigned' | 'workspace_default' | 'global_default';

export interface AgentPluginBinding {
  id: string;
  agentId: string;
  pluginId: string;
  source: BindingSource;
  enabled: boolean;
  pinned: boolean;
  configJson: Record<string, unknown> | null;
  assignedBy: string | null;
  createdAt: number;
}

// --- Filter & Query ---

export interface PluginListFilter {
  scope?: PluginScope;
  status?: PluginStatus;
  source?: PluginSource;
  hasPrompt?: boolean;
  hasTools?: boolean;
  hasHooks?: boolean;
  hasService?: boolean;
  workspaceId?: string;
  userId?: string;
}

// --- Prompt Injection Context ---

export interface PromptInjectionContext {
  agentId: string;
  workspaceId: string;
  userId: string;
  taskTags?: string[];
  tokenBudget: number;
}

// --- Hook Handler ---

export interface HookHandler {
  pluginName: string;
  event: HookEvent;
  handlerPath: string;
  priority: number;
}

// --- Resolved Plugin Set (after scope merge) ---

export interface ResolvedPluginSet {
  all: PluginRecord[];
  prompt: PluginRecord[];
  tools: PluginRecord[];
  hooks: PluginRecord[];
  services: PluginRecord[];
  code: PluginRecord[];
}

// --- Agent Context Snapshot (exposed to plugins) ---

export interface AgentContextSnapshot {
  agentId: string;
  currentTask?: string;
  recentMessages: Array<{ role: string; content: string }>;
  activePlugins: string[];
}

// --- Plugin Context V2 (extends v1) ---

export interface SecretAccessor {
  get(name: string): string | null;
}

export interface PluginContextV2 extends PluginContext {
  scope: PluginScope;
  agentId?: string;
  workspaceId?: string;
  secrets: SecretAccessor;
  invokePlugin: (pluginName: string, toolName: string, input: unknown) => Promise<unknown>;
  getAgentContext: () => AgentContextSnapshot | null;
}

// --- Runtime Interface ---

export interface IPluginRuntimeV2 {
  initialize(plugins: PluginRecord[]): Promise<void>;
  reload(): Promise<void>;
  getToolDefinitions(agentId?: string): ToolDefinition[];
  buildPromptBlock(context: PromptInjectionContext): string;
  getHooksForEvent(event: HookEvent, agentId?: string): HookHandler[];
  executeHookChain(event: HookEvent, payload: unknown, agentId?: string): Promise<HookAction>;
  executeTool(pluginName: string, toolName: string, input: unknown): Promise<PluginExecResultV2>;
  executeCode(pluginName: string, input: unknown): Promise<PluginExecResultV2>;
  startService(pluginName: string): Promise<void>;
  stopService(pluginName: string): Promise<void>;
}

// --- Registry Interface ---

export interface IPluginRegistryV2 {
  list(filter?: PluginListFilter): PluginRecord[];
  get(id: string): PluginRecord | undefined;
  getByName(name: string): PluginRecord | undefined;
  getForAgent(agentId: string, workspaceId: string, userId: string): ResolvedPluginSet;
  create(manifest: PluginManifestV2, userId: string, workspaceId?: string): PluginRecord;
  updateStatus(id: string, status: PluginStatus): void;
  bind(agentId: string, pluginId: string, source: BindingSource): void;
  unbind(agentId: string, pluginId: string): void;
  getBindings(agentId: string): AgentPluginBinding[];
  getTools(pluginId: string): PluginToolRecord[];
  getHooks(pluginId: string): PluginHookRecord[];
}

// --- Execution Result ---

export interface PluginExecResultV2 {
  ok: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
}

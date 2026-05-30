import { sqliteTable, text, integer, real, unique } from 'drizzle-orm/sqlite-core';
import { workspaces } from './workspaces.js';
import { agents } from './agents.js';
import { users } from './users.js';

export const plugins = sqliteTable('plugins', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  description: text('description'),
  scope: text('scope').notNull().default('private'),
  ownerAgentId: text('owner_agent_id').references(() => agents.id),
  workspaceId: text('workspace_id').references(() => workspaces.id),
  userId: text('user_id').notNull().references(() => users.id),
  source: text('source').notNull().default('evolved'),
  riskLevel: text('risk_level').notNull().default('low'),
  status: text('status').notNull().default('draft'),
  hasPrompt: integer('has_prompt').notNull().default(0),
  hasTools: integer('has_tools').notNull().default(0),
  hasCode: integer('has_code').notNull().default(0),
  hasHooks: integer('has_hooks').notNull().default(0),
  hasService: integer('has_service').notNull().default(0),
  promptContent: text('prompt_content'),
  promptPriority: real('prompt_priority').default(0.5),
  promptActivationRules: text('prompt_activation_rules', { mode: 'json' }),
  manifestJson: text('manifest_json', { mode: 'json' }),
  permissionsJson: text('permissions_json', { mode: 'json' }),
  evolutionJson: text('evolution_json', { mode: 'json' }),
  importance: real('importance').notNull().default(0.6),
  useCount: integer('use_count').notNull().default(0),
  successCount: integer('success_count').notNull().default(0),
  failureCount: integer('failure_count').notNull().default(0),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  previousVersions: text('previous_versions', { mode: 'json' }),
  promotedFromId: text('promoted_from_id'),
  promotedAt: integer('promoted_at', { mode: 'timestamp' }),
  tags: text('tags', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const pluginTools = sqliteTable('plugin_tools', {
  id: text('id').primaryKey(),
  pluginId: text('plugin_id').notNull().references(() => plugins.id),
  toolName: text('tool_name').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  inputSchema: text('input_schema', { mode: 'json' }).notNull(),
  outputSchema: text('output_schema', { mode: 'json' }),
  permissionScope: text('permission_scope').notNull().default('readonly'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  unique().on(table.pluginId, table.toolName),
]);

export const pluginHooks = sqliteTable('plugin_hooks', {
  id: text('id').primaryKey(),
  pluginId: text('plugin_id').notNull().references(() => plugins.id),
  event: text('event').notNull(),
  handlerPath: text('handler_path').notNull(),
  priority: integer('priority').notNull().default(50),
  enabled: integer('enabled').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  unique().on(table.pluginId, table.event),
]);

export const agentPluginBindings = sqliteTable('agent_plugin_bindings', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  pluginId: text('plugin_id').notNull().references(() => plugins.id),
  source: text('source').notNull(),
  enabled: integer('enabled').notNull().default(1),
  pinned: integer('pinned').notNull().default(0),
  configJson: text('config_json', { mode: 'json' }),
  assignedBy: text('assigned_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  unique().on(table.agentId, table.pluginId),
]);

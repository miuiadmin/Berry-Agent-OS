import { sqliteTable, text, integer, real, unique } from 'drizzle-orm/sqlite-core';
import { workspaces } from './workspaces.js';
import { agents } from './agents.js';
import { users } from './users.js';

export const agentMemories = sqliteTable('agent_memories', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  workspaceId: text('workspace_id').references(() => workspaces.id),
  type: text('type').notNull(),
  content: text('content').notNull(),
  source: text('source'),
  importance: real('importance').notNull().default(0.5),
  accessCount: integer('access_count').notNull().default(0),
  publishedPluginId: text('published_plugin_id'),
  lastAccessedAt: integer('last_accessed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const workspaceMemories = sqliteTable('workspace_memories', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  ownerAgentId: text('owner_agent_id').references(() => agents.id),
  type: text('type').notNull(),
  content: text('content').notNull(),
  origin: text('origin').notNull().default('evolved'),
  visibility: text('visibility').notNull().default('private'),
  importance: real('importance').notNull().default(0.5),
  tags: text('tags', { mode: 'json' }).$type<string[] | null>(),
  recallCount: integer('recall_count').notNull().default(0),
  verifiedAt: integer('verified_at', { mode: 'timestamp' }),
  sourceExecutionId: text('source_execution_id'),
  archived: integer('archived').notNull().default(0),
  lastRecalledAt: integer('last_recalled_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const agentMemoryBindings = sqliteTable('agent_memory_bindings', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  memoryId: text('memory_id').notNull().references(() => workspaceMemories.id),
  source: text('source').notNull(),
  enabled: integer('enabled').notNull().default(1),
  pinned: integer('pinned').notNull().default(0),
  assignedBy: text('assigned_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  unique().on(table.agentId, table.memoryId),
]);

export const globalMemories = sqliteTable('global_memories', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  type: text('type').notNull(),
  content: text('content').notNull(),
  origin: text('origin').notNull().default('evolved'),
  sourceWorkspaceId: text('source_workspace_id'),
  sourceMemoryId: text('source_memory_id'),
  importance: real('importance').notNull().default(0.6),
  tags: text('tags', { mode: 'json' }).$type<string[] | null>(),
  recallCount: integer('recall_count').notNull().default(0),
  verifiedAt: integer('verified_at', { mode: 'timestamp' }),
  archived: integer('archived').notNull().default(0),
  lastRecalledAt: integer('last_recalled_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

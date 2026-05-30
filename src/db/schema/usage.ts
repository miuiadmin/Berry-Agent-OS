import { sqliteTable, text, integer, real, unique } from 'drizzle-orm/sqlite-core';
import { workspaces } from './workspaces.js';
import { agents } from './agents.js';

export const usageHourly = sqliteTable('usage_hourly', {
  id: text('id').primaryKey(),
  bucketHour: integer('bucket_hour').notNull(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  agentId: text('agent_id').references(() => agents.id),
  model: text('model'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheTokens: integer('cache_tokens').notNull().default(0),
  taskCount: integer('task_count').notNull().default(0),
  totalCost: real('total_cost').notNull().default(0),
}, (table) => [
  unique().on(table.bucketHour, table.workspaceId, table.agentId, table.model),
]);

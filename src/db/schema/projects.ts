import { sqliteTable, text, integer, unique } from 'drizzle-orm/sqlite-core';
import { workspaces } from './workspaces.js';
import { orgNodes } from './org-nodes.js';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  orgNodeId: text('org_node_id').references(() => orgNodes.id),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull().default('active'),
  visibility: text('visibility').notNull().default('private'),
  defaultColumns: text('default_columns', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const taskColumns = sqliteTable('task_columns', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  name: text('name').notNull(),
  position: integer('position').notNull(),
  color: text('color'),
  wipLimit: integer('wip_limit'),
}, (table) => [
  unique().on(table.projectId, table.position),
]);

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { workspaces } from './workspaces.js';

export const orgNodes = sqliteTable('org_nodes', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  parentId: text('parent_id'),
  name: text('name').notNull(),
  description: text('description'),
  type: text('type').notNull(),
  path: text('path').notNull(),
  depth: integer('depth').notNull().default(0),
  position: integer('position').notNull().default(0),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

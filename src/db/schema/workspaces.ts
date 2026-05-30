import { sqliteTable, text, integer, unique } from 'drizzle-orm/sqlite-core';
import { users } from './users.js';

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  description: text('description'),
  issuePrefix: text('issue_prefix'),
  issueCounter: integer('issue_counter').notNull().default(0),
  context: text('context'),
  reviewMode: text('review_mode').notNull().default('trust_based'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const workspaceMembers = sqliteTable('workspace_members', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  userId: text('user_id').notNull().references(() => users.id),
  role: text('role').notNull(),
  joinedAt: integer('joined_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  unique().on(table.workspaceId, table.userId),
]);

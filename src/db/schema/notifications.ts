import { sqliteTable, text, integer, unique } from 'drizzle-orm/sqlite-core';
import { workspaces } from './workspaces.js';
import { users } from './users.js';

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  link: text('link'),
  read: integer('read').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const notificationPreferences = sqliteTable('notification_preferences', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  userId: text('user_id').notNull().references(() => users.id),
  preferences: text('preferences', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  unique().on(table.workspaceId, table.userId),
]);

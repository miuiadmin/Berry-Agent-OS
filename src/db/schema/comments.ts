import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { tasks } from './tasks.js';

export const taskComments = sqliteTable('task_comments', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id),
  parentId: text('parent_id'),
  authorType: text('author_type').notNull(),
  authorId: text('author_id').notNull(),
  commentType: text('comment_type').notNull().default('comment'),
  content: text('content').notNull(),
  metadata: text('metadata', { mode: 'json' }),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
  resolvedByType: text('resolved_by_type'),
  resolvedById: text('resolved_by_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const taskAttachments = sqliteTable('task_attachments', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id),
  commentId: text('comment_id').references(() => taskComments.id),
  fileName: text('file_name').notNull(),
  storagePath: text('storage_path').notNull(),
  mimeType: text('mime_type'),
  size: integer('size'),
  uploadedByType: text('uploaded_by_type').notNull(),
  uploadedById: text('uploaded_by_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

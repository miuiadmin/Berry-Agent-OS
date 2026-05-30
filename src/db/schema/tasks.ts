import { sqliteTable, text, integer, real, unique } from 'drizzle-orm/sqlite-core';
import { workspaces } from './workspaces.js';
import { projects } from './projects.js';
import { taskColumns } from './projects.js';
import { users } from './users.js';

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  columnId: text('column_id').notNull().references(() => taskColumns.id),
  parentTaskId: text('parent_task_id'),
  number: integer('number').notNull(),
  identifier: text('identifier').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  assigneeType: text('assignee_type'),
  assigneeId: text('assignee_id'),
  creatorType: text('creator_type').notNull(),
  creatorId: text('creator_id').notNull(),
  priority: text('priority').notNull().default('medium'),
  position: real('position').notNull().default(0),
  estimatedHours: real('estimated_hours'),
  actualHours: real('actual_hours'),
  acceptanceCriteria: text('acceptance_criteria', { mode: 'json' }),
  metadata: text('metadata', { mode: 'json' }),
  startDate: integer('start_date', { mode: 'timestamp' }),
  dueDate: integer('due_date', { mode: 'timestamp' }),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  unique().on(table.workspaceId, table.number),
]);

export const taskLabels = sqliteTable('task_labels', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  color: text('color').notNull(),
}, (table) => [
  unique().on(table.workspaceId, table.name),
]);

export const taskLabelLinks = sqliteTable('task_label_links', {
  taskId: text('task_id').notNull().references(() => tasks.id),
  labelId: text('label_id').notNull().references(() => taskLabels.id),
}, (table) => [
  unique().on(table.taskId, table.labelId),
]);

export const taskDependencies = sqliteTable('task_dependencies', {
  id: text('id').primaryKey(),
  blockingTaskId: text('blocking_task_id').notNull().references(() => tasks.id),
  blockedTaskId: text('blocked_task_id').notNull().references(() => tasks.id),
  dependencyType: text('dependency_type').notNull().default('finish_to_start'),
  createdByType: text('created_by_type').notNull(),
  createdById: text('created_by_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  unique().on(table.blockingTaskId, table.blockedTaskId),
]);

export const taskReactions = sqliteTable('task_reactions', {
  id: text('id').primaryKey(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  emoji: text('emoji').notNull(),
  reactorType: text('reactor_type').notNull(),
  reactorId: text('reactor_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  unique().on(table.targetType, table.targetId, table.emoji, table.reactorType, table.reactorId),
]);

export const taskSubscribers = sqliteTable('task_subscribers', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id),
  subscriberType: text('subscriber_type').notNull(),
  subscriberId: text('subscriber_id').notNull(),
  reason: text('reason').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  unique().on(table.taskId, table.subscriberType, table.subscriberId),
]);

export const savedViews = sqliteTable('saved_views', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  projectId: text('project_id').references(() => projects.id),
  name: text('name').notNull(),
  viewType: text('view_type').notNull().default('board'),
  filters: text('filters', { mode: 'json' }).notNull(),
  sortBy: text('sort_by', { mode: 'json' }),
  groupBy: text('group_by'),
  isDefault: integer('is_default').notNull().default(0),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

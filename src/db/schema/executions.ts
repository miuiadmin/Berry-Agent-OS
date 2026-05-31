import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { workspaces } from './workspaces.js';
import { agents } from './agents.js';

export type ReviewAction = 'approve' | 'modify' | 'reject' | 'reassign' | 'supplement' | 'suspend' | 'change_and_route';

export interface ReviewDecision {
  action: ReviewAction;
  note?: string;
  modifiedContent?: string;
  guidance?: string;
  suggestions?: string[];
  reassignToAgentId?: string;
  supplementInfo?: string;
  taskChanges?: {
    priority?: string;
    dueDate?: number;
    columnId?: string;
    labelsAdd?: string[];
    labelsRemove?: string[];
    descriptionAppend?: string;
  };
  nextAction?: 'reject' | 'reassign' | 'suspend';
}

export const agentExecutions = sqliteTable('agent_executions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').references(() => workspaces.id),
  agentId: text('agent_id').notNull().references(() => agents.id),
  taskId: text('task_id'),
  jobId: text('job_id'),
  traceId: text('trace_id'),
  triggerType: text('trigger_type').notNull(),
  status: text('status').notNull(),
  phase: text('phase').notNull().default('pending'),
  inputPrompt: text('input_prompt'),
  output: text('output'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cacheTokens: integer('cache_tokens'),
  totalCost: real('total_cost'),
  toolCalls: integer('tool_calls').default(0),
  errorType: text('error_type'),
  progressData: text('progress_data', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  checkpoint: text('checkpoint', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  reviewStatus: text('review_status').notNull().default('pending'),
  reviewedBy: text('reviewed_by'),
  reviewNote: text('review_note'),
  reviewGuidance: text('review_guidance', { mode: 'json' }).$type<{ guidance?: string; suggestions?: string[] } | null>(),
  reviewActionData: text('review_action_data', { mode: 'json' }).$type<ReviewDecision | null>(),
  reviewRetryCount: integer('review_retry_count').notNull().default(0),
  reviewEscalatedTo: text('review_escalated_to'),
  redoCount: integer('redo_count').notNull().default(0),
  previousExecutionId: text('previous_execution_id'),
  durationMs: integer('duration_ms'),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  error: text('error'),
});

export const agentSessions = sqliteTable('agent_sessions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').references(() => workspaces.id),
  agentId: text('agent_id').notNull().references(() => agents.id),
  title: text('title'),
  sessionType: text('session_type').notNull(),
  status: text('status').notNull().default('active'),
  messageCount: integer('message_count').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  compressedAt: integer('compressed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const sessionMessages = sqliteTable('session_messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => agentSessions.id),
  role: text('role').notNull(),
  content: text('content').notNull(),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { users } from './users.js';
import { workspaces } from './workspaces.js';
import { orgNodes } from './org-nodes.js';

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').references(() => workspaces.id),
  orgNodeId: text('org_node_id').references(() => orgNodes.id),
  superiorId: text('superior_id'),
  userId: text('user_id').notNull().references(() => users.id),
  agentType: text('agent_type').notNull().default('team'),
  name: text('name').notNull(),
  avatar: text('avatar'),
  roleDescription: text('role_description'),
  provider: text('provider').notNull(),
  config: text('config', { mode: 'json' }).notNull(),
  thinkingLevel: text('thinking_level'),
  customEnv: text('custom_env', { mode: 'json' }),
  customArgs: text('custom_args', { mode: 'json' }),
  l2Capabilities: text('l2_capabilities', { mode: 'json' }).notNull().default('["learning","skills"]'),
  roles: text('roles', { mode: 'json' }),
  workspacePath: text('workspace_path'),
  status: text('status').notNull().default('idle'),
  lastActiveAt: integer('last_active_at', { mode: 'timestamp' }),
  priorSessionId: text('prior_session_id'),
  priorWorkDir: text('prior_work_dir'),
  archivedAt: integer('archived_at', { mode: 'timestamp' }),
  archivedBy: text('archived_by'),
  trustLevel: text('trust_level').notNull().default('probation'),
  consecutiveApprovals: integer('consecutive_approvals').notNull().default(0),
  totalRejections: integer('total_rejections').notNull().default(0),
  totalExecutions: integer('total_executions').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  successRate: real('success_rate'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

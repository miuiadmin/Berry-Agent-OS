import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { users } from './users.js';

export const teamTemplates = sqliteTable('team_templates', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  description: text('description'),
  category: text('category'),
  orgStructure: text('org_structure', { mode: 'json' }).notNull(),
  agentConfigs: text('agent_configs', { mode: 'json' }).notNull(),
  isPublic: integer('is_public').notNull().default(0),
  useCount: integer('use_count').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

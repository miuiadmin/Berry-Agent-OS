import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import type { ModuleContainer } from '../modules/index.js';
import { createAuthRoutes } from './routes/auth.js';
import { createWorkspaceRoutes } from './routes/workspace.js';
import { createAgentRoutes } from './routes/agent.js';
import { createOrgRoutes } from './routes/org.js';
import { createProjectRoutes } from './routes/project.js';
import { createTaskRoutes } from './routes/task.js';
import { createExecutionRoutes } from './routes/execution.js';
import { createSchedulerRoutes } from './routes/scheduler.js';
import { createMemoryRoutes } from './routes/memory.js';
import { createPluginRoutes } from './routes/plugin.js';
import { createNotificationRoutes } from './routes/notification.js';
import { createReviewRoutes } from './routes/review.js';
import { createSessionRoutes } from './routes/session.js';
import { createChatRoutes } from './routes/chat.js';

export function createServer(modules: ModuleContainer) {
  const app = new Hono();

  app.use('*', cors({ origin: '*' }));

  app.route('/api/auth', createAuthRoutes(modules));
  app.route('/api/workspaces', createWorkspaceRoutes(modules));
  app.route('/api/agents', createAgentRoutes(modules));
  app.route('/api/org', createOrgRoutes(modules));
  app.route('/api/projects', createProjectRoutes(modules));
  app.route('/api/tasks', createTaskRoutes(modules));
  app.route('/api/executions', createExecutionRoutes(modules));
  app.route('/api/scheduler', createSchedulerRoutes(modules));
  app.route('/api/memory', createMemoryRoutes(modules));
  app.route('/api/plugins', createPluginRoutes(modules));
  app.route('/api/notifications', createNotificationRoutes(modules));
  app.route('/api/review', createReviewRoutes(modules));
  app.route('/api/sessions', createSessionRoutes(modules));
  app.route('/api/chat', createChatRoutes(modules));

  app.get('/api/health', (c) => c.json({ ok: true, timestamp: Date.now() }));

  return app;
}

export function startServer(modules: ModuleContainer, port = 3888) {
  const app = createServer(modules);
  const server = serve({ fetch: app.fetch, port });
  return { app, server };
}

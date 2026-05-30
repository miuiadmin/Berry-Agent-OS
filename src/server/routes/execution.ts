import { Hono } from 'hono';
import type { ModuleContainer } from '../../modules/index.js';

export function createExecutionRoutes(modules: ModuleContainer) {
  const app = new Hono();

  app.get('/agent/:agentId', async (c) => {
    const executions = modules.execution.listByAgent(c.req.param('agentId'));
    return c.json(executions);
  });

  app.get('/task/:taskId', async (c) => {
    const executions = modules.execution.listByTask(c.req.param('taskId'));
    return c.json(executions);
  });

  app.get('/:id', async (c) => {
    const execution = modules.execution.getById(c.req.param('id'));
    if (!execution) return c.json({ error: 'Not found' }, 404);
    return c.json(execution);
  });

  app.get('/:id/messages', async (c) => {
    const messages = modules.execution.getSessionMessages(c.req.param('id'));
    return c.json(messages);
  });

  app.get('/reviews/pending/:reviewerId', async (c) => {
    const pending = modules.execution.getPendingReviews(c.req.param('reviewerId'));
    return c.json(pending);
  });

  return app;
}

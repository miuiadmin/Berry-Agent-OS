import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ModuleContainer } from '../../modules/index.js';

const createSessionSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string().optional(),
  title: z.string().optional(),
  sessionType: z.enum(['user_chat', 'execution', 'chain', 'delegate']).optional(),
});

const addMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export function createSessionRoutes(modules: ModuleContainer) {
  const app = new Hono();

  app.post('/', zValidator('json', createSessionSchema), async (c) => {
    const body = c.req.valid('json');
    const session = modules.execution.createSession({
      agentId: body.agentId,
      workspaceId: body.workspaceId,
      title: body.title,
      sessionType: body.sessionType ?? 'user_chat',
    });
    return c.json(session, 201);
  });

  app.get('/', async (c) => {
    const agentId = c.req.query('agentId');
    if (!agentId) return c.json({ error: 'agentId required' }, 400);
    const sessions = modules.execution.listSessions(agentId);
    return c.json(sessions);
  });

  app.get('/:id', async (c) => {
    const session = modules.execution.getSession(c.req.param('id'));
    if (!session) return c.json({ error: 'Not found' }, 404);
    return c.json(session);
  });

  app.get('/:id/messages', async (c) => {
    const messages = modules.execution.getSessionMessages(c.req.param('id'));
    return c.json(messages);
  });

  app.post('/:id/messages', zValidator('json', addMessageSchema), async (c) => {
    const body = c.req.valid('json');
    const message = modules.execution.addMessage(
      c.req.param('id'),
      body.role,
      body.content,
      body.metadata,
    );
    return c.json(message, 201);
  });

  return app;
}

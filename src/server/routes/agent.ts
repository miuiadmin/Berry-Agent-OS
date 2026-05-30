import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ModuleContainer } from '../../modules/index.js';

const createSchema = z.object({
  workspaceId: z.string().optional(),
  orgNodeId: z.string().optional(),
  superiorId: z.string().optional(),
  userId: z.string(),
  agentType: z.enum(['global', 'team']).optional(),
  name: z.string().min(1),
  roleDescription: z.string().optional(),
  provider: z.string(),
  config: z.record(z.string(), z.unknown()),
  thinkingLevel: z.enum(['low', 'medium', 'high', 'max']).optional(),
  l2Capabilities: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  roleDescription: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  thinkingLevel: z.enum(['low', 'medium', 'high', 'max']).nullable().optional(),
  l2Capabilities: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
});

export function createAgentRoutes(modules: ModuleContainer) {
  const app = new Hono();

  app.get('/', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    return c.json(modules.agent.listByWorkspace(workspaceId));
  });

  app.get('/global/:userId', async (c) => {
    let agent = modules.agent.getGlobalAssistant(c.req.param('userId'));
    if (!agent) {
      agent = modules.agent.create({
        userId: c.req.param('userId'),
        agentType: 'global',
        name: '全局助手',
        roleDescription: 'Personal AI assistant',
        provider: 'anthropic',
        config: { model: 'claude-sonnet-4-20250514' },
        thinkingLevel: 'medium',
        l2Capabilities: ['learning', 'skills', 'search', 'memory'],
      });
    }
    return c.json(agent);
  });

  app.get('/:id', async (c) => {
    const agent = modules.agent.getById(c.req.param('id'));
    if (!agent) return c.json({ error: 'Not found' }, 404);
    return c.json(agent);
  });

  app.get('/:id/subordinates', async (c) => {
    return c.json(modules.agent.getSubordinates(c.req.param('id')));
  });

  app.post('/', zValidator('json', createSchema), async (c) => {
    const body = c.req.valid('json');
    const agent = modules.agent.create(body);
    return c.json(agent, 201);
  });

  app.patch('/:id', zValidator('json', updateSchema), async (c) => {
    modules.agent.update(c.req.param('id'), c.req.valid('json'));
    return c.json({ ok: true });
  });

  app.post('/:id/archive', async (c) => {
    const userId = c.req.query('userId');
    if (!userId) return c.json({ error: 'userId required' }, 400);
    modules.agent.archive(c.req.param('id'), userId);
    return c.json({ ok: true });
  });

  return app;
}

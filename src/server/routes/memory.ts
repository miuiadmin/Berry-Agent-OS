import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ModuleContainer } from '../../modules/index.js';

const createMemorySchema = z.object({
  type: z.enum(['skill', 'preference', 'knowledge', 'feedback']),
  content: z.string(),
  source: z.string().optional(),
  importance: z.number().optional(),
});

export function createMemoryRoutes(modules: ModuleContainer) {
  const app = new Hono();

  app.get('/agent/:agentId', async (c) => {
    const memories = modules.memory.getAgentMemories(c.req.param('agentId'));
    return c.json(memories);
  });

  app.post('/agent/:agentId', zValidator('json', createMemorySchema), async (c) => {
    const body = c.req.valid('json');
    const memory = modules.memory.createAgentMemory({
      agentId: c.req.param('agentId'),
      ...body,
    });
    return c.json(memory, 201);
  });

  app.get('/workspace/:workspaceId', async (c) => {
    const memories = modules.memory.getWorkspaceMemories(c.req.param('workspaceId'));
    return c.json(memories);
  });

  app.get('/global/:userId', async (c) => {
    const memories = modules.memory.getGlobalMemories(c.req.param('userId'));
    return c.json(memories);
  });

  app.post('/bind', zValidator('json', z.object({
    agentId: z.string(),
    memoryId: z.string(),
    source: z.string(),
  })), async (c) => {
    const { agentId, memoryId, source } = c.req.valid('json');
    modules.memory.bindMemoryToAgent(agentId, memoryId, source);
    return c.json({ ok: true });
  });

  app.post('/unbind', zValidator('json', z.object({
    agentId: z.string(),
    memoryId: z.string(),
  })), async (c) => {
    const { agentId, memoryId } = c.req.valid('json');
    modules.memory.unbindMemory(agentId, memoryId);
    return c.json({ ok: true });
  });

  return app;
}

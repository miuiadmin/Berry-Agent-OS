import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ModuleContainer } from '../../modules/index.js';

const createPluginSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  scope: z.enum(['private', 'workspace', 'global']).optional(),
  workspaceId: z.string().optional(),
  userId: z.string(),
  source: z.enum(['bundled', 'evolved', 'user', 'installed', 'mcp-bridge']).optional(),
  riskLevel: z.enum(['low', 'medium', 'high']).optional(),
  promptContent: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export function createPluginRoutes(modules: ModuleContainer) {
  const app = new Hono();

  app.get('/workspace/:workspaceId', async (c) => {
    const plugins = modules.plugin.listByWorkspace(c.req.param('workspaceId'));
    return c.json(plugins);
  });

  app.get('/:id', async (c) => {
    const plugin = modules.plugin.getById(c.req.param('id'));
    if (!plugin) return c.json({ error: 'Not found' }, 404);
    return c.json(plugin);
  });

  app.post('/', zValidator('json', createPluginSchema), async (c) => {
    const body = c.req.valid('json');
    const plugin = modules.plugin.create(body);
    return c.json(plugin, 201);
  });

  app.post('/:id/enable', async (c) => {
    modules.plugin.enable(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/:id/disable', async (c) => {
    modules.plugin.disable(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/:id/tools', async (c) => {
    const tools = modules.plugin.getTools(c.req.param('id'));
    return c.json(tools);
  });

  app.post('/bind', zValidator('json', z.object({
    agentId: z.string(),
    pluginId: z.string(),
    source: z.string(),
  })), async (c) => {
    const { agentId, pluginId, source } = c.req.valid('json');
    modules.plugin.bindToAgent(agentId, pluginId, source);
    return c.json({ ok: true });
  });

  app.post('/unbind', zValidator('json', z.object({
    agentId: z.string(),
    pluginId: z.string(),
  })), async (c) => {
    const { agentId, pluginId } = c.req.valid('json');
    modules.plugin.unbindFromAgent(agentId, pluginId);
    return c.json({ ok: true });
  });

  return app;
}

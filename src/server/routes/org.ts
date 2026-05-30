import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ModuleContainer } from '../../modules/index.js';

const createSchema = z.object({
  workspaceId: z.string(),
  parentId: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(['root', 'group', 'department', 'system', 'center', 'custom']),
  metadata: z.unknown().optional(),
});

const moveSchema = z.object({
  newParentId: z.string().nullable(),
});

export function createOrgRoutes(modules: ModuleContainer) {
  const app = new Hono();

  app.get('/tree/:workspaceId', async (c) => {
    return c.json(modules.org.getTree(c.req.param('workspaceId')));
  });

  app.get('/:id', async (c) => {
    const node = modules.org.getById(c.req.param('id'));
    if (!node) return c.json({ error: 'Not found' }, 404);
    return c.json(node);
  });

  app.get('/:id/children', async (c) => {
    return c.json(modules.org.getChildren(c.req.param('id')));
  });

  app.post('/', zValidator('json', createSchema), async (c) => {
    const node = modules.org.create(c.req.valid('json'));
    return c.json(node, 201);
  });

  app.post('/:id/move', zValidator('json', moveSchema), async (c) => {
    modules.org.move({ nodeId: c.req.param('id'), ...c.req.valid('json') });
    return c.json({ ok: true });
  });

  app.delete('/:id', async (c) => {
    modules.org.delete(c.req.param('id'));
    return c.json({ ok: true });
  });

  return app;
}

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ModuleContainer } from '../../modules/index.js';

const createSchema = z.object({
  workspaceId: z.string(),
  orgNodeId: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  visibility: z.enum(['private', 'public']).optional(),
  defaultColumns: z.array(z.string()).optional(),
});

export function createProjectRoutes(modules: ModuleContainer) {
  const app = new Hono();

  app.get('/', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    return c.json(modules.project.listByWorkspace(workspaceId));
  });

  app.get('/:id', async (c) => {
    const project = modules.project.getById(c.req.param('id'));
    if (!project) return c.json({ error: 'Not found' }, 404);
    return c.json(project);
  });

  app.get('/:id/columns', async (c) => {
    return c.json(modules.project.getColumns(c.req.param('id')));
  });

  app.post('/', zValidator('json', createSchema), async (c) => {
    const project = modules.project.create(c.req.valid('json'));
    return c.json(project, 201);
  });

  app.patch('/:id', zValidator('json', z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
  })), async (c) => {
    modules.project.update(c.req.param('id'), c.req.valid('json'));
    return c.json({ ok: true });
  });

  app.post('/:id/archive', async (c) => {
    modules.project.archive(c.req.param('id'));
    return c.json({ ok: true });
  });

  return app;
}

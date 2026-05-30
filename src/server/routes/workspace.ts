import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ModuleContainer } from '../../modules/index.js';

const createSchema = z.object({
  ownerId: z.string(),
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().optional(),
  reviewMode: z.enum(['strict', 'trust_based']).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  context: z.string().optional(),
  reviewMode: z.enum(['strict', 'trust_based']).optional(),
});

export function createWorkspaceRoutes(modules: ModuleContainer) {
  const app = new Hono();

  app.get('/', async (c) => {
    const ownerId = c.req.query('ownerId');
    if (!ownerId) return c.json({ error: 'ownerId required' }, 400);
    const list = modules.workspace.listByOwner(ownerId);
    return c.json(list);
  });

  app.get('/:id', async (c) => {
    const ws = modules.workspace.getById(c.req.param('id'));
    if (!ws) return c.json({ error: 'Not found' }, 404);
    return c.json(ws);
  });

  app.post('/', zValidator('json', createSchema), async (c) => {
    const body = c.req.valid('json');
    const ws = modules.workspace.create(body);
    return c.json(ws, 201);
  });

  app.patch('/:id', zValidator('json', updateSchema), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    modules.workspace.update(id, body);
    return c.json({ ok: true });
  });

  app.delete('/:id', async (c) => {
    modules.workspace.delete(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/:id/members', async (c) => {
    const members = modules.workspace.getMembers(c.req.param('id'));
    return c.json(members);
  });

  app.post('/:id/members', zValidator('json', z.object({
    userId: z.string(),
    role: z.enum(['admin', 'member']),
  })), async (c) => {
    const body = c.req.valid('json');
    modules.workspace.addMember({ workspaceId: c.req.param('id'), ...body });
    return c.json({ ok: true }, 201);
  });

  app.delete('/:id/members/:userId', async (c) => {
    modules.workspace.removeMember(c.req.param('id'), c.req.param('userId'));
    return c.json({ ok: true });
  });

  return app;
}

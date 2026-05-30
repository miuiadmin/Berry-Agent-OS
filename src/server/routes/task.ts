import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ModuleContainer } from '../../modules/index.js';

const createSchema = z.object({
  projectId: z.string(),
  workspaceId: z.string(),
  columnId: z.string(),
  parentTaskId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  assigneeType: z.enum(['agent', 'user', 'role']).optional(),
  assigneeId: z.string().optional(),
  creatorType: z.enum(['agent', 'user', 'system']),
  creatorId: z.string(),
  priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']).optional(),
  dueDate: z.string().datetime().optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  columnId: z.string().optional(),
  assigneeType: z.string().optional(),
  assigneeId: z.string().optional(),
  priority: z.string().optional(),
  position: z.number().optional(),
});

export function createTaskRoutes(modules: ModuleContainer) {
  const app = new Hono();

  app.get('/', async (c) => {
    const projectId = c.req.query('projectId');
    if (!projectId) return c.json({ error: 'projectId required' }, 400);
    return c.json(modules.task.listByProject(projectId));
  });

  app.get('/:id', async (c) => {
    const task = modules.task.getById(c.req.param('id'));
    if (!task) return c.json({ error: 'Not found' }, 404);
    return c.json(task);
  });

  app.post('/', zValidator('json', createSchema), async (c) => {
    const body = c.req.valid('json');
    const task = modules.task.create({
      ...body,
      dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
    });
    return c.json(task, 201);
  });

  app.patch('/:id', zValidator('json', updateSchema), async (c) => {
    modules.task.update(c.req.param('id'), c.req.valid('json'));
    return c.json({ ok: true });
  });

  app.post('/:id/move', zValidator('json', z.object({
    columnId: z.string(),
    position: z.number().optional(),
  })), async (c) => {
    const { columnId, position } = c.req.valid('json');
    modules.task.update(c.req.param('id'), { columnId, position });
    return c.json({ ok: true });
  });

  app.delete('/:id', async (c) => {
    modules.task.delete(c.req.param('id'));
    return c.json({ ok: true });
  });

  return app;
}

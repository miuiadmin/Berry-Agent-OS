import { Hono } from 'hono';
import type { ModuleContainer } from '../../modules/index.js';

export function createNotificationRoutes(modules: ModuleContainer) {
  const app = new Hono();

  app.get('/unread/:targetType/:targetId', async (c) => {
    const notifications = modules.notification.getUnread(
      c.req.param('targetType'),
      c.req.param('targetId'),
    );
    return c.json(notifications);
  });

  app.get('/all/:targetType/:targetId', async (c) => {
    const notifications = modules.notification.getAll(
      c.req.param('targetType'),
      c.req.param('targetId'),
    );
    return c.json(notifications);
  });

  app.post('/:id/read', async (c) => {
    modules.notification.markRead(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/read-all/:targetType/:targetId', async (c) => {
    modules.notification.markAllRead(
      c.req.param('targetType'),
      c.req.param('targetId'),
    );
    return c.json({ ok: true });
  });

  return app;
}

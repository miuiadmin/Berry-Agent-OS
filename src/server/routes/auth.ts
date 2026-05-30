import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ModuleContainer } from '../../modules/index.js';

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(6),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export function createAuthRoutes(modules: ModuleContainer) {
  const app = new Hono();

  app.post('/register', zValidator('json', registerSchema), async (c) => {
    const body = c.req.valid('json');
    const existing = modules.auth.getByEmail(body.email);
    if (existing) {
      return c.json({ error: 'Email already in use' }, 409);
    }
    const user = modules.auth.create(body);
    return c.json({ id: user.id, email: user.email, name: user.name }, 201);
  });

  app.post('/login', zValidator('json', loginSchema), async (c) => {
    const body = c.req.valid('json');
    const user = modules.auth.verifyPassword(body.email, body.password);
    if (!user) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }
    return c.json({ id: user.id, email: user.email, name: user.name });
  });

  app.get('/me/:userId', async (c) => {
    const user = modules.auth.getById(c.req.param('userId'));
    if (!user) return c.json({ error: 'Not found' }, 404);
    return c.json({ id: user.id, email: user.email, name: user.name, avatar: user.avatar });
  });

  return app;
}

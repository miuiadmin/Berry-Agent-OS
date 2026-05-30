import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ModuleContainer } from '../../modules/index.js';

const createJobSchema = z.object({
  workspaceId: z.string(),
  agentId: z.string(),
  name: z.string(),
  scheduleType: z.enum(['cron', 'interval', 'webhook', 'event']),
  prompt: z.string(),
  cronExpression: z.string().optional(),
  intervalMinutes: z.number().optional(),
  concurrencyPolicy: z.enum(['queue', 'replace', 'forbid']).optional(),
  executionMode: z.enum(['create_task', 'run_only']).optional(),
  enabled: z.boolean().optional(),
});

export function createSchedulerRoutes(modules: ModuleContainer) {
  const app = new Hono();

  app.get('/jobs/:workspaceId', async (c) => {
    const jobs = modules.scheduler.listJobs(c.req.param('workspaceId'));
    return c.json(jobs);
  });

  app.post('/jobs', zValidator('json', createJobSchema), async (c) => {
    const body = c.req.valid('json');
    const job = modules.scheduler.createJob(body);
    return c.json(job, 201);
  });

  app.post('/jobs/:id/trigger', async (c) => {
    modules.scheduler.triggerJob(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/jobs/:id/enable', async (c) => {
    modules.scheduler.enableJob(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/jobs/:id/disable', async (c) => {
    modules.scheduler.disableJob(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.delete('/jobs/:id', async (c) => {
    modules.scheduler.deleteJob(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/reminders/:agentId', async (c) => {
    const reminders = modules.scheduler.listReminders(c.req.param('agentId'));
    return c.json(reminders);
  });

  return app;
}

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ModuleContainer } from '../../modules/index.js';

const reviewDecisionSchema = z.object({
  executionId: z.string(),
  action: z.enum(['approve', 'modify', 'reject', 'reassign', 'supplement', 'suspend', 'change_and_route']),
  note: z.string().optional(),
  modifiedContent: z.string().optional(),
  guidance: z.string().optional(),
  suggestions: z.array(z.string()).optional(),
  reassignToAgentId: z.string().optional(),
  supplementInfo: z.string().optional(),
});

export function createReviewRoutes(modules: ModuleContainer) {
  const app = new Hono();

  app.post('/decide', zValidator('json', reviewDecisionSchema), async (c) => {
    const body = c.req.valid('json');
    modules.review.submitDecision(body.executionId, body);
    return c.json({ ok: true });
  });

  app.post('/request', zValidator('json', z.object({
    executionId: z.string(),
    reviewerId: z.string(),
  })), async (c) => {
    const { executionId, reviewerId } = c.req.valid('json');
    modules.review.requestReview(executionId, reviewerId);
    return c.json({ ok: true });
  });

  app.get('/chain/:agentId', async (c) => {
    const chain = modules.review.getReviewChain(c.req.param('agentId'));
    return c.json(chain);
  });

  app.get('/auto-approve/:agentId/:executionId', async (c) => {
    const result = modules.review.shouldAutoApprove(
      c.req.param('agentId'),
      c.req.param('executionId'),
    );
    return c.json({ autoApprove: result });
  });

  return app;
}

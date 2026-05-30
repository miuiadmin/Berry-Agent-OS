import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import type { CreateJobInput, ScheduleType, ConcurrencyPolicy, ExecutionMode, SessionMode } from '../scheduler/contracts.js';

type RouteRegistrar = (method: string, path: string, handler: (req: IncomingMessage, res: ServerResponse, url: URL, params: Record<string, string>) => void | Promise<void>) => void;

export function registerSchedulerRoutes(
  route: RouteRegistrar,
  getScheduler: () => SchedulerService | null | undefined,
  readBody: (req: IncomingMessage) => Promise<unknown>,
  json: (res: ServerResponse, data: unknown, status?: number) => void,
): void {

  route('GET', '/scheduler/jobs', (_req, res, url) => {
    const scheduler = getScheduler();
    if (!scheduler) { json(res, { ok: false, error: 'Scheduler not available' }, 503); return; }
    const workspaceId = url.searchParams.get('workspaceId') ?? undefined;
    json(res, { ok: true, jobs: scheduler.listJobs(workspaceId) });
  });

  route('POST', '/scheduler/jobs', async (req, res) => {
    const scheduler = getScheduler();
    if (!scheduler) { json(res, { ok: false, error: 'Scheduler not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;

    const input: CreateJobInput = {
      workspaceId: body.workspaceId as string,
      agentId: body.agentId as string,
      name: body.name as string,
      description: body.description as string | undefined,
      scheduleType: body.scheduleType as ScheduleType,
      cronExpression: body.cronExpression as string | undefined,
      intervalMinutes: body.intervalMinutes as number | undefined,
      webhookSecret: body.webhookSecret as string | undefined,
      eventFilter: body.eventFilter as Record<string, unknown> | undefined,
      concurrencyPolicy: body.concurrencyPolicy as ConcurrencyPolicy | undefined,
      executionMode: body.executionMode as ExecutionMode | undefined,
      prompt: body.prompt as string,
      sessionMode: body.sessionMode as SessionMode | undefined,
      maxRetries: body.maxRetries as number | undefined,
      retryDelayMs: body.retryDelayMs as number | undefined,
    };

    const jobId = scheduler.createJob(input);
    const job = scheduler.getJob(jobId);
    json(res, { ok: true, jobId, webhookToken: job?.webhook_token ?? undefined });
  });

  route('GET', '/scheduler/jobs/:id', (_req, res, _url, params) => {
    const scheduler = getScheduler();
    if (!scheduler) { json(res, { ok: false, error: 'Scheduler not available' }, 503); return; }
    const job = scheduler.getJob(params.id);
    if (!job) { json(res, { ok: false, error: 'Job not found' }, 404); return; }
    json(res, { ok: true, job });
  });

  route('PUT', '/scheduler/jobs/:id', async (req, res, _url, params) => {
    const scheduler = getScheduler();
    if (!scheduler) { json(res, { ok: false, error: 'Scheduler not available' }, 503); return; }
    const body = await readBody(req) as Partial<CreateJobInput>;
    scheduler.updateJob(params.id, body);
    json(res, { ok: true });
  });

  route('DELETE', '/scheduler/jobs/:id', (_req, res, _url, params) => {
    const scheduler = getScheduler();
    if (!scheduler) { json(res, { ok: false, error: 'Scheduler not available' }, 503); return; }
    scheduler.deleteJob(params.id);
    json(res, { ok: true });
  });

  route('POST', '/scheduler/jobs/:id/pause', async (req, res, _url, params) => {
    const scheduler = getScheduler();
    if (!scheduler) { json(res, { ok: false, error: 'Scheduler not available' }, 503); return; }
    const body = await readBody(req) as { reason?: string };
    scheduler.pauseJob(params.id, body.reason ?? 'Manual pause');
    json(res, { ok: true });
  });

  route('POST', '/scheduler/jobs/:id/resume', (_req, res, _url, params) => {
    const scheduler = getScheduler();
    if (!scheduler) { json(res, { ok: false, error: 'Scheduler not available' }, 503); return; }
    scheduler.resumeJob(params.id);
    json(res, { ok: true });
  });

  route('POST', '/scheduler/jobs/:id/trigger', (_req, res, _url, params) => {
    const scheduler = getScheduler();
    if (!scheduler) { json(res, { ok: false, error: 'Scheduler not available' }, 503); return; }
    const result = scheduler.triggerNow(params.id);
    if (result.ok) {
      json(res, { ok: true, executionId: result.executionId });
    } else {
      json(res, { ok: false, error: result.reason }, 409);
    }
  });

  route('GET', '/scheduler/jobs/:id/executions', (_req, res, url, params) => {
    const scheduler = getScheduler();
    if (!scheduler) { json(res, { ok: false, error: 'Scheduler not available' }, 503); return; }
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    json(res, { ok: true, executions: scheduler.getExecutionHistory(params.id, limit) });
  });

  route('GET', '/scheduler/queue', (_req, res, url) => {
    const scheduler = getScheduler();
    if (!scheduler) { json(res, { ok: false, error: 'Scheduler not available' }, 503); return; }
    const workspaceId = url.searchParams.get('workspaceId') ?? undefined;
    json(res, { ok: true, status: scheduler.getQueueStatus(workspaceId) });
  });

  route('POST', '/scheduler/chain/:roundId/approve/:stepId', (_req, res, _url, params) => {
    const scheduler = getScheduler();
    if (!scheduler) { json(res, { ok: false, error: 'Scheduler not available' }, 503); return; }
    scheduler.chainExecutor.approveStep(params.roundId, params.stepId);
    json(res, { ok: true });
  });

  route('POST', '/scheduler/chain/:roundId/reject/:stepId', async (req, res, _url, params) => {
    const scheduler = getScheduler();
    if (!scheduler) { json(res, { ok: false, error: 'Scheduler not available' }, 503); return; }
    const body = await readBody(req) as { reason: string };
    scheduler.chainExecutor.rejectStep(params.roundId, params.stepId, body.reason ?? 'Rejected');
    json(res, { ok: true });
  });

  route('POST', '/webhooks/:token', async (req, res, _url, params) => {
    const scheduler = getScheduler();
    if (!scheduler) { json(res, { ok: false, error: 'Scheduler not available' }, 503); return; }
    const body = await readBody(req);
    const signature = req.headers['x-webhook-signature'] as string | undefined;
    const sourceIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.socket.remoteAddress;
    const result = scheduler.webhookReceiver.handleIncoming(params.token, body, signature, sourceIp);
    if (result.accepted) {
      json(res, { ok: true, executionId: result.executionId });
    } else {
      json(res, { ok: false, error: result.error }, result.error === 'Invalid webhook token' ? 404 : 403);
    }
  });

  route('GET', '/scheduler/webhooks/audit', (_req, res, url) => {
    const scheduler = getScheduler();
    if (!scheduler) { json(res, { ok: false, error: 'Scheduler not available' }, 503); return; }
    const jobId = url.searchParams.get('jobId');
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const { db } = scheduler as any;
    const query = jobId
      ? 'SELECT * FROM webhook_audit_log WHERE job_id = ? ORDER BY received_at DESC LIMIT ?'
      : 'SELECT * FROM webhook_audit_log ORDER BY received_at DESC LIMIT ?';
    const params = jobId ? [jobId, limit] : [limit];
    json(res, { ok: true, audit: (db as any).prepare(query).all(...params) });
  });

  route('POST', '/scheduler/reminders', async (req, res) => {
    const scheduler = getScheduler();
    if (!scheduler) { json(res, { ok: false, error: 'Scheduler not available' }, 503); return; }
    const body = await readBody(req) as { agentId: string; workspaceId: string; name?: string; prompt: string; triggerAt: number; recurringCron?: string };
    const id = scheduler.reminderService.create(body);
    json(res, { ok: true, reminderId: id });
  });

  route('DELETE', '/scheduler/reminders/:id', (_req, res, _url, params) => {
    const scheduler = getScheduler();
    if (!scheduler) { json(res, { ok: false, error: 'Scheduler not available' }, 503); return; }
    scheduler.reminderService.delete(params.id);
    json(res, { ok: true });
  });
}

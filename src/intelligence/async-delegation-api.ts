import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IAsyncDelegationService, AsyncDelegationStatus, CreateAsyncDelegationInput } from './contracts.js';

type RouteRegistrar = (method: string, path: string, handler: (req: IncomingMessage, res: ServerResponse, url: URL, params: Record<string, string>) => void | Promise<void>) => void;

export function registerAsyncDelegationRoutes(
  route: RouteRegistrar,
  getService: () => IAsyncDelegationService | null | undefined,
  readBody: (req: IncomingMessage) => Promise<unknown>,
  json: (res: ServerResponse, data: unknown, status?: number) => void,
): void {

  route('POST', '/delegations/async', async (req, res) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Delegation service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const sourceSessionId = body.sourceSessionId as string;
    const targetWorkspaceId = body.targetWorkspaceId as string;
    const prompt = body.prompt as string;
    if (!sourceSessionId || !targetWorkspaceId || !prompt) {
      json(res, { error: 'sourceSessionId, targetWorkspaceId, prompt required' }, 400); return;
    }
    const row = svc.create({
      sourceSessionId, targetWorkspaceId, prompt,
      sourceWorkspaceId: body.sourceWorkspaceId as string | undefined,
      targetAgentId: body.targetAgentId as string | undefined,
      contextSnapshot: body.contextSnapshot as string | undefined,
      priority: body.priority as import('./contracts.js').NotificationPriority | undefined,
      timeoutMs: body.timeoutMs as number | undefined,
      parentDelegationId: body.parentDelegationId as string | undefined,
    });
    json(res, { ok: true, delegation: row });
  });

  route('POST', '/delegations/async/parallel', async (req, res) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Delegation service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const inputs = body.delegations as CreateAsyncDelegationInput[];
    if (!Array.isArray(inputs) || inputs.length === 0) {
      json(res, { error: 'delegations array required' }, 400); return;
    }
    const rows = svc.dispatchParallel(inputs);
    json(res, { ok: true, delegations: rows });
  });

  route('GET', '/delegations/async/:id', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Delegation service not available' }, 503); return; }
    const row = svc.get(params.id);
    if (!row) { json(res, { error: 'Not found' }, 404); return; }
    json(res, { ok: true, delegation: row });
  });

  route('POST', '/delegations/async/:id/accept', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Delegation service not available' }, 503); return; }
    svc.accept(params.id);
    json(res, { ok: true });
  });

  route('POST', '/delegations/async/:id/complete', async (req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Delegation service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const result = body.result as string;
    if (!result) { json(res, { error: 'result required' }, 400); return; }
    svc.complete(params.id, result);
    json(res, { ok: true });
  });

  route('POST', '/delegations/async/:id/fail', async (req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Delegation service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const error = body.error as string;
    if (!error) { json(res, { error: 'error required' }, 400); return; }
    svc.fail(params.id, error);
    json(res, { ok: true });
  });

  route('POST', '/delegations/async/:id/cancel', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Delegation service not available' }, 503); return; }
    svc.cancel(params.id);
    json(res, { ok: true });
  });

  route('GET', '/delegations/async/session/:sid', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Delegation service not available' }, 503); return; }
    json(res, { ok: true, delegations: svc.listBySession(params.sid) });
  });

  route('GET', '/delegations/async/workspace/:wsId', (_req, res, url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Delegation service not available' }, 503); return; }
    const status = url.searchParams.get('status') as AsyncDelegationStatus | null;
    json(res, { ok: true, delegations: svc.listByWorkspace(params.wsId, status ?? undefined) });
  });

  route('POST', '/delegations/async/aggregate', async (req, res) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Delegation service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const ids = body.delegationIds as string[];
    if (!Array.isArray(ids)) { json(res, { error: 'delegationIds array required' }, 400); return; }
    json(res, { ok: true, ...svc.aggregateResults(ids) });
  });
}

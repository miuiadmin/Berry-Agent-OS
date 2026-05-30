import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IWorkspaceContextService } from './contracts.js';

type RouteRegistrar = (method: string, path: string, handler: (req: IncomingMessage, res: ServerResponse, url: URL, params: Record<string, string>) => void | Promise<void>) => void;

export function registerWorkspaceContextRoutes(
  route: RouteRegistrar,
  getService: () => IWorkspaceContextService | null | undefined,
  readBody: (req: IncomingMessage) => Promise<unknown>,
  json: (res: ServerResponse, data: unknown, status?: number) => void,
): void {

  route('GET', '/workspaces/:id/context', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Workspace context service not available' }, 503); return; }
    const content = svc.getContext(params.id);
    const version = svc.getCurrentVersion(params.id);
    json(res, { ok: true, content, version });
  });

  route('PUT', '/workspaces/:id/context', async (req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Workspace context service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const content = body.content as string;
    const changedBy = body.changedBy as string;
    if (!content || !changedBy) { json(res, { error: 'content and changedBy required' }, 400); return; }
    const version = svc.updateContext(params.id, content, changedBy, body.changeSummary as string | undefined);
    json(res, { ok: true, version });
  });

  route('GET', '/workspaces/:id/context/history', (_req, res, url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Workspace context service not available' }, 503); return; }
    const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
    json(res, { ok: true, history: svc.getHistory(params.id, limit) });
  });

  route('GET', '/workspaces/:id/context/version/:v', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Workspace context service not available' }, 503); return; }
    const version = parseInt(params.v, 10);
    const row = svc.getVersion(params.id, version);
    if (!row) { json(res, { error: 'Version not found' }, 404); return; }
    json(res, { ok: true, ...row });
  });

  route('POST', '/workspaces/:id/context/rollback/:v', async (req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Workspace context service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const changedBy = (body.changedBy as string) ?? 'system';
    const version = parseInt(params.v, 10);
    try {
      const newVersion = svc.rollbackToVersion(params.id, version, changedBy);
      json(res, { ok: true, version: newVersion });
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
    }
  });
}

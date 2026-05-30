import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IPluginScopeService } from './contracts.js';

type RouteRegistrar = (method: string, path: string, handler: (req: IncomingMessage, res: ServerResponse, url: URL, params: Record<string, string>) => void | Promise<void>) => void;

export function registerPluginScopeRoutes(
  route: RouteRegistrar,
  getService: () => IPluginScopeService | null | undefined,
  readBody: (req: IncomingMessage) => Promise<unknown>,
  json: (res: ServerResponse, data: unknown, status?: number) => void,
): void {

  route('POST', '/plugins/:id/promote', async (req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Plugin scope service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const targetScope = body.targetScope as 'workspace' | 'global';
    if (!targetScope || !['workspace', 'global'].includes(targetScope)) {
      json(res, { error: 'targetScope must be workspace or global' }, 400); return;
    }
    try {
      svc.promote(params.id, targetScope);
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
    }
  });

  route('POST', '/plugins/:id/demote', async (req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Plugin scope service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const targetScope = body.targetScope as 'private' | 'workspace';
    if (!targetScope || !['private', 'workspace'].includes(targetScope)) {
      json(res, { error: 'targetScope must be private or workspace' }, 400); return;
    }
    try {
      svc.demote(params.id, targetScope);
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
    }
  });

  route('POST', '/plugins/:id/share', async (req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Plugin scope service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const agentId = body.agentId as string;
    const assignedBy = (body.assignedBy as string) ?? 'system';
    if (!agentId) { json(res, { error: 'agentId required' }, 400); return; }
    svc.shareWithAgent(params.id, agentId, assignedBy);
    json(res, { ok: true });
  });

  route('DELETE', '/plugins/:id/share/:agentId', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Plugin scope service not available' }, 503); return; }
    svc.unshareFromAgent(params.id, params.agentId);
    json(res, { ok: true });
  });

  route('GET', '/plugins/discover', (_req, res, url) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Plugin scope service not available' }, 503); return; }
    const agentId = url.searchParams.get('agentId');
    const workspaceId = url.searchParams.get('workspaceId');
    if (!agentId || !workspaceId) { json(res, { error: 'agentId and workspaceId required' }, 400); return; }
    json(res, { ok: true, ...svc.discover(agentId, workspaceId) });
  });

  route('GET', '/plugins/:id/bindings', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Plugin scope service not available' }, 503); return; }
    json(res, { ok: true, bindings: svc.getBindings(params.id) });
  });

  route('POST', '/plugins/:id/toggle', async (req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Plugin scope service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const agentId = body.agentId as string;
    const enabled = body.enabled as boolean;
    if (!agentId || typeof enabled !== 'boolean') { json(res, { error: 'agentId and enabled required' }, 400); return; }
    svc.toggleBinding(params.id, agentId, enabled);
    json(res, { ok: true });
  });
}

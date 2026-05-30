import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ITemplateService, TemplateCategory } from './contracts.js';

type RouteRegistrar = (method: string, path: string, handler: (req: IncomingMessage, res: ServerResponse, url: URL, params: Record<string, string>) => void | Promise<void>) => void;

export function registerTemplateRoutes(
  route: RouteRegistrar,
  getService: () => ITemplateService | null | undefined,
  readBody: (req: IncomingMessage) => Promise<unknown>,
  json: (res: ServerResponse, data: unknown, status?: number) => void,
): void {

  route('GET', '/templates', (_req, res, url) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Template service not available' }, 503); return; }
    const category = url.searchParams.get('category') as TemplateCategory | null;
    const isPublic = url.searchParams.get('isPublic') === 'true' ? true : undefined;
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    json(res, { ok: true, templates: svc.list({ category: category ?? undefined, isPublic, limit }) });
  });

  route('POST', '/templates', async (req, res) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Template service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const ownerId = body.ownerId as string;
    const name = body.name as string;
    if (!ownerId || !name) { json(res, { error: 'ownerId and name required' }, 400); return; }
    const row = svc.create({
      ownerId, name,
      description: body.description as string | undefined,
      category: body.category as TemplateCategory | undefined,
      orgStructure: body.orgStructure ?? [],
      agentConfigs: body.agentConfigs ?? [],
      isPublic: body.isPublic as boolean | undefined,
    });
    json(res, { ok: true, template: row });
  });

  route('GET', '/templates/:id', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Template service not available' }, 503); return; }
    const row = svc.get(params.id);
    if (!row) { json(res, { error: 'Not found' }, 404); return; }
    json(res, { ok: true, template: row });
  });

  route('PUT', '/templates/:id', async (req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Template service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    try {
      svc.update(params.id, body as any);
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
    }
  });

  route('DELETE', '/templates/:id', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Template service not available' }, 503); return; }
    svc.delete(params.id);
    json(res, { ok: true });
  });

  route('POST', '/templates/save-from-workspace', async (req, res) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Template service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const workspaceId = body.workspaceId as string;
    const name = body.name as string;
    const ownerId = body.ownerId as string;
    if (!workspaceId || !name || !ownerId) { json(res, { error: 'workspaceId, name, ownerId required' }, 400); return; }
    try {
      const row = svc.saveFromWorkspace(workspaceId, name, ownerId, body.category as TemplateCategory | undefined);
      json(res, { ok: true, template: row });
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
    }
  });

  route('POST', '/templates/:id/apply', async (req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Template service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const workspaceId = body.workspaceId as string;
    if (!workspaceId) { json(res, { error: 'workspaceId required' }, 400); return; }
    try {
      svc.applyToWorkspace(params.id, workspaceId);
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
    }
  });
}

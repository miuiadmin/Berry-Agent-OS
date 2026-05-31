import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IMemoryLayerService, MemoryType, MemoryVisibility, MemoryLayer, MemoryOrigin } from './contracts.js';

type RouteRegistrar = (method: string, path: string, handler: (req: IncomingMessage, res: ServerResponse, url: URL, params: Record<string, string>) => void | Promise<void>) => void;

export function registerMemoryRoutes(
  route: RouteRegistrar,
  getService: () => IMemoryLayerService | null | undefined,
  readBody: (req: IncomingMessage) => Promise<unknown>,
  json: (res: ServerResponse, data: unknown, status?: number) => void,
): void {

  // --- Agent Memory ---

  route('GET', '/memory/agent/:agentId', (_req, res, url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Memory service not available' }, 503); return; }
    const type = url.searchParams.get('type') as MemoryType | null;
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    json(res, { ok: true, memories: svc.getAgentMemories(params.agentId, { type: type ?? undefined, limit }) });
  });

  route('POST', '/memory/agent', async (req, res) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Memory service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const agentId = body.agentId as string;
    const content = body.content as string;
    if (!agentId || !content) { json(res, { error: 'agentId and content required' }, 400); return; }
    const row = svc.createAgentMemory({
      agentId,
      workspaceId: body.workspaceId as string | undefined,
      type: (body.type as MemoryType) ?? 'knowledge',
      content,
      source: body.source as string | undefined,
      importance: body.importance as number | undefined,
    });
    json(res, { ok: true, memory: row });
  });

  // --- Workspace Memory ---

  route('GET', '/memory/workspace/:wsId', (_req, res, url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Memory service not available' }, 503); return; }
    const visibility = url.searchParams.get('visibility') as MemoryVisibility | null;
    const type = url.searchParams.get('type') as MemoryType | null;
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    json(res, { ok: true, memories: svc.getWorkspaceMemories(params.wsId, { visibility: visibility ?? undefined, type: type ?? undefined, limit }) });
  });

  route('POST', '/memory/workspace', async (req, res) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Memory service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const workspaceId = body.workspaceId as string;
    const content = body.content as string;
    if (!workspaceId || !content) { json(res, { error: 'workspaceId and content required' }, 400); return; }
    const row = svc.createWorkspaceMemory({
      workspaceId,
      ownerAgentId: body.ownerAgentId as string | undefined,
      type: (body.type as MemoryType) ?? 'knowledge',
      content,
      origin: body.origin as MemoryOrigin | undefined,
      visibility: body.visibility as MemoryVisibility | undefined,
      importance: body.importance as number | undefined,
      tags: body.tags as string[] | undefined,
      sourceMemoryId: body.sourceMemoryId as string | undefined,
    });
    json(res, { ok: true, memory: row });
  });

  // --- Global Memory ---

  route('GET', '/memory/global/:userId', (_req, res, url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Memory service not available' }, 503); return; }
    const type = url.searchParams.get('type') as MemoryType | null;
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    json(res, { ok: true, memories: svc.getGlobalMemories(params.userId, { type: type ?? undefined, limit }) });
  });

  route('POST', '/memory/global', async (req, res) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Memory service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const userId = body.userId as string;
    const content = body.content as string;
    if (!userId || !content) { json(res, { error: 'userId and content required' }, 400); return; }
    const row = svc.createGlobalMemory({
      userId,
      type: (body.type as MemoryType) ?? 'knowledge',
      content,
      origin: body.origin as Exclude<MemoryOrigin, 'imported'> | undefined,
      sourceWorkspaceId: body.sourceWorkspaceId as string | undefined,
      sourceMemoryId: body.sourceMemoryId as string | undefined,
      importance: body.importance as number | undefined,
      tags: body.tags as string[] | undefined,
    });
    json(res, { ok: true, memory: row });
  });

  // --- Promotion ---

  route('POST', '/memory/:id/promote', async (req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Memory service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const targetLayer = body.targetLayer as string;
    try {
      if (targetLayer === 'workspace') {
        const row = svc.promoteAgentToWorkspace(params.id);
        json(res, { ok: true, memory: row });
      } else if (targetLayer === 'global') {
        const userId = body.userId as string;
        if (!userId) { json(res, { error: 'userId required for global promotion' }, 400); return; }
        const row = svc.promoteWorkspaceToGlobal(params.id, userId);
        json(res, { ok: true, memory: row });
      } else {
        json(res, { error: 'targetLayer must be workspace or global' }, 400);
      }
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
    }
  });

  // --- Recall ---

  route('POST', '/memory/recall', async (req, res) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Memory service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const query = body.query as string;
    if (!query) { json(res, { error: 'query required' }, 400); return; }
    const result = svc.recall(query, {
      agentId: body.agentId as string | undefined,
      workspaceId: body.workspaceId as string | undefined,
      userId: body.userId as string | undefined,
      topK: body.topK as number | undefined,
      tokenBudget: body.tokenBudget as number | undefined,
    });
    json(res, { ok: true, ...result });
  });

  // --- Bindings ---

  route('GET', '/memory/agent/:agentId/bindings', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Memory service not available' }, 503); return; }
    json(res, { ok: true, bindings: svc.getAgentBindings(params.agentId) });
  });

  route('POST', '/memory/bind', async (req, res) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Memory service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const agentId = body.agentId as string;
    const memoryId = body.memoryId as string;
    const layer = body.layer as MemoryLayer;
    const source = (body.source as string) ?? 'manual';
    if (!agentId || !memoryId || !layer) { json(res, { error: 'agentId, memoryId, layer required' }, 400); return; }
    svc.bindToAgent(agentId, memoryId, layer, source);
    json(res, { ok: true });
  });

  route('DELETE', '/memory/bind/:agentId/:memoryId', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Memory service not available' }, 503); return; }
    svc.unbindFromAgent(params.agentId, params.memoryId);
    json(res, { ok: true });
  });

  // --- Update/Delete/Verify ---

  route('PUT', '/memory/:layer/:id', async (req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Memory service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const layer = params.layer as MemoryLayer;
    try {
      const updates = {
        content: body.content as string | undefined,
        importance: body.importance as number | undefined,
        type: body.type as MemoryType | undefined,
        visibility: body.visibility as MemoryVisibility | undefined,
      };
      switch (layer) {
        case 'agent': svc.updateAgentMemory(params.id, updates); break;
        case 'workspace': svc.updateWorkspaceMemory(params.id, updates); break;
        case 'global': svc.updateGlobalMemory(params.id, updates); break;
        default: json(res, { error: 'invalid layer' }, 400); return;
      }
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
    }
  });

  route('DELETE', '/memory/:layer/:id', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Memory service not available' }, 503); return; }
    const layer = params.layer as MemoryLayer;
    switch (layer) {
      case 'agent': svc.deleteAgentMemory(params.id); break;
      case 'workspace': svc.deleteWorkspaceMemory(params.id); break;
      case 'global': svc.deleteGlobalMemory(params.id); break;
      default: json(res, { error: 'invalid layer' }, 400); return;
    }
    json(res, { ok: true });
  });

  route('POST', '/memory/:id/verify', async (req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Memory service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const layer = body.layer as MemoryLayer;
    if (!layer) { json(res, { error: 'layer required' }, 400); return; }
    svc.verifyMemory(params.id, layer);
    json(res, { ok: true });
  });
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ITeamBuilderService } from './contracts.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('api:team-builder');

type RouteRegistrar = (method: string, path: string, handler: (req: IncomingMessage, res: ServerResponse, url: URL, params: Record<string, string>) => void | Promise<void>) => void;

export function registerTeamBuilderRoutes(
  route: RouteRegistrar,
  getService: () => ITeamBuilderService | null | undefined,
  readBody: (req: IncomingMessage) => Promise<unknown>,
  json: (res: ServerResponse, data: unknown, status?: number) => void,
): void {

  route('POST', '/team-builder/start', async (req, res) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Team builder service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const requirements = body.requirements as string;
    const userId = (body.userId as string) ?? 'default';
    if (!requirements) { json(res, { error: 'requirements required' }, 400); return; }
    try {
      const session = await svc.startSession(userId, requirements);
      json(res, { ok: true, session });
    } catch (err) {
      logger.debug({ err }, 'Team builder session start failed');
      json(res, { error: (err as Error).message }, 500);
    }
  });

  route('POST', '/team-builder/:sessionId/refine', async (req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Team builder service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const feedback = body.feedback as string;
    if (!feedback) { json(res, { error: 'feedback required' }, 400); return; }
    try {
      const session = await svc.refineSession(params.sessionId, feedback);
      json(res, { ok: true, session });
    } catch (err) {
      logger.debug({ err }, 'Team builder session refine failed');
      json(res, { error: (err as Error).message }, 400);
    }
  });

  route('GET', '/team-builder/:sessionId/preview', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Team builder service not available' }, 503); return; }
    const plan = svc.previewPlan(params.sessionId);
    if (!plan) { json(res, { error: 'No plan available' }, 404); return; }
    json(res, { ok: true, plan });
  });

  route('POST', '/team-builder/:sessionId/approve', async (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Team builder service not available' }, 503); return; }
    try {
      const result = await svc.approvePlan(params.sessionId);
      json(res, { ok: true, ...result });
    } catch (err) {
      logger.debug({ err }, 'Team builder plan approve failed');
      json(res, { error: (err as Error).message }, 500);
    }
  });

  route('DELETE', '/team-builder/:sessionId', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Team builder service not available' }, 503); return; }
    svc.cancelSession(params.sessionId);
    json(res, { ok: true });
  });
}

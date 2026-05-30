import type { IncomingMessage, ServerResponse } from 'node:http';
import type { INotificationService } from './contracts.js';

type RouteRegistrar = (method: string, path: string, handler: (req: IncomingMessage, res: ServerResponse, url: URL, params: Record<string, string>) => void | Promise<void>) => void;

export function registerNotificationRoutes(
  route: RouteRegistrar,
  getService: () => INotificationService | null | undefined,
  readBody: (req: IncomingMessage) => Promise<unknown>,
  json: (res: ServerResponse, data: unknown, status?: number) => void,
): void {

  route('GET', '/notifications', (_req, res, url) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Notification service not available' }, 503); return; }
    const targetType = url.searchParams.get('targetType') ?? 'user';
    const targetId = url.searchParams.get('targetId');
    if (!targetId) { json(res, { error: 'targetId required' }, 400); return; }
    const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const workspaceId = url.searchParams.get('workspaceId') ?? undefined;
    json(res, { ok: true, notifications: svc.getForTarget(targetType, targetId, { unreadOnly, limit, workspaceId }) });
  });

  route('GET', '/notifications/count', (_req, res, url) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Notification service not available' }, 503); return; }
    const targetType = url.searchParams.get('targetType') ?? 'user';
    const targetId = url.searchParams.get('targetId');
    if (!targetId) { json(res, { error: 'targetId required' }, 400); return; }
    const workspaceId = url.searchParams.get('workspaceId') ?? undefined;
    json(res, { ok: true, count: svc.getUnreadCount(targetType, targetId, workspaceId) });
  });

  route('POST', '/notifications/:id/read', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Notification service not available' }, 503); return; }
    svc.markRead(params.id);
    json(res, { ok: true });
  });

  route('POST', '/notifications/read-all', async (req, res) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Notification service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const targetType = (body.targetType as string) ?? 'user';
    const targetId = body.targetId as string;
    if (!targetId) { json(res, { error: 'targetId required' }, 400); return; }
    const workspaceId = body.workspaceId as string | undefined;
    svc.markAllRead(targetType, targetId, workspaceId);
    json(res, { ok: true });
  });

  route('POST', '/notifications/:id/archive', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Notification service not available' }, 503); return; }
    svc.archive(params.id);
    json(res, { ok: true });
  });

  route('GET', '/notifications/preferences/:workspaceId', (_req, res, url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Notification service not available' }, 503); return; }
    const userId = url.searchParams.get('userId');
    if (!userId) { json(res, { error: 'userId required' }, 400); return; }
    json(res, { ok: true, preferences: svc.getPreferences(params.workspaceId, userId) });
  });

  route('PUT', '/notifications/preferences/:workspaceId', async (req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Notification service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const userId = body.userId as string;
    if (!userId) { json(res, { error: 'userId required' }, 400); return; }
    const preferences = body.preferences as Record<string, string>;
    svc.updatePreferences(params.workspaceId, userId, preferences as any);
    json(res, { ok: true });
  });

  route('GET', '/tasks/:id/subscribers', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Notification service not available' }, 503); return; }
    json(res, { ok: true, subscribers: svc.getSubscribers(params.id) });
  });

  route('POST', '/tasks/:id/subscribe', async (req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Notification service not available' }, 503); return; }
    const body = await readBody(req) as Record<string, unknown>;
    const subscriberType = (body.subscriberType as string) ?? 'user';
    const subscriberId = body.subscriberId as string;
    const reason = (body.reason as string) ?? 'manual';
    if (!subscriberId) { json(res, { error: 'subscriberId required' }, 400); return; }
    svc.subscribe(params.id, subscriberType, subscriberId, reason as any);
    json(res, { ok: true });
  });

  route('DELETE', '/tasks/:id/subscribe/:subscriberId', (_req, res, _url, params) => {
    const svc = getService();
    if (!svc) { json(res, { error: 'Notification service not available' }, 503); return; }
    svc.unsubscribe(params.id, params.subscriberId);
    json(res, { ok: true });
  });
}

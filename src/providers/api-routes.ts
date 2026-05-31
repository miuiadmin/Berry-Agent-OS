/**
 * Provider Management Module — API Routes
 *
 * HTTP endpoints for provider channel management, model catalog browsing,
 * tier mapping, and connection testing.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IProviderRegistry } from './contract.js';
import type { ProviderKind, AnyProviderKind } from './types.js';
import { SUPPORTED_PROVIDER_KINDS, ALL_PROVIDER_KINDS } from './types.js';
import { getBuiltinCatalog } from './catalogs/index.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('provider-api');

type RouteRegistrar = (method: string, path: string, handler: (req: IncomingMessage, res: ServerResponse, url: URL, params: Record<string, string>) => void | Promise<void>) => void;

/** Mask an API key for safe display — show first 8 chars + "..." */
function maskApiKey(key?: string): string | undefined {
  if (!key) return undefined;
  if (key.length <= 8) return '***';
  return `${key.slice(0, 8)}...`;
}

export function registerProviderRoutes(
  route: RouteRegistrar,
  getRegistry: () => IProviderRegistry | null | undefined,
  _readBody: (req: IncomingMessage) => Promise<unknown>,
  json: (res: ServerResponse, data: unknown, status?: number) => void,
  configService?: { updateSection(partial: Record<string, unknown>): { ok: boolean; error?: string } } | null,
): void {

  // Helper: persist current registry state to config.yaml
  const persist = () => {
    if (!configService) return;
    const r = getRegistry();
    if (!r) return;
    configService.updateSection({
      llm: { channelsConfig: { channels: r.listChannels(), tiers: r.getTierMapping() } },
    });
  };

  // ─── List all channels with their models ──────────────────────────

  route('GET', '/providers/channels', (_req, res) => {
    const registry = getRegistry();
    if (!registry) { json(res, { error: 'Provider registry not available' }, 503); return; }

    const channels = registry.listChannels();
    const result = channels.map(ch => ({
      id: ch.id,
      name: ch.name,
      kind: ch.kind,
      baseUrl: ch.baseUrl || undefined,
      apiKey: maskApiKey(ch.apiKey),
      enabled: ch.enabled,
      configured: registry.isChannelConfigured(ch.id),
      modelCount: registry.getModels(ch.id).length,
      models: registry.getModels(ch.id),
    }));

    json(res, { ok: true, channels: result });
  });

  // ─── Get a specific channel ──────────────────────────────────────

  route('GET', '/providers/channels/:channelId', (_req, res, _url, params) => {
    const registry = getRegistry();
    if (!registry) { json(res, { error: 'Provider registry not available' }, 503); return; }

    const channel = registry.getChannel(params.channelId);
    if (!channel) { json(res, { error: 'Channel not found' }, 404); return; }

    json(res, {
      ok: true,
      channel: {
        ...channel,
        apiKey: maskApiKey(channel.apiKey),
        models: registry.getModels(channel.id),
      },
    });
  });

  // ─── Get current tier mapping ────────────────────────────────────

  route('GET', '/providers/tiers', (_req, res) => {
    const registry = getRegistry();
    if (!registry) { json(res, { error: 'Provider registry not available' }, 503); return; }

    json(res, { ok: true, tiers: registry.getTierMapping() });
  });

  // ─── Get built-in model catalog for a provider kind ──────────────

  route('GET', '/providers/catalogs/:kind', (_req, res, _url, params) => {
    const kind = params.kind as AnyProviderKind;
    if (!ALL_PROVIDER_KINDS.includes(kind)) {
      json(res, { error: `Unknown provider kind: ${kind}`, validKinds: ALL_PROVIDER_KINDS }, 400);
      return;
    }

    const catalog = getBuiltinCatalog(kind);
    json(res, { ok: true, kind, models: catalog });
  });

  // ─── List all available provider kinds ───────────────────────────

  route('GET', '/providers/kinds', (_req, res) => {
    json(res, { ok: true, kinds: ALL_PROVIDER_KINDS, supported: SUPPORTED_PROVIDER_KINDS });
  });

  // ─── Test channel connection ─────────────────────────────────────

  route('POST', '/providers/channels/:channelId/test', async (_req, res, _url, params) => {
    const registry = getRegistry();
    if (!registry) { json(res, { error: 'Provider registry not available' }, 503); return; }

    const channel = registry.getChannel(params.channelId);
    if (!channel) { json(res, { error: 'Channel not found' }, 404); return; }

    try {
      const tiers = registry.getTierMapping();
      const tierEntry = Object.values(tiers).find(t => t.channel === channel.id);
      const userModelIds = channel.models?.map(m => m.id) ?? [];
      const catalogModels = registry.getModels(channel.id);
      const testModelId = tierEntry?.model ?? userModelIds[0] ?? catalogModels[0]?.id;
      if (!testModelId) {
        json(res, { ok: false, error: 'No models available for testing' });
        return;
      }

      const model = registry.createModelFor(channel.id, testModelId);
      const { generateText } = await import('ai');
      const startTime = Date.now();
      const result = await generateText({
        model,
        prompt: 'Say "ok" and nothing else.',
        maxOutputTokens: 10,
      });
      const latencyMs = Date.now() - startTime;

      json(res, {
        ok: true,
        message: `Channel "${channel.name}" connected successfully`,
        channelId: channel.id,
        modelId: testModelId,
        latencyMs,
        responsePreview: result.text.slice(0, 50),
      });
    } catch (err) {
      logger.warn({ err, channelId: params.channelId }, 'Channel test failed');
      const httpStatus = (err as any)?.statusCode ?? (err as any)?.status;
      json(res, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        channelId: params.channelId,
        httpStatus,
      }, 400);
    }
  });

  // ─── Create channel ──────────────────────────────────────────────

  route('POST', '/providers/channels', async (req, res) => {
    const registry = getRegistry();
    if (!registry) { json(res, { error: 'Provider registry not available' }, 503); return; }

    const body = await _readBody(req) as Record<string, unknown>;
    if (!body.id || !body.kind) { json(res, { error: 'Missing required fields: id, kind' }, 400); return; }

    if (!SUPPORTED_PROVIDER_KINDS.includes(body.kind as ProviderKind)) {
      json(res, { error: `Unsupported provider kind: "${body.kind}". Supported: ${SUPPORTED_PROVIDER_KINDS.join(', ')}` }, 400);
      return;
    }

    try {
      registry.addChannel({
        id: String(body.id),
        name: String(body.name ?? body.id),
        kind: body.kind as ProviderKind,
        baseUrl: body.baseUrl ? String(body.baseUrl) : undefined,
        apiKey: body.apiKey ? String(body.apiKey) : undefined,
        enabled: body.enabled !== false,
        models: Array.isArray(body.models) ? body.models : undefined,
      });
      persist();
      json(res, { ok: true, channelId: body.id });
    } catch (err) {
      logger.warn({ err }, 'Channel creation failed');
      json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ─── Update channel ──────────────────────────────────────────────

  route('PUT', '/providers/channels/:channelId', async (req, res, _url, params) => {
    const registry = getRegistry();
    if (!registry) { json(res, { error: 'Provider registry not available' }, 503); return; }

    const body = await _readBody(req) as Record<string, unknown>;
    const updated = registry.updateChannel(params.channelId, body as Partial<import('./types.js').ProviderChannel>);
    if (!updated) { json(res, { error: 'Channel not found' }, 404); return; }
    persist();
    json(res, { ok: true });
  });

  // ─── Delete channel ──────────────────────────────────────────────

  route('DELETE', '/providers/channels/:channelId', (_req, res, _url, params) => {
    const registry = getRegistry();
    if (!registry) { json(res, { error: 'Provider registry not available' }, 503); return; }

    const removed = registry.removeChannel(params.channelId);
    if (!removed) { json(res, { error: 'Channel not found' }, 404); return; }
    persist();
    json(res, { ok: true });
  });

  // ─── Update tier mapping ─────────────────────────────────────────

  route('PUT', '/providers/tiers', async (req, res) => {
    const registry = getRegistry();
    if (!registry) { json(res, { error: 'Provider registry not available' }, 503); return; }

    const body = await _readBody(req) as Record<string, unknown>;
    registry.setTierMapping(body as Partial<import('./types.js').TierMapping>);
    persist();
    json(res, { ok: true, tiers: registry.getTierMapping() });
  });
}

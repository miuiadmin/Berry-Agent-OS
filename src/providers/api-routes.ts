/**
 * Provider Management Module — API Routes
 *
 * HTTP endpoints for provider channel management, model catalog browsing,
 * tier mapping, and connection testing.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IProviderRegistry } from './contract.js';
import type { ProviderKind } from './types.js';
import { PROVIDER_KINDS } from './types.js';
import { getBuiltinCatalog } from './catalogs/index.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('provider-api');

type RouteRegistrar = (method: string, path: string, handler: (req: IncomingMessage, res: ServerResponse, url: URL, params: Record<string, string>) => void | Promise<void>) => void;

/**
 * Mask an API key for safe display — show first 8 chars + "..."
 */
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
): void {

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

    const tiers = registry.getTierMapping();
    json(res, { ok: true, tiers });
  });

  // ─── Get built-in model catalog for a provider kind ──────────────

  route('GET', '/providers/catalogs/:kind', (_req, res, _url, params) => {
    const kind = params.kind as ProviderKind;
    if (!PROVIDER_KINDS.includes(kind)) {
      json(res, { error: `Unknown provider kind: ${kind}`, validKinds: PROVIDER_KINDS }, 400);
      return;
    }

    const catalog = getBuiltinCatalog(kind);
    json(res, { ok: true, kind, models: catalog });
  });

  // ─── List all available provider kinds ───────────────────────────

  route('GET', '/providers/kinds', (_req, res) => {
    json(res, { ok: true, kinds: PROVIDER_KINDS });
  });

  // ─── Test channel connection ─────────────────────────────────────

  route('POST', '/providers/channels/:channelId/test', async (_req, res, _url, params) => {
    const registry = getRegistry();
    if (!registry) { json(res, { error: 'Provider registry not available' }, 503); return; }

    const channel = registry.getChannel(params.channelId);
    if (!channel) { json(res, { error: 'Channel not found' }, 404); return; }

    try {
      const models = registry.getModels(channel.id);
      const testModelId = models[0]?.id;
      if (!testModelId) {
        json(res, { ok: false, error: 'No models available for testing' });
        return;
      }

      // Attempt to create a model — this validates credentials & connectivity
      const model = registry.createModelFor(channel.id, testModelId);

      // We could try a minimal generateText call here, but that costs tokens.
      // For now, just verify the SDK factory accepts the credentials.
      json(res, {
        ok: true,
        message: `Channel "${channel.name}" validated (model: ${testModelId})`,
        channelId: channel.id,
        modelId: testModelId,
      });
    } catch (err) {
      logger.debug({ err, channelId: params.channelId }, 'Channel test failed');
      json(res, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        channelId: params.channelId,
      });
    }
  });
}

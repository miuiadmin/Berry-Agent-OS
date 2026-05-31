/**
 * Provider Management Module — Legacy Config Migration
 *
 * Converts old-format LlmConfig (single provider with providers.anthropic etc.)
 * into the new ChannelsConfig format. This migration is in-memory only —
 * no config files are modified.
 */

import { MODEL_TIERS } from '../contracts/model.js';
import type { LlmConfig } from '../llm/types.js';
import type { ProviderChannel, TierMapping, ProviderKind } from './types.js';
import { hasCredentials } from './types.js';

/**
 * Migrate a legacy LlmConfig into new-format channels + tier mapping.
 *
 * Creates one synthetic channel per configured provider that has credentials,
 * and derives tier targets from the old models/tier config.
 */
export function migrateLegacyConfig(llmConfig: LlmConfig): {
  channels: ProviderChannel[];
  tiers: TierMapping;
} {
  const channels: ProviderChannel[] = [];
  const tiers: TierMapping = {};

  // Determine the active provider
  const activeProvider = llmConfig.provider;
  const providerCfg = llmConfig.providers[activeProvider];

  // Create the primary channel from the active provider
  const channelId = `${activeProvider}-default`;
  const kind = mapLegacyProviderToKind(activeProvider);

  channels.push({
    id: channelId,
    name: `${activeProvider} (migrated)`,
    kind,
    baseUrl: providerCfg.baseUrl || llmConfig.baseUrl || undefined,
    apiKey: providerCfg.apiKey || llmConfig.apiKey || undefined,
    enabled: true,
    models: undefined, // Use built-in catalog
  });

  // Map tier models to targets
  for (const tier of MODEL_TIERS) {
    // Try provider-specific tier model, then legacy tier model, then legacy default model
    const modelId =
      providerCfg.models[tier] ??
      llmConfig.models[tier] ??
      providerCfg.defaultModel ??
      llmConfig.model ??
      undefined;

    if (modelId) {
      tiers[tier] = { channel: channelId, model: modelId };
    }
  }

  // Only create channels for other providers that have REAL credentials
  // (non-empty apiKey or non-empty baseUrl — schema defaults produce empty strings)
  const providerNames = ['anthropic', 'openai', 'openai-compatible'] as const;
  for (const name of providerNames) {
    if (name === activeProvider) continue; // Already handled above

    const cfg = llmConfig.providers[name];
    const hasRealCreds = hasCredentials(cfg) || (!!cfg.baseUrl && cfg.baseUrl.trim() !== '');
    if (hasRealCreds) {
      channels.push({
        id: `${name}-default`,
        name: `${name} (migrated)`,
        kind: mapLegacyProviderToKind(name),
        baseUrl: cfg.baseUrl || undefined,
        apiKey: cfg.apiKey || undefined,
        enabled: true,
      });
    }
  }

  return { channels, tiers };
}

/**
 * Map the legacy provider names to the new ProviderKind enum.
 */
function mapLegacyProviderToKind(legacy: string): ProviderKind {
  switch (legacy) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'openai-compatible':
      return 'openai-compatible';
    default:
      return 'openai-compatible'; // Safe default for unknown providers
  }
}

/**
 * Check if the channels config is effectively empty (no channels configured).
 * Used to decide whether to fall back to legacy migration.
 */
export function isChannelsEmpty(channelsConfig: { channels?: unknown[]; tiers?: unknown }): boolean {
  return !channelsConfig.channels || channelsConfig.channels.length === 0;
}

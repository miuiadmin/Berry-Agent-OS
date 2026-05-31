/**
 * Provider Management Module — Tier Resolver
 *
 * The core resolution pipeline: ModelTier → TierTarget → Channel + Model.
 * Handles the three-level fallback: new config → legacy config → built-in defaults.
 */

import { MODEL_TIERS } from '../contracts/model.js';
import type { ModelTier } from '../contracts/model.js';
import { resolveModel } from '../llm/types.js';
import type { LlmConfig } from '../llm/types.js';
import type { ProviderChannel, ModelEntry, TierMapping, ResolvedModel, ProviderKind } from './types.js';
import { mergeCatalog } from './catalogs/index.js';
import { migrateLegacyConfig, isChannelsEmpty } from './migration.js';

// ─── Fallback Model Entry ─────────────────────────────────────────
// Used when a model ID is referenced but not found in any catalog.

const FALLBACK_MODEL: ModelEntry = {
  id: 'unknown',
  name: 'Unknown Model',
  contextWindow: 128_000,
  defaultMaxTokens: 4_096,
  supportsThinking: false,
  supportsAttachments: false,
};

// ─── Resolver State ───────────────────────────────────────────────

export interface ResolverState {
  channels: Map<string, ProviderChannel>;
  tiers: TierMapping;
  legacyConfig: LlmConfig | null;
}

// ─── Build Resolver State ─────────────────────────────────────────

export function buildResolverState(
  llmConfig: LlmConfig,
  channelsConfig?: { channels?: ProviderChannel[]; tiers?: TierMapping } | null,
): ResolverState {
  // Try new-format channels first
  if (channelsConfig && !isChannelsEmpty(channelsConfig)) {
    const channelMap = new Map<string, ProviderChannel>();
    for (const ch of channelsConfig.channels ?? []) {
      channelMap.set(ch.id, ch);
    }
    return {
      channels: channelMap,
      tiers: channelsConfig.tiers ?? {},
      legacyConfig: llmConfig,
    };
  }

  // Fall back to legacy migration
  const migrated = migrateLegacyConfig(llmConfig);
  const channelMap = new Map<string, ProviderChannel>();
  for (const ch of migrated.channels) {
    channelMap.set(ch.id, ch);
  }
  return {
    channels: channelMap,
    tiers: migrated.tiers,
    legacyConfig: llmConfig,
  };
}

// ─── Resolve Tier ─────────────────────────────────────────────────

/**
 * Resolve a ModelTier to a concrete ResolvedModel.
 *
 * Priority:
 * 1. New tier mapping → channel lookup → catalog merge
 * 2. Legacy config → resolveModel() → synthetic channel
 * 3. Built-in DEFAULT_TIER_MODELS
 */
export function resolveTier(
  state: ResolverState,
  tier: ModelTier,
): ResolvedModel {
  // 1. Try new tier mapping
  const target = state.tiers[tier];
  if (target) {
    const channel = state.channels.get(target.channel);
    if (channel) {
      const models = mergeCatalog(channel.kind, channel.models);
      const model = models.find(m => m.id === target.model) ?? {
        ...FALLBACK_MODEL,
        id: target.model,
        name: target.model,
      };
      return { channel, model, providerKind: channel.kind };
    }
  }

  // 2. Legacy fallback
  if (state.legacyConfig) {
    const legacyChannelId = `${state.legacyConfig.provider}-default`;
    const channel = state.channels.get(legacyChannelId);
    if (channel) {
      const modelId = resolveModel(state.legacyConfig, tier);
      const models = mergeCatalog(channel.kind, channel.models);
      const model = models.find(m => m.id === modelId) ?? {
        ...FALLBACK_MODEL,
        id: modelId,
        name: modelId,
      };
      return { channel, model, providerKind: channel.kind };
    }
  }

  // 3. This should never happen if migration works correctly, but just in case
  throw new Error(
    `No model configured for tier "${tier}". ` +
    'Please configure provider channels in config.yaml or set LLM environment variables.',
  );
}

/**
 * Resolve a specific channel + model combination.
 */
export function resolveChannelModel(
  state: ResolverState,
  channelId: string,
  modelId: string,
): ResolvedModel {
  const channel = state.channels.get(channelId);
  if (!channel) {
    throw new Error(`Channel not found: "${channelId}"`);
  }

  const models = mergeCatalog(channel.kind, channel.models);
  const model = models.find(m => m.id === modelId) ?? {
    ...FALLBACK_MODEL,
    id: modelId,
    name: modelId,
  };

  return { channel, model, providerKind: channel.kind };
}

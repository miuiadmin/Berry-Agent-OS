/**
 * Provider Management Module — Provider Registry
 *
 * Implements IProviderRegistry. This is the central orchestrator that:
 * - Manages provider channels
 * - Resolves model tiers to concrete channel + model
 * - Creates AI SDK LanguageModelV3 instances
 * - Provides model catalog browsing
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { ModelTier } from '../contracts/model.js';
import type { LlmConfig } from '../llm/types.js';
import { normalizeBaseUrl } from './url-normalizer.js';
import type { IProviderRegistry } from './contract.js';
import type { ProviderChannel, ModelEntry, TierMapping, ResolvedModel, ProviderKind } from './types.js';
import { ChannelsConfigSchema } from './schemas.js';
import { buildResolverState, resolveTier, resolveChannelModel, type ResolverState } from './resolver.js';
import { getBuiltinCatalog, mergeCatalog } from './catalogs/index.js';
import { migrateLegacyConfig, isChannelsEmpty } from './migration.js';

export class ProviderRegistry implements IProviderRegistry {
  private state: ResolverState;
  private rawChannels: ProviderChannel[];
  private rawTiers: TierMapping;
  private readonly onMutate?: (channels: ProviderChannel[], tiers: TierMapping) => void;

  constructor(llmConfig: LlmConfig, channelsConfig?: unknown, onMutate?: (channels: ProviderChannel[], tiers: TierMapping) => void) {
    // Validate channels config through Zod
    const parsed = channelsConfig
      ? ChannelsConfigSchema.safeParse(channelsConfig)
      : null;

    let validChannels = parsed?.success ? parsed.data : undefined;

    // If no explicit channels, migrate legacy config to synthetic channels
    if (!validChannels || isChannelsEmpty(validChannels)) {
      const migrated = migrateLegacyConfig(llmConfig);
      if (migrated.channels.length > 0) {
        // Validate migration output through Zod for consistent types
        const migratedParsed = ChannelsConfigSchema.safeParse(migrated);
        validChannels = migratedParsed.success ? migratedParsed.data : undefined;
      }
    }

    this.onMutate = onMutate;
    this.state = buildResolverState(llmConfig, validChannels);
    this.rawChannels = validChannels?.channels ?? [];
    this.rawTiers = validChannels?.tiers ?? {};
  }

  // ─── IProviderRegistry Implementation ───────────────────────────

  resolve(tier: ModelTier): ResolvedModel {
    return resolveTier(this.state, tier);
  }

  listChannels(): ProviderChannel[] {
    return Array.from(this.state.channels.values());
  }

  getChannel(id: string): ProviderChannel | undefined {
    return this.state.channels.get(id);
  }

  getModels(channelId: string): ModelEntry[] {
    const channel = this.state.channels.get(channelId);
    if (!channel) return [];
    if (!channel.apiKey || channel.apiKey.trim() === '') return [];
    return mergeCatalog(channel.kind, channel.models);
  }

  isChannelConfigured(channelId: string): boolean {
    const channel = this.state.channels.get(channelId);
    return !!(channel?.apiKey && channel.apiKey.trim() !== '');
  }

  getTierMapping(): TierMapping {
    return this.rawTiers;
  }

  createModel(tier: ModelTier): LanguageModelV3 {
    const resolved = this.resolve(tier);
    return this.createSdkModel(resolved);
  }

  createModelFor(channelId: string, modelId: string): LanguageModelV3 {
    const resolved = resolveChannelModel(this.state, channelId, modelId);
    return this.createSdkModel(resolved);
  }

  getBuiltinCatalog(kind: ProviderKind): ModelEntry[] {
    return getBuiltinCatalog(kind);
  }

  // ─── Mutations (runtime channel management) ─────────────────────

  addChannel(channel: ProviderChannel): void {
    if (this.state.channels.has(channel.id)) {
      throw new Error(`Channel "${channel.id}" already exists`);
    }
    this.state.channels.set(channel.id, channel);
    this.rawChannels.push(channel);
    this.onMutate?.(this.rawChannels, this.rawTiers);
  }

  updateChannel(id: string, updates: Partial<ProviderChannel>): boolean {
    const existing = this.state.channels.get(id);
    if (!existing) return false;
    const updated = { ...existing, ...updates, id };
    this.state.channels.set(id, updated);
    const idx = this.rawChannels.findIndex(c => c.id === id);
    if (idx >= 0) this.rawChannels[idx] = updated;
    this.onMutate?.(this.rawChannels, this.rawTiers);
    return true;
  }

  removeChannel(id: string): boolean {
    const existed = this.state.channels.has(id);
    this.state.channels.delete(id);
    this.rawChannels = this.rawChannels.filter(c => c.id !== id);
    if (existed) this.onMutate?.(this.rawChannels, this.rawTiers);
    return existed;
  }

  setTierMapping(tiers: Partial<TierMapping>): void {
    if (tiers.fast) this.rawTiers.fast = tiers.fast;
    if (tiers.default) this.rawTiers.default = tiers.default;
    if (tiers.high) this.rawTiers.high = tiers.high;
    this.state = buildResolverState(this.state.legacyConfig!, { channels: this.rawChannels, tiers: this.rawTiers });
    this.onMutate?.(this.rawChannels, this.rawTiers);
  }

  // ─── Hot-reload ──────────────────────────────────────────────────

  /** Rebuild internal resolver state with updated config. */
  rebuild(llmConfig: LlmConfig, channelsConfig?: unknown): void {
    const parsed = channelsConfig
      ? ChannelsConfigSchema.safeParse(channelsConfig)
      : null;

    let validChannels = parsed?.success ? parsed.data : undefined;

    if (!validChannels || isChannelsEmpty(validChannels)) {
      const migrated = migrateLegacyConfig(llmConfig);
      if (migrated.channels.length > 0) {
        const migratedParsed = ChannelsConfigSchema.safeParse(migrated);
        validChannels = migratedParsed.success ? migratedParsed.data : undefined;
      }
    }

    this.state = buildResolverState(llmConfig, validChannels);
    this.rawChannels = validChannels?.channels ?? [];
    this.rawTiers = validChannels?.tiers ?? {};
  }

  // ─── SDK Model Factory ──────────────────────────────────────────

  private createSdkModel(resolved: ResolvedModel): LanguageModelV3 {
    const { channel, model, providerKind } = resolved;

    switch (providerKind) {
      case 'anthropic': {
        const factory = createAnthropic({
          baseURL: normalizeBaseUrl(channel.baseUrl, providerKind),
          apiKey: channel.apiKey || undefined,
        });
        return factory(model.id);
      }

      case 'openai': {
        const factory = createOpenAI({
          baseURL: normalizeBaseUrl(channel.baseUrl, providerKind),
          apiKey: channel.apiKey || undefined,
        });
        return factory.chat(model.id);
      }

      case 'openai-compatible': {
        const factory = createOpenAI({
          baseURL: normalizeBaseUrl(channel.baseUrl, providerKind),
          apiKey: channel.apiKey || undefined,
          name: 'openai-compatible',
        });
        return factory.chat(model.id);
      }

      case 'google-gemini': {
        // Requires @ai-sdk/google — lazy import to avoid hard dependency
        throw new Error(
          'Google Gemini provider is not yet implemented. ' +
          'Use "openai-compatible" kind with a Gemini-compatible proxy endpoint.',
        );
      }

      case 'azure-openai':
      case 'bedrock':
        throw new Error(
          `${providerKind} provider is not yet implemented. ` +
          'Use "openai-compatible" or "anthropic" kind with appropriate baseUrl.',
        );

      default:
        throw new Error(`Unsupported provider kind: ${providerKind}`);
    }
  }
}

// ─── Factory Function ─────────────────────────────────────────────

/**
 * Create a ProviderRegistry from the app config.
 *
 * Always returns a non-null registry. When no channelsConfig is provided,
 * legacy config is automatically migrated to synthetic channels via
 * migrateLegacyConfig(). When truly no LLM config exists at all, the
 * registry will have empty channels — resolve() calls will fail with a
 * clear error message.
 */
export function createProviderRegistry(
  llmConfig: LlmConfig,
  channelsConfig?: unknown,
  onMutate?: (channels: ProviderChannel[], tiers: TierMapping) => void,
): ProviderRegistry {
  return new ProviderRegistry(llmConfig, channelsConfig, onMutate);
}

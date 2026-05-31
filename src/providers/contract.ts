/**
 * Provider Management Module — Public Contract
 *
 * Defines the interface that all consumers depend on.
 * Following the project's contract-first design: this file is the
 * single source of truth for the provider registry API.
 */

import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { ModelTier } from '../contracts/model.js';
import type {
  ProviderChannel,
  ModelEntry,
  TierMapping,
  ResolvedModel,
  ProviderKind,
} from './types.js';

/**
 * The provider registry — resolves model tiers to concrete channel + model
 * configurations and creates AI SDK model instances.
 *
 * This is the ONLY public API of the providers module. All consumers
 * (LlmClient, API routes, frontend) interact through this interface.
 */
export interface IProviderRegistry {
  /** Resolve a tier to a concrete channel + model + provider kind */
  resolve(tier: ModelTier): ResolvedModel;

  /** List all configured channels */
  listChannels(): ProviderChannel[];

  /** Get a specific channel by ID */
  getChannel(id: string): ProviderChannel | undefined;

  /** Get all models for a channel (built-in catalog + user overrides) */
  getModels(channelId: string): ModelEntry[];

  /** Get the current tier mapping */
  getTierMapping(): TierMapping;

  /** Create an AI SDK LanguageModelV3 for a given tier */
  createModel(tier: ModelTier): LanguageModelV3;

  /** Create an AI SDK LanguageModelV3 for a specific channel + model */
  createModelFor(channelId: string, modelId: string): LanguageModelV3;

  /** Get the built-in model catalog for a provider kind */
  getBuiltinCatalog(kind: ProviderKind): ModelEntry[];
}

/**
 * Provider Management Module — Public Types
 *
 * Defines the core data structures for multi-channel provider management,
 * built-in model catalogs, and tier-to-model resolution.
 */

import type { ModelTier } from '../contracts/model.js';

// ─── Provider Kind ────────────────────────────────────────────────
// The SDK adapter type — determines which AI SDK factory creates the LanguageModelV3.

export const PROVIDER_KINDS = [
  'anthropic',
  'openai',
  'openai-compatible',
  'google-gemini',
  'azure-openai',
  'bedrock',
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

// ─── Model Entry ──────────────────────────────────────────────────
// Full metadata for a single model, used in both built-in catalogs and user overrides.

export interface ModelEntry {
  /** The API model ID, e.g. "claude-sonnet-4-6-20250514" */
  id: string;
  /** Human-readable name, e.g. "Claude Sonnet 4.6" */
  name: string;
  /** Max input tokens (context window size) */
  contextWindow: number;
  /** Default max output tokens */
  defaultMaxTokens: number;
  /** Whether the model supports extended thinking / reasoning */
  supportsThinking: boolean;
  /** Whether the model supports image/file attachments */
  supportsAttachments: boolean;
  /** USD per 1M input tokens (optional) */
  inputPricePer1M?: number;
  /** USD per 1M output tokens (optional) */
  outputPricePer1M?: number;
}

// ─── Provider Channel ─────────────────────────────────────────────
// A named configuration instance — one logical endpoint with credentials.

export interface ProviderChannel {
  /** Unique identifier, e.g. "my-anthropic", "work-openai" */
  id: string;
  /** Human-readable label */
  name: string;
  /** Which SDK adapter to use */
  kind: ProviderKind;
  /** Optional custom base URL */
  baseUrl?: string;
  /** API key or token */
  apiKey?: string;
  /** Whether this channel is active */
  enabled: boolean;
  /** User-defined model overrides/additions (merged with built-in catalog) */
  models?: ModelEntry[];
}

// ─── Tier Mapping ─────────────────────────────────────────────────
// Maps the three-tier system (fast/default/high) to a specific channel + model.

export interface TierTarget {
  /** Channel ID to route through */
  channel: string;
  /** Model ID to use */
  model: string;
}

export interface TierMapping {
  fast?: TierTarget;
  default?: TierTarget;
  high?: TierTarget;
}

// ─── Resolved Model ───────────────────────────────────────────────
// The output of the resolution pipeline — everything needed to make an API call.

export interface ResolvedModel {
  /** The resolved channel configuration */
  channel: ProviderChannel;
  /** The resolved model metadata */
  model: ModelEntry;
  /** The SDK adapter kind */
  providerKind: ProviderKind;
}

// ─── Channels Config ──────────────────────────────────────────────
// The full configuration block stored in config.yaml under llm.channelsConfig.

export interface ChannelsConfig {
  /** Named provider channels */
  channels: ProviderChannel[];
  /** Tier → channel + model mapping */
  tiers: TierMapping;
}

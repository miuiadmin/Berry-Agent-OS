import { z } from 'zod';
import type { ModelMode, ModelTier } from '../contracts/model.js';

export const ModelsConfigSchema = z.prefault(z.object({
  fast: z.string().optional(),
  default: z.string().optional(),
  high: z.string().optional(),
}), {});

export const LLM_PROVIDERS = ['anthropic', 'openai', 'openai-compatible'] as const;
export type LlmProvider = typeof LLM_PROVIDERS[number];

const ProviderConfigSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().default(''),
  defaultModel: z.string().optional(),
  models: ModelsConfigSchema,
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

const ProvidersSchema = z.object({
  anthropic: z.prefault(ProviderConfigSchema, {}),
  openai: z.prefault(ProviderConfigSchema, {}),
  'openai-compatible': z.prefault(ProviderConfigSchema, {}),
});

export const LlmConfigSchema = z.object({
  provider: z.enum(LLM_PROVIDERS).default('anthropic'),
  providers: z.prefault(ProvidersSchema, {}),
  // New: multi-channel provider config (see src/providers/)
  channelsConfig: z.prefault(z.object({
    channels: z.array(z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      kind: z.enum(['anthropic', 'openai', 'openai-compatible', 'google-gemini', 'azure-openai', 'bedrock']),
      baseUrl: z.string().optional(),
      apiKey: z.string().default(''),
      enabled: z.boolean().default(true),
      models: z.array(z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        contextWindow: z.number().int().positive().default(128_000),
        defaultMaxTokens: z.number().int().positive().default(4_096),
        supportsThinking: z.boolean().default(false),
        supportsAttachments: z.boolean().default(false),
        inputPricePer1M: z.number().nonnegative().optional(),
        outputPricePer1M: z.number().nonnegative().optional(),
      })).default([]),
    })).default([]),
    tiers: z.prefault(z.object({
      fast: z.object({ channel: z.string().min(1), model: z.string().min(1) }).optional(),
      default: z.object({ channel: z.string().min(1), model: z.string().min(1) }).optional(),
      high: z.object({ channel: z.string().min(1), model: z.string().min(1) }).optional(),
    }), {}),
  }), {}),
  // Legacy fields — backward compat, maps to providers[provider]
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default(''),
  models: ModelsConfigSchema,
  mode: z.enum(['live', 'mock', 'replay', 'takeover']).default('live'),
  maxConcurrentRequests: z.number().default(10),
});

export type LlmConfig = z.infer<typeof LlmConfigSchema>;

const DEFAULT_TIER_MODELS: Record<LlmProvider, Record<ModelTier, string>> = {
  anthropic: {
    fast: 'claude-haiku-4-5-20251001',
    default: 'claude-sonnet-4-6-20250514',
    high: 'claude-opus-4-6-20250514',
  },
  openai: {
    fast: 'gpt-4o-mini',
    default: 'gpt-4o',
    high: 'gpt-4.1',
  },
  'openai-compatible': {
    fast: 'deepseek-chat',
    default: 'deepseek-chat',
    high: 'deepseek-reasoner',
  },
};

export function getProviderConfig(config: LlmConfig): { provider: LlmProvider; baseUrl?: string; apiKey: string; defaultModel?: string; models: Record<string, string | undefined> } {
  const provider = config.provider;
  const providerCfg = config.providers[provider];

  const baseUrl = (providerCfg.baseUrl ?? (provider === 'anthropic' ? config.baseUrl : undefined)) || undefined;
  const apiKey = providerCfg.apiKey || config.apiKey;
  const defaultModel = providerCfg.defaultModel ?? config.model;
  const models = {
    fast: providerCfg.models.fast ?? config.models.fast,
    default: providerCfg.models.default ?? config.models.default,
    high: providerCfg.models.high ?? config.models.high,
  };

  return { provider, baseUrl, apiKey, defaultModel, models };
}

export function resolveModel(config: LlmConfig, tier: ModelTier): string {
  const pc = getProviderConfig(config);
  if (pc.models[tier]) return pc.models[tier]!;
  if (pc.defaultModel) return pc.defaultModel;
  return DEFAULT_TIER_MODELS[pc.provider][tier];
}

// === Thinking Capability Detection ===

/** Thinking protocol mode per model capability */
export type ThinkingMode =
  /** Claude Opus 4.7 / Mythos Preview — only supports adaptive */
  | 'adaptive-only'
  /** Claude Opus 4.6 / Sonnet 4.6 — supports both, adaptive recommended */
  | 'adaptive-preferred'
  /** Old Claude (4.5及以下) / DeepSeek v3 — manual budget_tokens */
  | 'manual-only'
  /** DeepSeek v4 series — effort-based toggle */
  | 'effort-based-max'
  /** Non-thinking models: Kimi, MiniMax, GPT, etc. */
  | 'none';

/** How to disable thinking when not wanted for this model */
export type ThinkingDisableStrategy = 'explicit-disabled' | 'omit-field';

export interface ThinkingCapability {
  mode: ThinkingMode;
  disableStrategy: ThinkingDisableStrategy;
}

/**
 * Detect thinking capability for a model.
 */
export function detectThinkingCapability(modelId: string): ThinkingCapability {
  const id = modelId.toLowerCase();

  // DeepSeek v4 series
  if (id.startsWith('deepseek-v4') || id.startsWith('deepseek-chat-v4')) {
    return { mode: 'effort-based-max', disableStrategy: 'explicit-disabled' };
  }

  // DeepSeek reasoner
  if (id.startsWith('deepseek-reasoner')) {
    return { mode: 'manual-only', disableStrategy: 'explicit-disabled' };
  }

  // DeepSeek other models
  if (id.startsWith('deepseek')) {
    return { mode: 'none', disableStrategy: 'omit-field' };
  }

  // Claude Opus 4.7
  if (id.startsWith('claude-opus-4-7') || id.startsWith('claude-sonnet-4-7')) {
    return { mode: 'adaptive-only', disableStrategy: 'explicit-disabled' };
  }

  // Claude Opus 4.6 / Sonnet 4.6
  if (id.startsWith('claude-opus-4-6') || id.startsWith('claude-sonnet-4-6')) {
    return { mode: 'adaptive-preferred', disableStrategy: 'explicit-disabled' };
  }

  // Claude Mythos Preview
  if (id.startsWith('claude-mythos')) {
    return { mode: 'adaptive-only', disableStrategy: 'omit-field' };
  }

  // OpenAI models — no thinking
  if (id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) {
    return { mode: 'none', disableStrategy: 'omit-field' };
  }

  // MiniMax / Kimi — non-thinking models
  if (id.startsWith('minimax') || id.startsWith('kimi') || id.startsWith('moonshot')) {
    return { mode: 'none', disableStrategy: 'omit-field' };
  }

  // Default: no thinking for unknown models
  return { mode: 'none', disableStrategy: 'omit-field' };
}

/** Build thinking config body for Anthropic API */
export function buildThinkingBody(
  capability: ThinkingCapability,
  enabled: boolean,
): Record<string, unknown> | undefined {
  if (!enabled) {
    if (capability.disableStrategy === 'omit-field') return undefined;
    return { type: 'disabled' };
  }

  switch (capability.mode) {
    case 'adaptive-only':
    case 'adaptive-preferred':
      return { type: 'adaptive', display: 'summarized' };
    case 'manual-only':
      return { type: 'enabled', budget_tokens: 16384 };
    case 'effort-based-max':
      return { type: 'enabled' };
    case 'none':
      return undefined;
  }
}

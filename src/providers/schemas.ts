/**
 * Provider Management Module — Zod Schemas
 *
 * Validation schemas for YAML config parsing and API input validation.
 * Follows the project's pattern of z.prefault() with sensible defaults.
 */

import { z } from 'zod';
import { SUPPORTED_PROVIDER_KINDS } from './types.js';

// ─── Model Entry ──────────────────────────────────────────────────

export const ModelEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  contextWindow: z.number().int().positive().default(128_000),
  defaultMaxTokens: z.number().int().positive().default(4_096),
  supportsThinking: z.boolean().default(false),
  supportsAttachments: z.boolean().default(false),
  inputPricePer1M: z.number().nonnegative().optional(),
  outputPricePer1M: z.number().nonnegative().optional(),
});

// ─── Provider Channel ─────────────────────────────────────────────

export const ChannelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(SUPPORTED_PROVIDER_KINDS),
  baseUrl: z.string().optional(),
  apiKey: z.string().default(''),
  enabled: z.boolean().default(true),
  models: z.array(ModelEntrySchema).default([]),
});

// ─── Tier Mapping ─────────────────────────────────────────────────

const TierTargetSchema = z.object({
  channel: z.string().min(1),
  model: z.string().min(1),
});

export const TierMappingSchema = z.object({
  fast: TierTargetSchema.optional(),
  default: TierTargetSchema.optional(),
  high: TierTargetSchema.optional(),
});

// ─── Channels Config (embedded in LlmConfig) ──────────────────────

export const ChannelsConfigSchema = z.object({
  channels: z.array(ChannelSchema).default([]),
  tiers: z.prefault(TierMappingSchema, {}),
});

// ─── Type Exports ─────────────────────────────────────────────────

import type { ModelEntry, ProviderChannel, TierMapping, ChannelsConfig } from './types.js';

export type ModelEntryInput = z.input<typeof ModelEntrySchema>;
export type ChannelInput = z.input<typeof ChannelSchema>;
export type TierMappingInput = z.input<typeof TierMappingSchema>;
export type ChannelsConfigInput = z.input<typeof ChannelsConfigSchema>;

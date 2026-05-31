/**
 * Built-in Model Catalog — Anthropic Claude
 *
 * All known Anthropic models with their metadata.
 * Reference: https://docs.anthropic.com/en/docs/about-claude/models
 */

import type { ModelEntry } from '../types.js';

export const ANTHROPIC_MODELS: ModelEntry[] = [
  // ─── Claude 4.7 Series ──────────────────────────────────────────
  {
    id: 'claude-opus-4-7-20250620',
    name: 'Claude Opus 4.7',
    contextWindow: 200_000,
    defaultMaxTokens: 32_000,
    supportsThinking: true,
    supportsAttachments: true,
    inputPricePer1M: 15.0,
    outputPricePer1M: 75.0,
  },
  {
    id: 'claude-sonnet-4-7-20250620',
    name: 'Claude Sonnet 4.7',
    contextWindow: 200_000,
    defaultMaxTokens: 32_000,
    supportsThinking: true,
    supportsAttachments: true,
    inputPricePer1M: 3.0,
    outputPricePer1M: 15.0,
  },

  // ─── Claude 4.6 Series ──────────────────────────────────────────
  {
    id: 'claude-opus-4-6-20250514',
    name: 'Claude Opus 4.6',
    contextWindow: 200_000,
    defaultMaxTokens: 32_000,
    supportsThinking: true,
    supportsAttachments: true,
    inputPricePer1M: 15.0,
    outputPricePer1M: 75.0,
  },
  {
    id: 'claude-sonnet-4-6-20250514',
    name: 'Claude Sonnet 4.6',
    contextWindow: 200_000,
    defaultMaxTokens: 16_384,
    supportsThinking: true,
    supportsAttachments: true,
    inputPricePer1M: 3.0,
    outputPricePer1M: 15.0,
  },
  {
    id: 'claude-haiku-4-6-20250514',
    name: 'Claude Haiku 4.6',
    contextWindow: 200_000,
    defaultMaxTokens: 8_192,
    supportsThinking: true,
    supportsAttachments: true,
    inputPricePer1M: 0.80,
    outputPricePer1M: 4.00,
  },

  // ─── Claude 4.5 Series ──────────────────────────────────────────
  {
    id: 'claude-sonnet-4-5-20250514',
    name: 'Claude Sonnet 4.5',
    contextWindow: 200_000,
    defaultMaxTokens: 16_384,
    supportsThinking: true,
    supportsAttachments: true,
    inputPricePer1M: 3.0,
    outputPricePer1M: 15.0,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    defaultMaxTokens: 8_192,
    supportsThinking: false,
    supportsAttachments: true,
    inputPricePer1M: 0.80,
    outputPricePer1M: 4.00,
  },

  // ─── Claude 3.5 Series (Legacy) ────────────────────────────────
  {
    id: 'claude-3-5-sonnet-20241022',
    name: 'Claude 3.5 Sonnet (v2)',
    contextWindow: 200_000,
    defaultMaxTokens: 8_192,
    supportsThinking: false,
    supportsAttachments: true,
    inputPricePer1M: 3.0,
    outputPricePer1M: 15.0,
  },
  {
    id: 'claude-3-5-haiku-20241022',
    name: 'Claude 3.5 Haiku',
    contextWindow: 200_000,
    defaultMaxTokens: 8_192,
    supportsThinking: false,
    supportsAttachments: true,
    inputPricePer1M: 0.80,
    outputPricePer1M: 4.00,
  },

  // ─── Claude 3 Series (Legacy) ───────────────────────────────────
  {
    id: 'claude-3-opus-20240229',
    name: 'Claude 3 Opus',
    contextWindow: 200_000,
    defaultMaxTokens: 4_096,
    supportsThinking: false,
    supportsAttachments: true,
    inputPricePer1M: 15.0,
    outputPricePer1M: 75.0,
  },
];

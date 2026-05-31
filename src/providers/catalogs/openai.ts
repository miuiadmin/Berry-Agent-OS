/**
 * Built-in Model Catalog — OpenAI
 *
 * All known OpenAI models with their metadata.
 * Reference: https://platform.openai.com/docs/models
 */

import type { ModelEntry } from '../types.js';

export const OPENAI_MODELS: ModelEntry[] = [
  // ─── GPT-4.1 Series ─────────────────────────────────────────────
  {
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    contextWindow: 1_047_576,
    defaultMaxTokens: 32_768,
    supportsThinking: false,
    supportsAttachments: true,
    inputPricePer1M: 2.0,
    outputPricePer1M: 8.0,
  },
  {
    id: 'gpt-4.1-mini',
    name: 'GPT-4.1 Mini',
    contextWindow: 1_047_576,
    defaultMaxTokens: 32_768,
    supportsThinking: false,
    supportsAttachments: true,
    inputPricePer1M: 0.40,
    outputPricePer1M: 1.60,
  },
  {
    id: 'gpt-4.1-nano',
    name: 'GPT-4.1 Nano',
    contextWindow: 1_047_576,
    defaultMaxTokens: 32_768,
    supportsThinking: false,
    supportsAttachments: true,
    inputPricePer1M: 0.10,
    outputPricePer1M: 0.40,
  },

  // ─── GPT-4o Series ──────────────────────────────────────────────
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    contextWindow: 128_000,
    defaultMaxTokens: 16_384,
    supportsThinking: false,
    supportsAttachments: true,
    inputPricePer1M: 2.50,
    outputPricePer1M: 10.0,
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    contextWindow: 128_000,
    defaultMaxTokens: 16_384,
    supportsThinking: false,
    supportsAttachments: true,
    inputPricePer1M: 0.15,
    outputPricePer1M: 0.60,
  },

  // ─── o-Series (Reasoning) ───────────────────────────────────────
  {
    id: 'o3',
    name: 'o3',
    contextWindow: 200_000,
    defaultMaxTokens: 100_000,
    supportsThinking: false,
    supportsAttachments: true,
    inputPricePer1M: 10.0,
    outputPricePer1M: 40.0,
  },
  {
    id: 'o3-mini',
    name: 'o3 Mini',
    contextWindow: 200_000,
    defaultMaxTokens: 100_000,
    supportsThinking: false,
    supportsAttachments: true,
    inputPricePer1M: 1.10,
    outputPricePer1M: 4.40,
  },
  {
    id: 'o4-mini',
    name: 'o4 Mini',
    contextWindow: 200_000,
    defaultMaxTokens: 100_000,
    supportsThinking: false,
    supportsAttachments: true,
    inputPricePer1M: 1.10,
    outputPricePer1M: 4.40,
  },
];

/**
 * Built-in Model Catalog — OpenAI-Compatible Services
 *
 * Default models for OpenAI-compatible endpoints (DeepSeek, Ollama, etc.).
 * This catalog is intentionally sparse — user-provided models dominate.
 */

import type { ModelEntry } from '../types.js';

export const OPENAI_COMPAT_MODELS: ModelEntry[] = [
  // ─── DeepSeek ────────────────────────────────────────────────────
  {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat (V3)',
    contextWindow: 64_000,
    defaultMaxTokens: 8_192,
    supportsThinking: false,
    supportsAttachments: false,
    inputPricePer1M: 0.27,
    outputPricePer1M: 1.10,
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner (R1)',
    contextWindow: 64_000,
    defaultMaxTokens: 8_192,
    supportsThinking: false,
    supportsAttachments: false,
    inputPricePer1M: 0.55,
    outputPricePer1M: 2.19,
  },
];

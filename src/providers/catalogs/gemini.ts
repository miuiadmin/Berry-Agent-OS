/**
 * Built-in Model Catalog — Google Gemini
 *
 * Reference: https://ai.google.dev/gemini-api/docs/models
 */

import type { ModelEntry } from '../types.js';

export const GEMINI_MODELS: ModelEntry[] = [
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    contextWindow: 1_048_576,
    defaultMaxTokens: 65_536,
    supportsThinking: false,
    supportsAttachments: true,
    inputPricePer1M: 1.25,
    outputPricePer1M: 10.0,
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    contextWindow: 1_048_576,
    defaultMaxTokens: 65_536,
    supportsThinking: false,
    supportsAttachments: true,
    inputPricePer1M: 0.15,
    outputPricePer1M: 3.50,
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    contextWindow: 1_048_576,
    defaultMaxTokens: 8_192,
    supportsThinking: false,
    supportsAttachments: true,
    inputPricePer1M: 0.10,
    outputPricePer1M: 0.40,
  },
];

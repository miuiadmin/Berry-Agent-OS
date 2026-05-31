/**
 * Built-in Model Catalog — Aggregator
 *
 * Collects all provider-specific catalogs into a single lookup map.
 * User channel models are merged on top of these built-in entries.
 */

import type { ProviderKind, ModelEntry } from '../types.js';
import { ANTHROPIC_MODELS } from './anthropic.js';
import { OPENAI_MODELS } from './openai.js';
import { OPENAI_COMPAT_MODELS } from './openai-compat.js';
import { GEMINI_MODELS } from './gemini.js';

const catalogs: Partial<Record<ProviderKind, ModelEntry[]>> = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  'openai-compatible': OPENAI_COMPAT_MODELS,
  'google-gemini': GEMINI_MODELS,
  // azure-openai and bedrock share the OpenAI / Anthropic catalogs respectively
  // but are kept as separate kinds for SDK routing purposes
};

/**
 * Get the built-in model catalog for a given provider kind.
 * Returns an empty array for unsupported kinds (users can still define custom models).
 */
export function getBuiltinCatalog(kind: ProviderKind): ModelEntry[] {
  return catalogs[kind] ?? [];
}

/**
 * Merge a channel's user-defined models with the built-in catalog.
 *
 * Strategy:
 * - If a channel defines its own models list → use ONLY user models (no catalog merge)
 *   This prevents unwanted built-in models appearing for compatible proxies (e.g., MIMO)
 * - If a channel has no user models → return the full built-in catalog
 * - This way: user says exactly which models they want → they get exactly those
 */
export function mergeCatalog(
  kind: ProviderKind,
  userModels?: ModelEntry[],
): ModelEntry[] {
  // User explicitly listed their models → respect that, don't pollute with builtins
  if (userModels && userModels.length > 0) {
    return [...userModels];
  }

  // No user models → fall back to built-in catalog for this kind
  return [...getBuiltinCatalog(kind)];
}

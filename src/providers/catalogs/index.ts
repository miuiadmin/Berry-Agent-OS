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
 * - If a user model's `id` matches a built-in entry → user entry wins (override)
 * - If the `id` is new → appended to the catalog
 * - If channel has no user models → returns the pure built-in catalog
 */
export function mergeCatalog(
  kind: ProviderKind,
  userModels?: ModelEntry[],
): ModelEntry[] {
  const builtins = getBuiltinCatalog(kind);

  if (!userModels || userModels.length === 0) {
    return [...builtins];
  }

  const userMap = new Map(userModels.map(m => [m.id, m]));
  const merged: ModelEntry[] = [];

  // Built-in entries — overridden if user provides same ID
  for (const builtin of builtins) {
    const override = userMap.get(builtin.id);
    merged.push(override ?? builtin);
    if (override) userMap.delete(builtin.id);
  }

  // User-only entries (new models not in built-in catalog)
  for (const model of userMap.values()) {
    merged.push(model);
  }

  return merged;
}

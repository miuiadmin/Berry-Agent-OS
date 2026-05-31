/**
 * Built-in Model Catalog — Aggregator
 *
 * Collects all provider-specific catalogs into a single lookup map.
 * Channel models are resolved through resolveChannelModels().
 */

import type { AnyProviderKind, ModelEntry } from '../types.js';
import { ANTHROPIC_MODELS } from './anthropic.js';
import { OPENAI_MODELS } from './openai.js';
import { OPENAI_COMPAT_MODELS } from './openai-compat.js';
import { GEMINI_MODELS } from './gemini.js';

const catalogs: Partial<Record<AnyProviderKind, ModelEntry[]>> = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  'openai-compatible': OPENAI_COMPAT_MODELS,
  'google-gemini': GEMINI_MODELS,
};

/** Get the built-in model catalog for a given provider kind. */
export function getBuiltinCatalog(kind: AnyProviderKind): ModelEntry[] {
  return catalogs[kind] ?? [];
}

/**
 * Resolve the effective model list for a channel.
 *
 * Strategy:
 * - User defined models → use ONLY those (prevents catalog pollution for proxies like MIMO)
 * - No user models → use the built-in catalog for this provider kind
 */
export function resolveChannelModels(
  kind: AnyProviderKind,
  userModels?: ModelEntry[],
): ModelEntry[] {
  if (userModels && userModels.length > 0) {
    return [...userModels];
  }
  return [...getBuiltinCatalog(kind)];
}

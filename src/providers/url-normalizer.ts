/**
 * Provider URL Normalizer
 *
 * AI SDK factories expect baseURL to include the API version path segment:
 * - @ai-sdk/anthropic appends `/messages` → expects baseURL ending in `/v1`
 * - @ai-sdk/openai appends `/chat/completions` → expects baseURL ending in `/v1`
 *
 * This module auto-appends `/v1` when the user's config omits it,
 * while preserving URLs that already include a version path.
 */

import type { ProviderKind } from './types.js';

/**
 * Normalize a provider baseURL by ensuring it includes the required API version path.
 *
 * @param url  - Raw baseURL from config (may or may not include `/v1`)
 * @param kind - Provider kind (anthropic, openai, openai-compatible)
 * @returns Normalized URL with version path, or undefined if input is falsy
 *
 * @example
 * normalizeBaseUrl('https://proxy/anthropic', 'anthropic')     // → 'https://proxy/anthropic/v1'
 * normalizeBaseUrl('https://proxy/anthropic/v1', 'anthropic')  // → 'https://proxy/anthropic/v1' (unchanged)
 * normalizeBaseUrl('https://proxy/api/v2', 'openai')           // → 'https://proxy/api/v2' (unchanged)
 * normalizeBaseUrl(undefined, 'anthropic')                     // → undefined
 */
export function normalizeBaseUrl(url: string | undefined, kind: ProviderKind): string | undefined {
  if (!url) return undefined;

  // Strip trailing slashes for consistency
  let normalized = url.replace(/\/+$/, '');

  // Only anthropic / openai / openai-compatible need the /v1 path
  if (kind === 'anthropic' || kind === 'openai' || kind === 'openai-compatible') {
    // If URL already ends with /vN (any version digit), leave it alone
    if (!/\/v\d+$/.test(normalized)) {
      normalized += '/v1';
    }
  }

  return normalized;
}

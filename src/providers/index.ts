/**
 * Provider Management Module — Public Exports
 *
 * This is the single entry point for all consumers of the provider module.
 */

// Contract — the interface consumers depend on
export type { IProviderRegistry } from './contract.js';

// Types — data structures
export type {
  ProviderKind,
  ModelEntry,
  ProviderChannel,
  TierTarget,
  TierMapping,
  ResolvedModel,
  ChannelsConfig,
} from './types.js';

// Provider kinds constant (for dropdowns, validation)
export { PROVIDER_KINDS } from './types.js';

// Registry — the main implementation
export { ProviderRegistry, createProviderRegistry } from './registry.js';

// Schemas — for validation
export {
  ModelEntrySchema,
  ChannelSchema,
  TierMappingSchema,
  ChannelsConfigSchema,
} from './schemas.js';

// Catalog — for browsing built-in models
export { getBuiltinCatalog, mergeCatalog } from './catalogs/index.js';

// Resolver — for custom resolution pipelines
export { buildResolverState, resolveTier, resolveChannelModel, type ResolverState } from './resolver.js';

// Migration — for testing legacy config migration
export { migrateLegacyConfig, isChannelsEmpty } from './migration.js';

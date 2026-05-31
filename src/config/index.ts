/**
 * 配置中心公共出口
 *
 * 其他模块通过此文件访问配置服务。
 */

// Contract types
export type { IConfigService, ConfigChangeEvent, ConfigChangeListener, SectionChangeListener, ValidationDiagnostics } from './contract.js';

// Type definitions
export type { AppConfig } from './schema.js';

// Service
export { ConfigService } from './service.js';

// Schema (for consumers that need to inspect the schema directly)
export { AppConfigSchema, CONFIG_KEYS } from './schema.js';

// Resolver (pure functions, for agent subprocesses that don't need a service instance)
export { resolveConfig, readYamlFile, applyEnvOverrides } from './resolver.js';

// Env mapping (for testing / custom configurations)
export { ENV_MAPPINGS } from './env-map.js';

// Diagnostics
export { diagnoseConfig } from './diagnostics.js';

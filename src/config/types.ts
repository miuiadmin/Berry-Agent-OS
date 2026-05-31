/**
 * 配置类型定义
 *
 * AppConfig 类型从组合 schema 推导，确保与运行时校验一致。
 */

export type { AppConfig } from './schema.js';

// Re-export section types for convenience
export type { LlmConfig } from '../llm/types.js';
export type { CronConfig } from '../cron/types.js';
export type { McpConfig } from '../mcp/contract.js';

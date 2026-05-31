/**
 * 配置类型定义
 *
 * AppConfig 类型从 Zod schema 推导，确保与运行时校验一致。
 * 各模块 section 类型 re-export 供外部使用。
 */

export type { AppConfig } from '../kernel/config.js';

// Re-export section types for convenience
export type { LlmConfig } from '../llm/types.js';
export type { CronConfig } from '../cron/types.js';
export type { McpConfig } from '../mcp/contract.js';

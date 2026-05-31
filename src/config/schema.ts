/**
 * 配置 Schema 组合根
 *
 * 静态组合所有 section schema，推导 AppConfig 类型。
 * 每个模块的 schema 定义一次，AppConfig 类型从 z.infer 自动生成。
 * 替代旧的 ConfigSchemaRegistry（可变 Map 模式）。
 */

import { z } from 'zod';
import { LlmConfigSchema } from '../llm/types.js';
import { CronConfigSchema } from '../cron/types.js';
import { McpConfigSchema } from '../mcp/contract.js';
import {
  ToolLoopConfigSchema,
  MemoryConfigSchema,
  SkillsConfigSchema,
  PluginsConfigSchema,
  ObservabilityConfigSchema,
  BudgetConfigSchema,
  ChannelsConfigSchema,
  StreamingConfigSchema,
  WebConfigSchema,
  DaemonConfigSchema,
  AutonomyConfigSchema,
  KernelScalarsSchema,
} from '../kernel/schemas/index.js';

/** 组合后的应用配置 schema — 单一事实源 */
export const AppConfigSchema = z.object({
  // Module-provided schemas
  llm: z.prefault(LlmConfigSchema, {}),
  cron: z.prefault(CronConfigSchema, {}),
  mcp: z.prefault(McpConfigSchema, {}),

  // Kernel scalar fields
  ...KernelScalarsSchema.shape,

  // Kernel section schemas
  toolLoop: z.prefault(ToolLoopConfigSchema, {}),
  memory: z.prefault(MemoryConfigSchema, {}),
  skills: z.prefault(SkillsConfigSchema, {}),
  plugins: z.prefault(PluginsConfigSchema, {}),
  observability: z.prefault(ObservabilityConfigSchema, {}),
  budget: z.prefault(BudgetConfigSchema, {}),
  channels: z.prefault(ChannelsConfigSchema, {}),
  streaming: z.prefault(StreamingConfigSchema, {}),
  web: z.prefault(WebConfigSchema, {}),
  daemon: z.prefault(DaemonConfigSchema, {}),
  autonomy: AutonomyConfigSchema,
});

/** 应用配置类型 — 从 schema 推导，永不手写 */
export type AppConfig = z.infer<typeof AppConfigSchema>;

/** 已知的 top-level 配置 key 集合（用于白名单过滤） */
export const CONFIG_KEYS: ReadonlySet<string> = new Set(Object.keys(AppConfigSchema.shape));

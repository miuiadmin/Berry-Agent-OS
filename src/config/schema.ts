/**
 * 配置组合根 schema
 *
 * 静态组合所有 section schema，AppConfig 类型通过 z.infer 自动推导。
 * 这是整个配置系统的单一事实源——不再有可变注册表，不再有手写类型。
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
  DriftConfigSchema,
} from '../kernel/schemas/index.js';

/** 组合后的完整应用配置 schema */
export const AppConfigSchema = z.object({
  // 模块级 schema
  llm: z.prefault(LlmConfigSchema, {}),
  cron: z.prefault(CronConfigSchema, {}),
  mcp: z.prefault(McpConfigSchema, {}),

  // Kernel 级 schema
  ...KernelScalarsSchema.shape,
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
  drift: z.prefault(DriftConfigSchema, {}),
  autonomy: AutonomyConfigSchema,
});

/** 应用配置类型——从 schema 自动推导，永不手写 */
export type AppConfig = z.infer<typeof AppConfigSchema>;

/** 已知的顶层配置 key 集合（用于白名单过滤） */
export const CONFIG_KEYS: ReadonlySet<string> = new Set(Object.keys(AppConfigSchema.shape));

/**
 * 配置 Schema 注册表
 *
 * 各模块注册自己的 Zod schema section，启动时组装为完整的 AppConfigSchema。
 * 替代 kernel/config.ts 中的内联 schema 定义。
 */

import { z } from 'zod';
import { LlmConfigSchema } from '../llm/types.js';
import { CronConfigSchema } from '../cron/types.js';
import { McpConfigSchema } from '../mcp/contract.js';

// ─── Kernel 级别 section schemas ─────────────────────────────────

const ToolLoopSchema = z.object({
  maxCalls: z.number().default(20),
  timeoutMs: z.number().default(30000),
});

const MemorySchema = z.object({
  evolutionEnabled: z.boolean().default(true),
  consolidationInterval: z.number().default(50),
  maxResults: z.number().default(5),
});

const SkillsSchema = z.object({
  promptMode: z.enum(['summary', 'full', 'hybrid']).default('full'),
  maxPromptChars: z.number().default(8000),
  maxDescriptionChars: z.number().default(512),
  shellInjection: z.boolean().default(false),
});

const PluginsSchema = z.object({
  unified: z.boolean().default(false),
  pluginsDir: z.string().default(''),
});

const ObservabilitySchema = z.object({
  level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  captureOutput: z.boolean().default(false),
  terminal: z.enum(['human', 'json', 'silent']).default('silent'),
});

const BudgetSchema = z.object({
  sessionLimit: z.number().default(500_000),
  agentLimit: z.number().default(200_000),
  taskLimit: z.number().default(100_000),
  dailyLimit: z.number().default(2_000_000),
  alertThresholds: z.prefault(z.object({
    info: z.number().default(0.5),
    warning: z.number().default(0.75),
    critical: z.number().default(0.9),
  }), {}),
  costPerInputToken: z.number().default(0.000003),
  costPerOutputToken: z.number().default(0.000015),
});

const TelegramChannelSchema = z.object({
  enabled: z.boolean().default(false),
  token: z.string().default(''),
  pollingInterval: z.number().default(1000),
  allowedUserIds: z.array(z.string()).default([]),
});

const ChannelsSchema = z.object({
  telegram: z.prefault(TelegramChannelSchema, {}),
});

const StreamingSchema = z.object({
  enabled: z.boolean().default(true),
});

const WebSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().default(3888),
  host: z.string().default('127.0.0.1'),
  secret: z.string().default(''),
});

const DaemonSchema = z.object({
  enabled: z.boolean().default(false),
  autoStart: z.boolean().default(true),
  maxSlots: z.number().default(2),
  heartbeatIntervalMs: z.number().default(5000),
  heartbeatTimeoutMs: z.number().default(15000),
  taskTimeoutMs: z.number().default(300000),
  runtimes: z.record(z.string(), z.object({
    enabled: z.boolean().default(true),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  })).default({}),
});

const AutonomySchema = z.object({
  willLoopEnabled: z.boolean().default(false),
  willLoopIntervalMs: z.number().default(300_000),
  maxAutoDangerLevel: z.enum(['safe', 'moderate']).default('moderate'),
  maxActionsPerHour: z.number().default(5),
}).default({
  willLoopEnabled: false,
  willLoopIntervalMs: 300_000,
  maxAutoDangerLevel: 'moderate',
  maxActionsPerHour: 5,
});

// ─── Registry ────────────────────────────────────────────────────

type SectionSchema = z.ZodTypeAny;

export class ConfigSchemaRegistry {
  private sections = new Map<string, SectionSchema>();

  /** 注册一个 config section schema */
  register(key: string, schema: SectionSchema): void {
    this.sections.set(key, schema);
  }

  /** 组装为完整的 AppConfigSchema */
  buildSchema(): z.ZodObject<Record<string, SectionSchema>> {
    const shape: Record<string, SectionSchema> = {};

    // Module-provided schemas
    for (const [key, schema] of this.sections) {
      shape[key] = schema;
    }

    return z.object(shape);
  }

  /** 获取所有已注册的 section key（用于白名单） */
  getKnownKeys(): Set<string> {
    return new Set(this.sections.keys());
  }
}

/**
 * 创建并填充默认的 schema registry
 *
 * 模块级 schema 从各自的 types/contract 文件导入；
 * kernel 级 schema 在此处注册。
 */
export function createDefaultRegistry(): ConfigSchemaRegistry {
  const registry = new ConfigSchemaRegistry();

  // Module-provided schemas
  registry.register('llm', z.prefault(LlmConfigSchema, {}));
  registry.register('cron', z.prefault(CronConfigSchema, {}));
  registry.register('mcp', z.prefault(McpConfigSchema, {}));

  // Kernel-level schemas
  registry.register('heartbeatIntervalMs', z.number().default(5000));
  registry.register('heartbeatTimeoutMs', z.number().default(30000));
  registry.register('requestTimeoutMs', z.number().default(30000));
  registry.register('permissionMode', z.enum(['ask', 'allow-all', 'deny-all']).default('allow-all'));
  registry.register('toolLoop', z.prefault(ToolLoopSchema, {}));
  registry.register('memory', z.prefault(MemorySchema, {}));
  registry.register('skills', z.prefault(SkillsSchema, {}));
  registry.register('plugins', z.prefault(PluginsSchema, {}));
  registry.register('observability', z.prefault(ObservabilitySchema, {}));
  registry.register('budget', z.prefault(BudgetSchema, {}));
  registry.register('channels', z.prefault(ChannelsSchema, {}));
  registry.register('streaming', z.prefault(StreamingSchema, {}));
  registry.register('web', z.prefault(WebSchema, {}));
  registry.register('daemon', z.prefault(DaemonSchema, {}));
  registry.register('autonomy', AutonomySchema);

  return registry;
}

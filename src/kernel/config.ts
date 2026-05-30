import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { getConfigPath } from '../utils/paths.js';
import { LlmConfigSchema } from '../llm/types.js';
import { CronConfigSchema } from '../cron/types.js';
import { McpConfigSchema } from '../mcp/contract.js';

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
  port: z.number().default(7860),
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

const AppConfigSchema = z.object({
  llm: z.prefault(LlmConfigSchema, {}),
  heartbeatIntervalMs: z.number().default(5000),
  heartbeatTimeoutMs: z.number().default(30000),
  requestTimeoutMs: z.number().default(30000),
  permissionMode: z.enum(['ask', 'allow-all', 'deny-all']).default('allow-all'),
  toolLoop: z.prefault(ToolLoopSchema, {}),
  memory: z.prefault(MemorySchema, {}),
  skills: z.prefault(SkillsSchema, {}),
  plugins: z.prefault(PluginsSchema, {}),
  observability: z.prefault(ObservabilitySchema, {}),
  budget: z.prefault(BudgetSchema, {}),
  channels: z.prefault(ChannelsSchema, {}),
  streaming: z.prefault(StreamingSchema, {}),
  web: z.prefault(WebSchema, {}),
  cron: z.prefault(CronConfigSchema, {}),
  mcp: z.prefault(McpConfigSchema, {}),
  daemon: z.prefault(DaemonSchema, {}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export function loadConfig(): AppConfig {
  const configPath = getConfigPath();
  let fileData: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8');
    fileData = parseYaml(raw) ?? {};
  }

  const envOverrides: Record<string, unknown> = {};
  if (process.env.LLM_BASE_URL || process.env.LLM_API_KEY || process.env.LLM_MODEL || process.env.BERRY_LLM_MODE
    || process.env.LLM_MODEL_FAST || process.env.LLM_MODEL_DEFAULT || process.env.LLM_MODEL_HIGH
    || process.env.LLM_PROVIDER || process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL
    || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_BASE_URL
    || process.env.OPENAI_COMPATIBLE_BASE_URL || process.env.OPENAI_COMPATIBLE_API_KEY) {
    const fileLlm = (fileData.llm as Record<string, unknown>) ?? {};
    const fileModels = (fileLlm.models as Record<string, unknown>) ?? {};
    const fileProviders = (fileLlm.providers as Record<string, unknown>) ?? {};
    const fileAnthropicProvider = (fileProviders.anthropic as Record<string, unknown>) ?? {};
    const fileOpenaiProvider = (fileProviders.openai as Record<string, unknown>) ?? {};
    const fileCompatProvider = (fileProviders['openai-compatible'] as Record<string, unknown>) ?? {};

    envOverrides.llm = {
      ...fileLlm,
      ...(process.env.LLM_PROVIDER && { provider: process.env.LLM_PROVIDER }),
      ...(process.env.LLM_BASE_URL && { baseUrl: process.env.LLM_BASE_URL }),
      ...(process.env.LLM_API_KEY && { apiKey: process.env.LLM_API_KEY }),
      ...(process.env.LLM_MODEL && { model: process.env.LLM_MODEL }),
      ...(process.env.BERRY_LLM_MODE && { mode: process.env.BERRY_LLM_MODE }),
      models: {
        ...fileModels,
        ...(process.env.LLM_MODEL_FAST && { fast: process.env.LLM_MODEL_FAST }),
        ...(process.env.LLM_MODEL_DEFAULT && { default: process.env.LLM_MODEL_DEFAULT }),
        ...(process.env.LLM_MODEL_HIGH && { high: process.env.LLM_MODEL_HIGH }),
      },
      providers: {
        anthropic: {
          ...fileAnthropicProvider,
          ...(!fileLlm.baseUrl && !fileAnthropicProvider.baseUrl && process.env.ANTHROPIC_BASE_URL && { baseUrl: process.env.ANTHROPIC_BASE_URL }),
          ...(!fileLlm.apiKey && !fileAnthropicProvider.apiKey && process.env.ANTHROPIC_API_KEY && { apiKey: process.env.ANTHROPIC_API_KEY }),
        },
        openai: {
          ...fileOpenaiProvider,
          ...(process.env.OPENAI_BASE_URL && { baseUrl: process.env.OPENAI_BASE_URL }),
          ...(process.env.OPENAI_API_KEY && { apiKey: process.env.OPENAI_API_KEY }),
        },
        'openai-compatible': {
          ...fileCompatProvider,
          ...(process.env.OPENAI_COMPATIBLE_BASE_URL && { baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL }),
          ...(process.env.OPENAI_COMPATIBLE_API_KEY && { apiKey: process.env.OPENAI_COMPATIBLE_API_KEY }),
        },
      },
    };
  }

  return AppConfigSchema.parse({ ...fileData, ...envOverrides });
}

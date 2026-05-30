import { z } from 'zod';

const jsonSchema: z.ZodType<Record<string, unknown>> = z.record(z.string(), z.unknown());

export const pluginToolSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().min(1),
  permissionScope: z.string().min(1),
  inputSchema: jsonSchema,
  outputSchema: jsonSchema.optional(),
  examples: z.array(z.unknown()).optional(),
  failureModes: z.array(z.string()).optional(),
});

export const pluginManifestSchema = z.object({
  apiVersion: z.literal('berry.plugin.v1'),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  source: z.enum(['bundled', 'generated', 'user', 'installed']).default('generated'),
  riskLevel: z.enum(['low', 'medium', 'high']).default('medium'),
  capabilities: jsonSchema.default({}),
  permissions: jsonSchema.default({}),
  tools: z.array(pluginToolSchema).min(1),
  evidence: z.array(z.string()).optional(),
});

export type PluginManifestFile = z.infer<typeof pluginManifestSchema>;

export function getPluginManifestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(pluginManifestSchema) as Record<string, unknown>;
}

export function getPluginContract(): Record<string, unknown> {
  return {
    apiVersion: 'berry.plugin.v1',
    packageShape: {
      requiredFiles: ['plugin.json', 'entry.ts'],
      optionalFiles: ['tests/*.fixture.json', 'README.md'],
    },
    manifestSchema: getPluginManifestJsonSchema(),
    entrypoint: {
      import: '@berryagent/plugin-sdk',
      helper: 'definePlugin',
      rule: '插件只能通过 definePlugin 注册工具、受限 Hook 或命令；不得 import 核心系统 内部实现。',
    },
    toolContract: {
      required: ['name', 'description', 'permissionScope', 'inputSchema'],
      permission: '所有工具执行前必须由 核心系统 发放 permission token。',
      outputs: '工具输出必须可 JSON 序列化；失败时返回结构化错误，不直接写控制台。',
    },
    safetyRules: [
      '不得直接读取 process.env、authorization、cookie、password、token 等真实凭据。',
      '不得 import src/kernel/*、src/memory/* 或其他内部实现。',
      '不得直接调用 LLM API；需要模型能力时必须通过 核心系统 暴露的受控能力。',
      '高风险权限必须进入 Brain 审核和用户确认流程。',
    ],
    automationCommands: [
      'berry plugins schema --json',
      'berry plugins contract --json',
      'berry plugins scaffold <name> --description <text> --json',
      'berry plugins inspect <name> --json',
      'berry plugins validate <name> --json',
      'berry plugins test <name> --json',
      'berry plugins dry-run <name> <tool> --input-json <json> --json',
    ],
  };
}

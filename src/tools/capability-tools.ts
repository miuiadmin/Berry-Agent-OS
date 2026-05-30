import { z } from 'zod';
import type { IpcChildChannel } from '../contracts/infrastructure.js';
import type { ToolDefinition, ToolResult } from './types.js';

const nameSchema = z.object({
  name: z.string().min(1).describe('技能或插件名称'),
});

const pluginToolSchema = z.object({
  name: z.string().min(1).describe('插件名称'),
  tool: z.string().min(1).describe('插件工具名称'),
  input: z.record(z.string(), z.unknown()).default({}).describe('工具 JSON 输入'),
});

export function createCapabilityTools(ipc: IpcChildChannel, requestTimeoutMs: number): ToolDefinition[] {
  return [
    {
      name: 'list_skills',
      description: '列出当前已注册的技能，用于判断是否已有可复用 SKILL.md 能力。',
      inputSchema: z.object({}),
      dangerLevel: 'safe',
      async execute(): Promise<ToolResult> {
        return requestCapability(ipc, requestTimeoutMs, 'capability.skills.list', {});
      },
    },
    {
      name: 'list_plugins',
      description: '列出当前已注册的插件及启用状态，用于判断是否已有可复用插件能力。',
      inputSchema: z.object({}),
      dangerLevel: 'safe',
      async execute(): Promise<ToolResult> {
        return requestCapability(ipc, requestTimeoutMs, 'capability.plugins.list', {});
      },
    },
    {
      name: 'inspect_plugin',
      description: '查看插件 manifest、工具 schema、权限范围、验证状态和近期事件。',
      inputSchema: nameSchema,
      dangerLevel: 'safe',
      async execute(input: unknown): Promise<ToolResult> {
        return requestCapability(ipc, requestTimeoutMs, 'capability.plugins.inspect', nameSchema.parse(input));
      },
    },
    {
      name: 'validate_plugin',
      description: '验证插件 manifest、entry.ts 安全规则和工具 schema。',
      inputSchema: nameSchema,
      dangerLevel: 'safe',
      async execute(input: unknown): Promise<ToolResult> {
        return requestCapability(ipc, requestTimeoutMs, 'capability.plugins.validate', nameSchema.parse(input));
      },
    },
    {
      name: 'dry_run_plugin',
      description: '用受控 fixture runtime 试运行低风险插件工具。正式执行仍必须经过 核心系统 permission token。',
      inputSchema: pluginToolSchema,
      dangerLevel: 'safe',
      async execute(input: unknown): Promise<ToolResult> {
        return requestCapability(ipc, requestTimeoutMs, 'capability.plugins.dry_run', pluginToolSchema.parse(input));
      },
    },
  ];
}

async function requestCapability(
  ipc: IpcChildChannel,
  requestTimeoutMs: number,
  action: string,
  payload: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const response = await ipc.request('capability.request', 'core', { action, payload }, requestTimeoutMs);
    const result = response.payload as { ok: boolean; result?: unknown; error?: string };
    if (!result.ok) return { content: `能力请求失败: ${result.error ?? '未知错误'}`, isError: true };
    return { content: JSON.stringify(result.result, null, 2) };
  } catch (err) {
    return { content: `能力请求超时: ${(err as Error).message}`, isError: true };
  }
}

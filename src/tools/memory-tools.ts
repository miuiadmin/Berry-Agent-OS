import type { ToolDefinition, ToolResult } from './types.js';
import type { IpcChildChannel } from '../contracts/infrastructure.js';
import {
  MemoryAddSchema,
  MemoryDeleteSchema,
  MemoryQuerySchema,
  type MemoryAddPayload,
  type MemoryDeletePayload,
  type MemoryQueryPayload,
} from '../contracts/memory.js';

export function createMemoryTools(ipc: IpcChildChannel, requestTimeoutMs: number): ToolDefinition[] {
  const memoryQueryTool: ToolDefinition = {
    name: 'memory_query',
    description: '搜索用户的记忆/知识库。可按关键词搜索用户偏好、习惯、身份等已知信息。',
    inputSchema: MemoryQuerySchema,
    dangerLevel: 'safe',
    async execute(input: unknown): Promise<ToolResult> {
      const { query, type, limit } = input as MemoryQueryPayload;
      try {
        const response = await ipc.request('memory.query', 'core', { query, type, limit }, requestTimeoutMs);
        const payload = response.payload as { results: unknown[]; error?: string };
        if (payload.error) return { content: `查询失败: ${payload.error}`, isError: true };
        if (!payload.results || payload.results.length === 0) return { content: '未找到相关记忆。' };
        return { content: JSON.stringify(payload.results, null, 2) };
      } catch (err) {
        return { content: `记忆查询超时: ${(err as Error).message}`, isError: true };
      }
    },
  };

  const memoryAddTool: ToolDefinition = {
    name: 'memory_add',
    description: '主动添加一条用户记忆/知识。当用户明确告知个人信息、偏好时使用。',
    inputSchema: MemoryAddSchema,
    dangerLevel: 'safe',
    async execute(input: unknown): Promise<ToolResult> {
      const data = input as MemoryAddPayload;
      try {
        const response = await ipc.request('memory.add', 'core', data, requestTimeoutMs);
        const payload = response.payload as { success: boolean; id?: string; error?: string };
        if (payload.error) return { content: `添加失败: ${payload.error}`, isError: true };
        return { content: `记忆已保存 (id: ${payload.id})` };
      } catch (err) {
        return { content: `记忆添加超时: ${(err as Error).message}`, isError: true };
      }
    },
  };

  const memoryDeleteTool: ToolDefinition = {
    name: 'memory_delete',
    description: '删除（归档）一条用户记忆。当用户要求忘记某信息或信息已过时时使用。',
    inputSchema: MemoryDeleteSchema,
    dangerLevel: 'moderate',
    async execute(input: unknown): Promise<ToolResult> {
      const { id } = input as MemoryDeletePayload;
      try {
        const response = await ipc.request('memory.delete', 'core', { id }, requestTimeoutMs);
        const payload = response.payload as { success: boolean; error?: string };
        if (payload.error) return { content: `删除失败: ${payload.error}`, isError: true };
        return { content: `记忆已归档 (id: ${id})` };
      } catch (err) {
        return { content: `记忆删除超时: ${(err as Error).message}`, isError: true };
      }
    },
  };

  return [memoryQueryTool, memoryAddTool, memoryDeleteTool];
}

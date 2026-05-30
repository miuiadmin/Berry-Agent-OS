import type { ToolDefinition, ToolResult } from './types.js';

export type { ToolResult };

export interface IToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
  clear(): void;
  clearNames(names: string[]): void;
}

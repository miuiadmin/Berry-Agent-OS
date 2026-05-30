import type { ToolDefinition } from './types.js';
import type { IToolRegistry } from './contract.js';
import { readFileTool, writeFileTool, listDirectoryTool, deleteFileTool } from './filesystem.js';
import { runCommandTool } from './shell.js';
import { httpFetchTool } from './web.js';

const builtinTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  deleteFileTool,
  runCommandTool,
  httpFetchTool,
];

export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  constructor(initialTools: ToolDefinition[] = []) {
    for (const tool of initialTools) {
      this.tools.set(tool.name, tool);
    }
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  clear(): void {
    this.tools.clear();
  }

  clearNames(names: string[]): void {
    for (const name of names) this.tools.delete(name);
  }
}

const defaultRegistry = new ToolRegistry(builtinTools);

export function getToolRegistry(): ToolDefinition[] {
  return defaultRegistry.getAll();
}

export function getToolByName(name: string): ToolDefinition | undefined {
  return defaultRegistry.get(name);
}

export function registerTool(tool: ToolDefinition): void {
  defaultRegistry.register(tool);
}

export function clearDynamicTools(names: string[]): void {
  defaultRegistry.clearNames(names);
}

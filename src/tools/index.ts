import type { ToolDefinition } from './types.js';
import type { IToolRegistry } from './contract.js';
import { readFileTool, writeFileTool, listDirectoryTool, deleteFileTool } from './filesystem.js';
import { runCommandTool } from './shell.js';
import { httpFetchTool, webSearchTool, webFetchTool } from './web.js';
import { searchFilesTool, grepFilesTool } from './search.js';
import { askUserTool, pushNotificationTool } from './interaction-tools.js';
import { monitorStartTool, monitorStopTool, monitorStatusTool } from './monitor-tools.js';
import { cronCreateTool, cronDeleteTool, cronListTool } from './cron-tools.js';
import { searchHistoryTool } from './session-tools.js';
import { planTool } from './plan-tools.js';
import { squadTool } from './squad-tools.js';

/** 13.0 §5.3.9: 工具来源 — 内置 vs 插件 */
export type ToolOrigin = 'builtin' | 'plugin';

/** 13.0 §5.3.9: 工具注册条目（含 origin 元信息） */
export interface RegisteredTool {
  tool: ToolDefinition;
  origin: ToolOrigin;
}

const builtinTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  deleteFileTool,
  runCommandTool,
  httpFetchTool,
  searchFilesTool,
  grepFilesTool,
  webSearchTool,
  webFetchTool,
  askUserTool,
  pushNotificationTool,
  monitorStartTool,
  monitorStopTool,
  monitorStatusTool,
  cronCreateTool,
  cronDeleteTool,
  cronListTool,
  searchHistoryTool,
  planTool,
  squadTool,
];

export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  constructor(initialTools: ToolDefinition[] = []) {
    for (const tool of initialTools) {
      this.tools.set(tool.name, { tool, origin: 'builtin' });
    }
  }

  /**
   * 注册工具 — 默认标记为 plugin 源（builtin 在构造时统一标记）
   * 13.0 §5.3.9: 用于 plugin 动态注册
   */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, { tool, origin: 'plugin' });
  }

  /**
   * 注册工具时显式指定来源（覆盖默认推断）
   */
  registerWithOrigin(tool: ToolDefinition, origin: ToolOrigin): void {
    this.tools.set(tool.name, { tool, origin });
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.tool;
  }

  getOrigin(name: string): ToolOrigin | undefined {
    return this.tools.get(name)?.origin;
  }

  getAll(): ToolDefinition[] {
    return [...this.tools.values()].map(r => r.tool);
  }

  /**
   * 13.0 §5.3.9: 列出 builtin 工具（UI 展示 / 安全审计用）
   */
  listBuiltinTools(): ToolDefinition[] {
    return [...this.tools.values()].filter(r => r.origin === 'builtin').map(r => r.tool);
  }

  /**
   * 13.0 §5.3.9: 列出 plugin 工具（与 builtin 区分，UI 单独分组 + 可单独禁用）
   */
  listPluginTools(): ToolDefinition[] {
    return [...this.tools.values()].filter(r => r.origin === 'plugin').map(r => r.tool);
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

export function getToolOrigin(name: string): ToolOrigin | undefined {
  return defaultRegistry.getOrigin(name);
}

export function listBuiltinTools(): ToolDefinition[] {
  return defaultRegistry.listBuiltinTools();
}

export function listPluginTools(): ToolDefinition[] {
  return defaultRegistry.listPluginTools();
}

/** 13.0 §5.3.9: 显式以 builtin origin 注册（用于把本来是 plugin 的工具提升到 builtin 桶） */
export function registerBuiltinTool(tool: ToolDefinition): void {
  defaultRegistry.registerWithOrigin(tool, 'builtin');
}

export function registerTool(tool: ToolDefinition): void {
  defaultRegistry.register(tool);
}

export function clearDynamicTools(names: string[]): void {
  defaultRegistry.clearNames(names);
}

export { createDelegationTools } from './delegation-tools.js';
export { createTeamTools } from './team-tools.js';
export { planTool, initMissionTools, getManager } from './plan-tools.js';
export { squadTool } from './squad-tools.js';

import type { ToolDefinition } from '../tools/types.js';
import type { PluginManifest } from './types.js';

export interface PluginToolManifest {
  name: string;
  description: string;
  dangerLevel: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface PluginExecResult {
  ok: boolean;
  output?: Record<string, unknown>;
  error?: string;
  durationMs: number;
}

export interface IPluginRuntime {
  initialize(manifests: PluginManifest[]): Promise<void>;
  execute(pluginName: string, toolName: string, input: Record<string, unknown>): Promise<PluginExecResult>;
  getPluginTools(): ToolDefinition[];
}

export interface IPluginRegistry {
  list(): PluginManifest[];
  get(name: string): PluginManifest | undefined;
}

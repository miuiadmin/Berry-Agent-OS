import type { HookEvent, HookAction, PluginScope, PluginContextV2 } from '../contracts/plugins-v2.js';

export interface PluginLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface PluginStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface PluginContext {
  pluginName: string;
  toolName: string;
  log: PluginLogger;
  storage: PluginStorage;
  config: Record<string, unknown>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  emit: (event: string, payload: Record<string, unknown>) => void;
}

export interface PluginToolHandler<TInput = unknown, TOutput = unknown> {
  (input: TInput, ctx: PluginContext): Promise<TOutput> | TOutput;
}

export interface PluginDefinition {
  name: string;
  tools: Record<string, PluginToolHandler>;
  hooks?: {
    onInstall?: () => Promise<void>;
    onUninstall?: () => Promise<void>;
    onConfigChange?: (newConfig: Record<string, unknown>) => void;
  };
  init?: () => Promise<void> | void;
  dispose?: () => Promise<void> | void;
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}

// ══════════════════════════════════════════════════════════════════════
// Plugin Definition V2 — Multi-Facet
// ══════════════════════════════════════════════════════════════════════

export interface PluginToolHandlerV2<TInput = unknown, TOutput = unknown> {
  (input: TInput, ctx: PluginContextV2): Promise<TOutput> | TOutput;
}

export interface PluginToolDefV2<TInput = unknown, TOutput = unknown> {
  description?: string;
  execute: PluginToolHandlerV2<TInput, TOutput>;
}

export type PluginHookHandler = (
  payload: unknown,
  ctx: PluginContextV2,
) => Promise<HookAction> | HookAction;

export interface PluginServiceHandle {
  onTick?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
}

export interface PluginDefinitionV2 {
  name: string;
  scope?: PluginScope;
  tools?: Record<string, PluginToolDefV2>;
  hooks?: Partial<Record<HookEvent, PluginHookHandler>>;
  service?: {
    start: (ctx: PluginContextV2) => Promise<PluginServiceHandle>;
  };
  init?: (ctx: PluginContextV2) => Promise<void> | void;
  dispose?: (ctx: PluginContextV2) => Promise<void> | void;
}

export function definePluginV2(def: PluginDefinitionV2): PluginDefinitionV2 {
  return def;
}

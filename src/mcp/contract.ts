import { z } from 'zod';
import type { DangerLevel } from '../utils/types.js';

// ─── OAuth Config ───────────────────────────────────────────────

export const McpOAuthConfigSchema = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  scope: z.string().optional(),
  redirectPort: z.number().default(19876),
});
export type McpOAuthConfig = z.infer<typeof McpOAuthConfigSchema>;

// ─── Sampling Config ────────────────────────────────────────────

export const McpSamplingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().optional(),
  maxTokensCap: z.number().default(4096),
  timeoutMs: z.number().default(30_000),
  maxRpm: z.number().default(10),
  maxToolRounds: z.number().default(5),
});
export type McpSamplingConfig = z.infer<typeof McpSamplingConfigSchema>;

// ─── Tool Filtering ─────────────────────────────────────────────

export const McpToolFilterSchema = z.object({
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  resources: z.boolean().default(true),
  prompts: z.boolean().default(true),
});

// ─── Server Config ──────────────────────────────────────────────

export const McpServerConfigSchema = z.object({
  name: z.string().min(1),
  command: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
  timeout: z.number().default(30_000),
  connectTimeout: z.number().default(60_000),
  dangerLevel: z.enum(['safe', 'moderate', 'dangerous']).default('moderate'),
  tools: z.prefault(McpToolFilterSchema, {}),
  oauth: z.union([McpOAuthConfigSchema, z.literal(false)]).optional(),
  sampling: z.prefault(McpSamplingConfigSchema, {}),
  workspaceId: z.string().optional(),
  supportsParallelCalls: z.boolean().default(true),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

// ─── Top-level MCP Config ───────────────────────────────────────

export const McpConfigSchema = z.object({
  servers: z.array(McpServerConfigSchema).default([]),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;

// ─── Server State ───────────────────────────────────────────────

export type McpServerStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'failed'
  | 'disabled'
  | 'needs_auth';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface McpServerState {
  name: string;
  status: McpServerStatus;
  error?: string;
  toolCount: number;
  // resources/prompts 计数已在 16.0 §17.8 删除（整链路无消费者）
  lastConnectedAt: number | null;
  consecutiveFailures: number;
  circuitState: CircuitState;
}

// ─── Manager Interface ──────────────────────────────────────────
// resources/prompts 读方法已在 16.0 §17.8 删除；若未来需要，重新接入时补回
// listResources/readResource/listPrompts/getPrompt 即可。

export interface IMcpManager {
  start(configs: McpServerConfig[]): Promise<void>;
  stop(): Promise<void>;
  getState(name: string): McpServerState | undefined;
  getAllStates(): McpServerState[];
  reconnect(name: string): Promise<void>;
  handleConfigReload(configs: McpServerConfig[]): Promise<void>;
}

// ─── MCP Event payloads (for EventBus integration) ──────────────

export interface McpConnectedEvent {
  serverName: string;
  toolCount: number;
  capabilities: string[];
}

export interface McpDisconnectedEvent {
  serverName: string;
  reason?: string;
}

export interface McpFailedEvent {
  serverName: string;
  error: string;
  circuitBroken?: boolean;
}

export interface McpToolsChangedEvent {
  serverName: string;
  added: string[];
  removed: string[];
}

export interface McpReconnectingEvent {
  serverName: string;
  attempt: number;
  delayMs: number;
}

export interface McpAuthRequiredEvent {
  serverName: string;
  authUrl?: string;
}

export interface McpSamplingRequestEvent {
  serverName: string;
  model?: string;
}

import { z } from 'zod';
import type { AgentName } from './agents.js';

export const BUNDLED_MODEL_PURPOSES = [
  'conversation',
  'brain_review',
  'brain_routing',
  'brain_permission',
  'brain_ask_review',
  'learning_review',
  'skill_generation',
  'plugin_generation',
  'code_task',
  'evolution_extraction',
  'memory_judge',
  'memory_recall',
  'feedback_analysis',
  'gap_detection',
  'metrics_analysis',
] as const;

export const MODEL_TIERS = ['fast', 'default', 'high'] as const;

export const MODEL_MODES = ['live', 'mock', 'replay', 'takeover'] as const;

export const MODEL_BACKENDS = ['anthropic', 'ai_sdk', 'test', 'claude_agent_sdk'] as const;

export const MODEL_API_KINDS = ['standard', 'claude_agent_sdk'] as const;

export const MODEL_STOP_REASONS = ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'] as const;

export type BundledModelPurpose = typeof BUNDLED_MODEL_PURPOSES[number];
export type ModelPurpose = BundledModelPurpose | (string & {});
export type ModelTier = typeof MODEL_TIERS[number];
export type ModelMode = typeof MODEL_MODES[number];
export type ModelBackendKind = typeof MODEL_BACKENDS[number];
export type ModelApiKind = typeof MODEL_API_KINDS[number];
export type ModelStopReason = typeof MODEL_STOP_REASONS[number];

export const ModelPurposeSchema = z.string().min(1);
export const ModelTierSchema = z.enum(MODEL_TIERS);
export const ModelModeSchema = z.enum(MODEL_MODES);
export const ModelBackendSchema = z.enum(MODEL_BACKENDS);
export const ModelStopReasonSchema = z.enum(MODEL_STOP_REASONS);

export const PURPOSE_TIER_MAP: Record<BundledModelPurpose, ModelTier> = {
  conversation: 'default',
  brain_review: 'fast',
  brain_routing: 'fast',
  brain_permission: 'default',
  brain_ask_review: 'fast',
  learning_review: 'fast',
  skill_generation: 'default',
  plugin_generation: 'high',
  code_task: 'high',
  evolution_extraction: 'fast',
  memory_judge: 'fast',
  memory_recall: 'fast',
  feedback_analysis: 'fast',
  gap_detection: 'fast',
  metrics_analysis: 'fast',
};

export interface ModelToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ModelContentBlock[];
}

export type ModelContentBlock =
  | ModelTextBlock
  | ModelToolUseBlock
  | ModelToolResultBlock
  | ModelThinkingBlock
  | ModelRedactedThinkingBlock;

export interface ModelTextBlock {
  type: 'text';
  text: string;
}

export interface ModelToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ModelThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

export interface ModelRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export interface ModelRequestOptions {
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  thinkingEnabled?: boolean;
}

export interface ModelRequest {
  id: string;
  agent: AgentName;
  purpose: ModelPurpose;
  modelTier: ModelTier;
  mode: ModelMode;
  backend: ModelBackendKind;
  apiKind: ModelApiKind;
  sessionId: string;
  taskId?: string;
  correlationId: string;
  stepIndex: number;
  system?: string;
  messages: ModelMessage[];
  tools?: ModelToolDef[];
  options: ModelRequestOptions;
  promptHash: string;
  toolsHash?: string;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface ModelResponse {
  requestId: string;
  content: string;
  contentBlocks: ModelContentBlock[];
  toolCalls: ModelToolCall[];
  stopReason: ModelStopReason;
  usage: ModelUsage;
  model: string;
  reasoning?: string;
}

export type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; input: string }
  | { type: 'tool_use_end'; id: string; input: Record<string, unknown> }
  | { type: 'end'; response: ModelResponse };

export const ModelRequestSchema = z.object({
  id: z.string(),
  agent: z.string(),
  purpose: ModelPurposeSchema,
  modelTier: ModelTierSchema.default('default'),
  mode: ModelModeSchema,
  backend: ModelBackendSchema,
  apiKind: z.enum(MODEL_API_KINDS),
  sessionId: z.string(),
  taskId: z.string().optional(),
  correlationId: z.string(),
  stepIndex: z.number().int().min(0),
  system: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.union([z.string(), z.array(z.unknown())]),
  })),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
  })).optional(),
  options: z.object({
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    stopSequences: z.array(z.string()).optional(),
  }),
  promptHash: z.string(),
  toolsHash: z.string().optional(),
});

export const ModelResponseSchema = z.object({
  requestId: z.string(),
  content: z.string(),
  contentBlocks: z.array(z.unknown()),
  toolCalls: z.array(z.object({
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  })),
  stopReason: ModelStopReasonSchema,
  usage: z.object({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    cacheReadTokens: z.number().int().min(0).optional(),
    cacheCreationTokens: z.number().int().min(0).optional(),
  }),
  model: z.string(),
});

export interface ModelTakeoverRequestPayload {
  requestId: string;
  agent: string;
  purpose: string;
  modelTier?: string;
  messages: unknown[];
  tools?: unknown[];
  system?: string;
  promptHash: string;
  toolsHash?: string;
}

export interface ModelTakeoverRespondPayload {
  requestId: string;
  content: string;
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason?: string;
  error?: string;
}

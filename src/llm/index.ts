// LLM module — public API barrel export
export { createLlmClient, createTestLlmClient, LlmClient } from './client.js';
export type { ChatOptions, ChatResult, ChatMessage, StreamChunk, LlmCompletedInfo, LlmCompletedHook, ModelToolDef, ToolUseBlock, TextBlock, CreateLlmClientOptions } from './client.js';
export type { LlmConfig, LlmProvider, ProviderConfig, ThinkingMode, ThinkingDisableStrategy } from './types.js';
export { LlmConfigSchema, getProviderConfig, resolveModel, ModelsConfigSchema } from './types.js';

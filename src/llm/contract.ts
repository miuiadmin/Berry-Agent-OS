import type { ModelRequest, ModelResponse, ModelContentBlock, ModelToolCall } from '../contracts/model.js';

export interface LlmBackend {
  chat(request: ModelRequest, options?: { signal?: AbortSignal }): Promise<ModelResponse>;
  getModel(): string;
}

// === Streaming Types ===

export type StreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_start' }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'reasoning_end' }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; partialJson: string }
  | { type: 'tool_use_done'; id: string; input: Record<string, unknown> }
  | { type: 'content_block_stop' }
  | { type: 'message_done'; response: ModelResponse };

export interface StreamingLlmBackend extends LlmBackend {
  chatStream(request: ModelRequest, options?: { signal?: AbortSignal }): AsyncGenerator<StreamChunk>;
}

export function isStreamingBackend(backend: LlmBackend): backend is StreamingLlmBackend {
  return 'chatStream' in backend && typeof (backend as StreamingLlmBackend).chatStream === 'function';
}

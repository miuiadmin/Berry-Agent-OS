import type { LlmBackend } from '../contract.js';
import type { ModelRequest, ModelResponse } from '../../contracts/model.js';
import type { IpcChildChannel } from '../../kernel/ipc.js';
import type { ModelTakeoverRequestPayload, ModelTakeoverRespondPayload } from '../../contracts/model.js';

export class IpcTakeoverBackend implements LlmBackend {
  private model: string;
  private ipc: IpcChildChannel;
  private timeoutMs: number;

  constructor(ipc: IpcChildChannel, model = 'takeover-model', timeoutMs = 60000) {
    this.ipc = ipc;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async chat(request: ModelRequest, _options?: { signal?: AbortSignal }): Promise<ModelResponse> {
    const payload: ModelTakeoverRequestPayload = {
      requestId: request.id,
      agent: request.agent,
      purpose: request.purpose,
      modelTier: request.modelTier,
      messages: request.messages,
      tools: request.tools,
      system: request.system,
      promptHash: request.promptHash,
      toolsHash: request.toolsHash,
    };

    const response = await this.ipc.request(
      'model.takeover.request',
      'core',
      payload,
      this.timeoutMs,
    );

    const result = response.payload as ModelTakeoverRespondPayload;

    if (result.error) {
      throw new Error(result.error);
    }

    const toolCalls = result.toolCalls ?? [];
    const contentBlocks = [
      ...(result.content ? [{ type: 'text' as const, text: result.content }] : []),
      ...toolCalls.map((tc) => ({
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.name,
        input: tc.input,
      })),
    ];

    return {
      requestId: request.id,
      content: result.content,
      contentBlocks,
      toolCalls,
      stopReason: (result.stopReason as ModelResponse['stopReason']) ?? 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
      model: this.model,
    };
  }

  getModel(): string {
    return this.model;
  }
}

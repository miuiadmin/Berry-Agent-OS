import type { LlmBackend } from '../contract.js';
import type { ModelRequest, ModelResponse, ModelMode } from '../../contracts/model.js';

export interface MockResponse {
  content: string;
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason?: ModelResponse['stopReason'];
}

export interface TakeoverRequest {
  request: ModelRequest;
  resolve: (response: ModelResponse) => void;
  reject: (error: Error) => void;
}

export class TestBackend implements LlmBackend {
  private mode: ModelMode;
  private model: string;
  private mockResponses: MockResponse[] = [];
  private replayIndex = 0;
  private takeoverQueue: TakeoverRequest[] = [];

  constructor(mode: ModelMode = 'mock', model = 'test-model') {
    this.mode = mode;
    this.model = model;
  }

  setMockResponses(responses: MockResponse[]): void {
    this.mockResponses = responses;
    this.replayIndex = 0;
  }

  addMockResponse(response: MockResponse): void {
    this.mockResponses.push(response);
  }

  getPendingTakeoverRequests(): TakeoverRequest[] {
    return [...this.takeoverQueue];
  }

  respondToTakeover(requestId: string, response: Omit<ModelResponse, 'requestId'>): boolean {
    const idx = this.takeoverQueue.findIndex((r) => r.request.id === requestId);
    if (idx === -1) return false;
    const [item] = this.takeoverQueue.splice(idx, 1);
    item.resolve({ ...response, requestId });
    return true;
  }

  rejectTakeover(requestId: string, error: Error): boolean {
    const idx = this.takeoverQueue.findIndex((r) => r.request.id === requestId);
    if (idx === -1) return false;
    const [item] = this.takeoverQueue.splice(idx, 1);
    item.reject(error);
    return true;
  }

  async chat(request: ModelRequest, _options?: { signal?: AbortSignal }): Promise<ModelResponse> {
    switch (this.mode) {
      case 'mock':
        return this.handleMock(request);
      case 'replay':
        return this.handleReplay(request);
      case 'takeover':
        return this.handleTakeover(request);
      default:
        throw new Error(`TestBackend 不支持 mode=${this.mode}`);
    }
  }

  getModel(): string {
    return this.model;
  }

  private handleMock(request: ModelRequest): ModelResponse {
    const mock = this.mockResponses.shift();
    if (!mock) {
      return this.defaultResponse(request.id);
    }
    return this.buildResponse(request.id, mock);
  }

  private handleReplay(request: ModelRequest): ModelResponse {
    if (this.replayIndex >= this.mockResponses.length) {
      throw new Error(`Replay 模式已耗尽预设响应 (index=${this.replayIndex})`);
    }
    const mock = this.mockResponses[this.replayIndex++];
    return this.buildResponse(request.id, mock);
  }

  private handleTakeover(request: ModelRequest): Promise<ModelResponse> {
    return new Promise((resolve, reject) => {
      this.takeoverQueue.push({ request, resolve, reject });
    });
  }

  private buildResponse(requestId: string, mock: MockResponse): ModelResponse {
    const toolCalls = mock.toolCalls ?? [];
    const contentBlocks = [
      ...(mock.content ? [{ type: 'text' as const, text: mock.content }] : []),
      ...toolCalls.map((tc) => ({
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.name,
        input: tc.input,
      })),
    ];

    return {
      requestId,
      content: mock.content,
      contentBlocks,
      toolCalls,
      stopReason: mock.stopReason ?? (toolCalls.length > 0 ? 'tool_use' : 'end_turn'),
      usage: { inputTokens: 0, outputTokens: 0 },
      model: this.model,
    };
  }

  private defaultResponse(requestId: string): ModelResponse {
    return {
      requestId,
      content: '',
      contentBlocks: [{ type: 'text', text: '' }],
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
      model: this.model,
    };
  }
}

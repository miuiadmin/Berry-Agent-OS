import type { ModelTakeoverRequestPayload, ModelTakeoverRespondPayload } from '../contracts/model.js';

export interface PendingModelRequest {
  requestId: string;
  agent: string;
  purpose: string;
  modelTier?: string;
  messages: unknown[];
  tools?: unknown[];
  system?: string;
  promptHash: string;
  toolsHash?: string;
  receivedAt: number;
}

interface PendingEntry {
  request: PendingModelRequest;
  respond: (payload: ModelTakeoverRespondPayload) => void;
}

export class TakeoverController {
  private pending = new Map<string, PendingEntry>();
  private waiters: Array<{ resolve: (req: PendingModelRequest) => void; timer: ReturnType<typeof setTimeout> }> = [];

  addRequest(payload: ModelTakeoverRequestPayload, respond: (p: ModelTakeoverRespondPayload) => void): void {
    const entry: PendingEntry = {
      request: {
        requestId: payload.requestId,
        agent: payload.agent,
        purpose: payload.purpose,
        modelTier: payload.modelTier,
        messages: payload.messages,
        tools: payload.tools,
        system: payload.system,
        promptHash: payload.promptHash,
        toolsHash: payload.toolsHash,
        receivedAt: Date.now(),
      },
      respond,
    };
    this.pending.set(payload.requestId, entry);

    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(entry.request);
    }
  }

  getPending(): PendingModelRequest[] {
    return [...this.pending.values()].map((e) => e.request);
  }

  respond(requestId: string, content: string, options?: { toolCalls?: ModelTakeoverRespondPayload['toolCalls']; stopReason?: string }): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.respond({
      requestId,
      content,
      toolCalls: options?.toolCalls,
      stopReason: options?.stopReason,
    });
    return true;
  }

  reject(requestId: string, error: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.respond({ requestId, content: '', error });
    return true;
  }

  waitForRequest(timeoutMs = 10000): Promise<PendingModelRequest> {
    const existing = this.pending.values().next();
    if (!existing.done) {
      return Promise.resolve(existing.value.request);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`Takeover waitForRequest timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      this.waiters.push({ resolve, timer });
    });
  }

  dispose(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
    }
    this.waiters = [];
    for (const [id] of this.pending) {
      this.reject(id, 'TakeoverController disposed');
    }
  }
}

import type Database from 'better-sqlite3';
import type { TakeoverController, PendingModelRequest } from './model-takeover.js';

export interface RecordedExchange {
  requestId: string;
  agent: string;
  purpose: string;
  modelTier?: string;
  system?: string;
  messages: unknown[];
  tools?: unknown[];
  promptHash: string;
  response: string;
  timestamp: number;
}

export interface SessionRecording {
  sessionId: string;
  exchanges: RecordedExchange[];
  recordedAt: number;
}

export class SessionRecorder {
  private exchanges: RecordedExchange[] = [];
  private sessionId: string;
  private recording = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  start(): void {
    this.recording = true;
    this.exchanges = [];
  }

  stop(): SessionRecording {
    this.recording = false;
    return {
      sessionId: this.sessionId,
      exchanges: [...this.exchanges],
      recordedAt: Date.now(),
    };
  }

  recordExchange(request: PendingModelRequest, response: string): void {
    if (!this.recording) return;
    this.exchanges.push({
      requestId: request.requestId,
      agent: request.agent,
      purpose: request.purpose,
      modelTier: request.modelTier,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      promptHash: request.promptHash,
      response,
      timestamp: Date.now(),
    });
  }

  static fromDb(db: Database.Database, sessionId: string): SessionRecording {
    const rows = db.prepare(`
      SELECT id, agent, purpose, model_tier, system_prompt, input_messages, tools,
             prompt_hash, output_content, created_at
      FROM model_requests
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as Array<{
      id: string; agent: string; purpose: string; model_tier: string;
      system_prompt: string; input_messages: string; tools: string;
      prompt_hash: string; output_content: string; created_at: number;
    }>;

    const exchanges: RecordedExchange[] = rows.map(r => ({
      requestId: r.id,
      agent: r.agent,
      purpose: r.purpose,
      modelTier: r.model_tier,
      system: r.system_prompt,
      messages: JSON.parse(r.input_messages || '[]'),
      tools: r.tools ? JSON.parse(r.tools) : undefined,
      promptHash: r.prompt_hash,
      response: r.output_content || '',
      timestamp: r.created_at,
    }));

    return { sessionId, exchanges, recordedAt: Date.now() };
  }
}

export class SessionReplayer {
  private cursor = 0;

  constructor(private readonly recording: SessionRecording) {}

  get remaining(): number {
    return this.recording.exchanges.length - this.cursor;
  }

  get isComplete(): boolean {
    return this.cursor >= this.recording.exchanges.length;
  }

  respondNext(controller: TakeoverController): Promise<void> {
    if (this.isComplete) {
      return Promise.reject(new Error('Recording exhausted'));
    }

    return new Promise<void>((resolve, reject) => {
      controller.waitForRequest(10000)
        .then((req) => {
          const exchange = this.recording.exchanges[this.cursor++];
          controller.respond(req.requestId, exchange.response);
          resolve();
        })
        .catch(reject);
    });
  }

  async replayAll(controller: TakeoverController): Promise<number> {
    let replayed = 0;
    while (!this.isComplete) {
      await this.respondNext(controller);
      replayed++;
    }
    return replayed;
  }
}

import type { ModelTakeoverRespondPayload } from '../contracts/model.js';

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

export interface ITakeoverController {
  addRequest(payload: unknown, respond: (p: ModelTakeoverRespondPayload) => void): void;
  getPending(): PendingModelRequest[];
  respond(requestId: string, content: string, options?: { toolCalls?: unknown[]; stopReason?: string }): boolean;
  reject(requestId: string, error: string): boolean;
  waitForRequest(timeoutMs?: number): Promise<PendingModelRequest>;
  dispose(): void;
}

export interface ITestHarness {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(message: string): Promise<{ response: string; sessionId: string; taskId: string }>;
  getTakeoverController(): ITakeoverController | null;
}

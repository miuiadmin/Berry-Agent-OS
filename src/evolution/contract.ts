import type { EvolutionRunResult } from './types.js';
import type { CapabilityRequestPayload } from '../contracts/capabilities.js';
import type { EvolutionExtractionInput } from './unified-extractor.js';

export interface IEvolutionEngine {
  runAfterConversation(params: {
    sessionId: string;
    userMessage: string;
    assistantResponse: string;
  }): EvolutionRunResult;

  runAfterConversationAsync?(params: EvolutionExtractionInput): Promise<EvolutionRunResult>;
}

export interface ICapabilityService {
  handle(request: CapabilityRequestPayload): unknown;
}

export type { EvolutionRunResult };

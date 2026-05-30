export { detectLearningSignals } from './detector.js';
export { parseLearningSignalsFromText } from './detector-parser.js';
export { CapabilityService } from './capability-service.js';
export { EvolutionEngine } from './engine.js';
export { EvolutionProposalStore } from './store.js';
export { EvolutionWorkflow } from './workflow.js';
export { UnifiedEvolutionExtractor } from './unified-extractor.js';
export type {
  CreateEvolutionProposalInput,
  EvolutionEvidence,
  EvolutionProposal,
  EvolutionProposalSource,
  EvolutionProposalStatus,
  EvolutionProposalType,
  EvolutionRiskLevel,
  EvolutionRunResult,
  LearningSignal,
} from './types.js';
export type {
  EvolutionExtractionInput,
  EvolutionExtractionOutput,
  UserFact,
  DecisionFeedback,
} from './unified-extractor.js';

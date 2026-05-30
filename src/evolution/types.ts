export const EVOLUTION_PROPOSAL_TYPES = [
  'skill_create',
  'skill_patch',
  'plugin_create',
  'plugin_patch',
] as const;

export const EVOLUTION_PROPOSAL_SOURCES = [
  'conversation',
  'tool_failure',
  'user_correction',
  'reference_source',
  'manual',
] as const;

export const EVOLUTION_PROPOSAL_STATUSES = [
  'draft',
  'validating',
  'pending_review',
  'pending_user_confirm',
  'approved',
  'applied',
  'rejected',
  'failed',
  'quarantined',
  'rolled_back',
] as const;

export const EVOLUTION_RISK_LEVELS = ['low', 'medium', 'high'] as const;

export type EvolutionProposalType = typeof EVOLUTION_PROPOSAL_TYPES[number];
export type EvolutionProposalSource = typeof EVOLUTION_PROPOSAL_SOURCES[number];
export type EvolutionProposalStatus = typeof EVOLUTION_PROPOSAL_STATUSES[number];
export type EvolutionRiskLevel = typeof EVOLUTION_RISK_LEVELS[number];

export interface EvolutionEvidence {
  sessionId?: string;
  userMessage?: string;
  assistantResponse?: string;
  observations: string[];
  confidence: number;
}

export interface EvolutionProposal {
  id: string;
  type: EvolutionProposalType;
  source: EvolutionProposalSource;
  targetName: string;
  evidence: EvolutionEvidence;
  draftPath: string | null;
  diff: Record<string, unknown> | null;
  validatorResult: Record<string, unknown> | null;
  riskLevel: EvolutionRiskLevel;
  status: EvolutionProposalStatus;
  brainReviewId: string | null;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateEvolutionProposalInput {
  type: EvolutionProposalType;
  source: EvolutionProposalSource;
  targetName: string;
  evidence: EvolutionEvidence;
  draftPath?: string;
  diff?: Record<string, unknown>;
  validatorResult?: Record<string, unknown>;
  riskLevel?: EvolutionRiskLevel;
  status?: EvolutionProposalStatus;
  reason?: string;
}

export interface LearningSignal {
  kind: 'skill' | 'plugin';
  targetName: string;
  description: string;
  observations: string[];
  riskLevel: EvolutionRiskLevel;
}

export interface EvolutionRunResult {
  proposals: EvolutionProposal[];
  applied: Array<{ proposalId: string; targetName: string; path: string; kind: 'skill' | 'plugin' }>;
  skippedReason?: string;
}

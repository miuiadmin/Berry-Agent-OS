export type TrustLevel = 'probation' | 'standard' | 'trusted' | 'autonomous';

export type SuperiorReviewVerdict = 'approve' | 'modify' | 'reject';

export interface SuperiorReviewRequest {
  delegationId: string;
  correlationId: string;
  agentId: string;
  agentName: string;
  superiorId: string;
  superiorName: string;
  workspaceId: string;
  userMessage: string;
  draftResponse: string;
  toolCalls: Array<{ name: string; input: string; result: string }>;
  trustLevel: TrustLevel;
  chainDepth: number;
}

export interface SuperiorReviewResult {
  delegationId: string;
  correlationId: string;
  superiorId: string;
  verdict: SuperiorReviewVerdict;
  modifiedResponse?: string;
  reason?: string;
}

export interface TrustEscalationRules {
  probationToStandard: number;
  standardToTrusted: number;
}

export const DEFAULT_TRUST_RULES: TrustEscalationRules = {
  probationToStandard: 10,
  standardToTrusted: 30,
};

export type ReviewRiskLevel = 'low' | 'medium' | 'high';

export interface AutoApproveDecision {
  autoApprove: boolean;
  reason: string;
  riskLevel: ReviewRiskLevel;
}

export const TRUST_LEVELS_ORDERED: TrustLevel[] = ['probation', 'standard', 'trusted', 'autonomous'];

export const AUTO_APPROVE_TOKEN_THRESHOLD = 2000;
export const AUTONOMOUS_RANDOM_AUDIT_RATE = 0.05;

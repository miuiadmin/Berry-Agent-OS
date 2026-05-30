import { z } from 'zod';
import type { AgentName } from './agents.js';

export const APPROVAL_KINDS = [
  'tool',
  'shell',
  'file',
  'plugin',
  'code',
  'brain',
  'user',
] as const;

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
] as const;

export const DECISION_SOURCES = [
  'rule',
  'brain',
  'user',
  'allowlist',
  'blocklist',
] as const;

export const PERMISSION_VERDICTS = ['allow_once', 'allow_session'] as const;

export type ApprovalKind = typeof APPROVAL_KINDS[number];
export type RiskLevel = typeof RISK_LEVELS[number];
export type ApprovalStatus = typeof APPROVAL_STATUSES[number];
export type DecisionSource = typeof DECISION_SOURCES[number];
export type PermissionVerdict = typeof PERMISSION_VERDICTS[number];

export const ApprovalKindSchema = z.enum(APPROVAL_KINDS);
export const RiskLevelSchema = z.enum(RISK_LEVELS);
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);
export const DecisionSourceSchema = z.enum(DECISION_SOURCES);
export const PermissionVerdictSchema = z.enum(PERMISSION_VERDICTS);

export interface PermissionBinding {
  runId?: string;
  sessionId: string;
  taskId?: string;
  agentName: AgentName;
  toolName: string;
  inputHash: string;
  cwd?: string;
  argv?: string[];
  envHash?: string;
  fileHash?: string;
}

export interface ApprovalRequest {
  id: string;
  runId: string | null;
  sessionId: string;
  taskId: string | null;
  correlationId: string;
  kind: ApprovalKind;
  requester: string;
  riskLevel: RiskLevel;
  requestPayload: Record<string, unknown>;
  bindingPayload: PermissionBinding;
  status: ApprovalStatus;
  decisionSource: DecisionSource | null;
  reason: string | null;
  expiresAt: number;
  createdAt: number;
  resolvedAt: number | null;
}

export interface PermissionToken {
  id: string;
  approvalId: string;
  runId: string | null;
  sessionId: string;
  agentName: AgentName;
  toolName: string;
  inputHash: string;
  cwd: string | null;
  bindingHash: string;
  verdict: PermissionVerdict;
  oneTime: boolean;
  consumed: boolean;
  expiresAt: number;
  createdAt: number;
  consumedAt: number | null;
}

export const PermissionBindingSchema = z.object({
  runId: z.string().optional(),
  sessionId: z.string(),
  taskId: z.string().optional(),
  agentName: z.string(),
  toolName: z.string(),
  inputHash: z.string(),
  cwd: z.string().optional(),
  argv: z.array(z.string()).optional(),
  envHash: z.string().optional(),
  fileHash: z.string().optional(),
});

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  sessionId: z.string(),
  taskId: z.string().nullable(),
  correlationId: z.string(),
  kind: ApprovalKindSchema,
  requester: z.string(),
  riskLevel: RiskLevelSchema,
  requestPayload: z.record(z.string(), z.unknown()),
  bindingPayload: PermissionBindingSchema,
  status: ApprovalStatusSchema,
  decisionSource: DecisionSourceSchema.nullable(),
  reason: z.string().nullable(),
  expiresAt: z.number(),
  createdAt: z.number(),
  resolvedAt: z.number().nullable(),
});

export const PermissionTokenSchema = z.object({
  id: z.string(),
  approvalId: z.string(),
  runId: z.string().nullable(),
  sessionId: z.string(),
  agentName: z.string(),
  toolName: z.string(),
  inputHash: z.string(),
  cwd: z.string().nullable(),
  bindingHash: z.string(),
  verdict: PermissionVerdictSchema,
  oneTime: z.boolean(),
  consumed: z.boolean(),
  expiresAt: z.number(),
  createdAt: z.number(),
  consumedAt: z.number().nullable(),
});

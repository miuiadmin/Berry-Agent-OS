import type { DangerLevel } from '../utils/types.js';

export type PermissionMode = 'ask' | 'allow-all' | 'deny-all';

export interface PermissionCheckResult {
  allowed: boolean;
  requiresReview?: boolean;
  reason?: string;
}

export interface IPermissionEngine {
  checkPermission(toolName: string, toolInput: string, dangerLevel: DangerLevel): PermissionCheckResult;
  getMode(): PermissionMode;
}

export interface TokenIssueParams {
  approvalId?: string;
  runId?: string;
  sessionId: string;
  agentName: string;
  toolName: string;
  inputHash: string;
  cwd?: string;
  verdict?: 'allow_once' | 'allow_session';
  expiresMs?: number;
}

export interface PermissionToken {
  id: string;
  approvalId: string | null;
  runId: string | null;
  sessionId: string;
  agentName: string;
  toolName: string;
  inputHash: string;
  cwd: string | null;
  bindingHash: string;
  verdict: 'allow_once' | 'allow_session';
  oneTime: boolean;
  consumed: boolean;
  expiresAt: number;
  createdAt: number;
  consumedAt: number | null;
}

export interface TokenBinding {
  sessionId: string;
  agentName: string;
  toolName: string;
  inputHash: string;
  cwd?: string;
}

export type ValidationResult =
  | { valid: true; token: PermissionToken }
  | { valid: false; reason: string };

export interface ITokenIssuer {
  issue(params: TokenIssueParams): PermissionToken;
  validate(tokenId: string, binding: TokenBinding): ValidationResult;
  consume(tokenId: string): boolean;
  findSessionToken(binding: TokenBinding): PermissionToken | null;
}

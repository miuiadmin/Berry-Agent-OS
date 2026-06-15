import type { DangerLevel } from '../utils/types.js';

/**
 * 权限模式（15.0 机制 A 权威定义）。
 * - ask（默认）：L1 safe 规则放行 / L2 moderate 走 Brain / L3 dangerous 走用户确认
 * - yolo：L2 + L3 全走 Brain（用户委托 Brain 决定，不再打扰用户）
 * - allow-all / deny-all：全放行 / 全拒绝（慎用 / 锁死）
 */
export type PermissionMode = 'ask' | 'allow-all' | 'deny-all' | 'yolo';

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
  // findSessionToken 已在 16.0 §17.8 删除（零调用方）
}

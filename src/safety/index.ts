// Safety module — public API barrel export
export { checkBlocklist, normalizeCommand } from './blocklist.js';
export type { BlocklistResult } from './blocklist.js';

export { PermissionEngine } from './permissions.js';
export type { PermissionMode, PermissionResult } from './permissions.js';

export { TokenIssuer } from './token-issuer.js';
export type { IssueTokenParams, PermissionToken, TokenBinding, ValidationResult } from './token-issuer.js';
// TokenAuditEntry 已在 16.0 §17.8 随 getAuditLog 一并删除

export { ApprovalManager } from './approval-manager.js';
export type { ApprovalKind, RiskLevel, ApprovalStatus, DecisionSource, CreateApprovalParams, ApprovalRequest, ResolveDecision, PendingApproval } from './approval-manager.js';

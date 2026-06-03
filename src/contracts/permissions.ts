export interface PermissionRequestPayload {
  toolName: string;
  toolInput: string;
  dangerLevel: string;
  taskId?: string;
  /** dialogue 模式下显式传递 sessionId，避免通过 findPending 反查导致跨会话污染 */
  sessionId?: string;
}

export interface PermissionValidatePayload {
  tokenId: string;
  sessionId: string;
  toolName: string;
  toolInput: string;
}

export interface PermissionAcquirePayload {
  toolName: string;
  toolInput: string;
  dangerLevel: string;
  taskId?: string;
}

export interface PermissionConsumePayload {
  tokenId: string;
}

export interface PermissionResultPayload {
  allowed: boolean;
  requiresReview?: boolean;
  reason?: string;
  tokenId?: string;
  requestId?: string;
}

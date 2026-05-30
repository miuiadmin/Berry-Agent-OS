export interface PermissionRequestPayload {
  toolName: string;
  toolInput: string;
  dangerLevel: string;
  taskId?: string;
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
}

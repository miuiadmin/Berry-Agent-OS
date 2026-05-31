/**
 * Typed WebSocket message contracts between backend and frontend.
 * Each interface corresponds to a `type` field value from the server.
 */

// ─── Server → Client messages ─────────────────────────────────────

export interface TextDeltaMessage {
  type: "text_delta";
  text: string;
}

export interface ProgressMessage {
  type: "progress";
  summary?: string;
  pct?: number;
}

export interface ResultMessage {
  type: "result";
  content?: string;
}

export interface ErrorMessage {
  type: "error";
  error?: string;
  message?: string;
}

export interface CancelledMessage {
  type: "cancelled";
}

export interface InterruptedMessage {
  type: "interrupted";
}

export interface DelegationNeededMessage {
  type: "delegation.needed";
  delegationId: string;
  sessionId: string;
  requestedBy: string;
  title: string;
  description: string;
  urgency: string;
  options: string[];
}

export interface PermissionConfirmNeededMessage {
  type: "permission.confirm_needed";
  requestId: string;
  sessionId: string;
  agentName: string;
  toolName: string;
  toolInput: string;
  dangerLevel: string;
  brainReason: string;
}

/** Union of all server → client WebSocket messages */
export type ServerMessage =
  | TextDeltaMessage
  | ProgressMessage
  | ResultMessage
  | ErrorMessage
  | CancelledMessage
  | InterruptedMessage
  | DelegationNeededMessage
  | PermissionConfirmNeededMessage;

// ─── Client → Server messages ─────────────────────────────────────

export interface ClientChatMessage {
  type: "message";
  text: string;
  sessionId: string | null;
  attachments?: Array<{ fileId: string; filename: string; mimeType: string; url: string }>;
}

export interface ClientInterruptMessage {
  type: "interrupt";
}

export interface ClientDelegationResponseMessage {
  type: "delegation.respond";
  delegationId: string;
  response: string | null;
  status: "approved" | "denied";
}

export interface ClientPermissionResponseMessage {
  type: "permissions.approve" | "permissions.deny";
  requestId: string;
}

/** Union of all client → server WebSocket messages */
export type ClientMessage =
  | ClientChatMessage
  | ClientInterruptMessage
  | ClientDelegationResponseMessage
  | ClientPermissionResponseMessage;

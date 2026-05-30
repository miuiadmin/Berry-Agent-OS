export interface ToolAuditPayload {
  sessionId: string;
  taskId?: string;
  correlationId?: string;
  toolName: string;
  toolInput: string;
  permissionToken?: string;
  toolResult: string;
  isError: boolean;
  dangerLevel: string;
  durationMs: number;
}

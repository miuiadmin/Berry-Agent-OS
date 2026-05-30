import { z } from 'zod';

export const SocketMessageRequestSchema = z.object({
  type: z.literal('message'),
  message: z.string().min(1),
  sessionId: z.string().optional(),
  streaming: z.boolean().optional(),
  permissionMode: z.string().optional(),
  correlationId: z.string().optional(),
});

export const DaemonRegisterSchema = z.object({
  type: z.literal('daemon.register'),
  runtimeName: z.string().min(1),
  capabilities: z.array(z.string()).optional(),
  pid: z.number().int().positive().optional(),
  correlationId: z.string().optional(),
});

export const DaemonHeartbeatSchema = z.object({
  type: z.literal('daemon.heartbeat'),
  runtimeName: z.string().min(1),
  activeTasks: z.number().int().min(0).optional(),
  correlationId: z.string().optional(),
});

export const DaemonTaskResultSchema = z.object({
  type: z.literal('daemon.task.result'),
  taskId: z.string().min(1),
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  correlationId: z.string().optional(),
});

export const EvolutionDispatchSchema = z.object({
  type: z.literal('evolution.dispatch'),
  taskType: z.string().min(1),
  sessionId: z.string().optional(),
  requester: z.string().optional(),
  inputPayload: z.record(z.string(), z.unknown()).optional(),
  correlationId: z.string().optional(),
});

export const HandshakeRequestSchema = z.object({
  type: z.literal('handshake'),
  protocolVersion: z.string().min(1),
  clientId: z.string().optional(),
  token: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
});

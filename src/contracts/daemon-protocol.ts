// Protocol messages exchanged between Daemon process and CoreService over Unix Socket (JSON-line).
// Direction: → = daemon to core, ← = core to daemon

import type { NormalizedExternalEvent } from './daemon-events.js';

// === Runtime Info ===

export interface RuntimeInfo {
  name: string;
  version: string;
  command: string;
  capabilities: string[];
}

// === daemon.register (→) ===

export interface DaemonRegisterMessage {
  type: 'daemon.register';
  daemonId: string;
  pid: number;
  runtimes: RuntimeInfo[];
  maxSlots: number;
  availableSlots: number;
}

export interface DaemonRegisterAckMessage {
  type: 'daemon.register_ack';
  ok: boolean;
  error?: string;
}

// === daemon.heartbeat (→) / daemon.heartbeat_ack (←) ===

export interface DaemonHeartbeatMessage {
  type: 'daemon.heartbeat';
  daemonId: string;
  availableSlots: number;
  runningTasks: string[];
  uptimeMs: number;
}

export interface DaemonHeartbeatAckMessage {
  type: 'daemon.heartbeat_ack';
  ok: boolean;
}

// === daemon.task.notify (←) ===

export interface DaemonTaskNotifyMessage {
  type: 'daemon.task.notify';
  taskId: string;
  taskType: string;
  priority: number;
  preferredRuntime?: string;
  inputPayload: DaemonTaskInput;
}

export interface DaemonTaskInput {
  prompt: string;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
  resumeSessionId?: string;
  systemPrompt?: string;
  extraArgs?: string[];
  thinkingLevel?: string;
  traceId?: string;
}

// === daemon.task.claim (→) / daemon.task.claim_ack (←) ===

export interface DaemonTaskClaimMessage {
  type: 'daemon.task.claim';
  taskId: string;
  runtime: string;
  executionId: string;
}

export interface DaemonTaskClaimAckMessage {
  type: 'daemon.task.claim_ack';
  taskId: string;
  ok: boolean;
  reason?: string;
}

// === daemon.task.started (→) ===

export interface DaemonTaskStartedMessage {
  type: 'daemon.task.started';
  taskId: string;
  executionId: string;
  runtime: string;
  pid: number;
}

// === daemon.task.progress (→) ===

export interface DaemonTaskProgressMessage {
  type: 'daemon.task.progress';
  taskId: string;
  executionId: string;
  event: NormalizedExternalEvent;
}

// === daemon.task.result (→) ===

export interface DaemonTaskResultMessage {
  type: 'daemon.task.result';
  taskId: string;
  executionId: string;
  runtime: string;
  ok: boolean;
  output?: string;
  error?: string;
  sessionId?: string;
  usage?: DaemonTaskUsage;
  durationMs: number;
  toolCallCount: number;
}

export interface DaemonTaskUsage {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// === daemon.task.cancel (←) ===

export interface DaemonTaskCancelMessage {
  type: 'daemon.task.cancel';
  taskId: string;
  reason?: string;
}

// === daemon.task.correction (←) ===

export interface DaemonTaskCorrectionMessage {
  type: 'daemon.task.correction';
  taskId: string;
  action: 'adjust' | 'stop';
  instruction?: string;
  newConstraints?: {
    maxRemainingTokens?: number;
    forbiddenTools?: string[];
    requiredApproach?: string;
    reducedTimeout?: number;
  };
}

// === daemon.disconnect (→) ===

export interface DaemonDisconnectMessage {
  type: 'daemon.disconnect';
  daemonId: string;
  reason: string;
}

// === Union type for dispatch ===

export type DaemonToCoreMessage =
  | DaemonRegisterMessage
  | DaemonHeartbeatMessage
  | DaemonTaskClaimMessage
  | DaemonTaskStartedMessage
  | DaemonTaskProgressMessage
  | DaemonTaskResultMessage
  | DaemonDisconnectMessage;

export type CoreToDaemonMessage =
  | DaemonRegisterAckMessage
  | DaemonHeartbeatAckMessage
  | DaemonTaskNotifyMessage
  | DaemonTaskClaimAckMessage
  | DaemonTaskCancelMessage
  | DaemonTaskCorrectionMessage;

export type DaemonProtocolMessage = DaemonToCoreMessage | CoreToDaemonMessage;

export type DaemonMessageType = DaemonProtocolMessage['type'];

export const DAEMON_MESSAGE_TYPES: DaemonMessageType[] = [
  'daemon.register',
  'daemon.register_ack',
  'daemon.heartbeat',
  'daemon.heartbeat_ack',
  'daemon.task.notify',
  'daemon.task.claim',
  'daemon.task.claim_ack',
  'daemon.task.started',
  'daemon.task.progress',
  'daemon.task.result',
  'daemon.task.cancel',
  'daemon.task.correction',
  'daemon.disconnect',
];

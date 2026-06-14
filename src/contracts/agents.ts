import { z } from 'zod';

// === Agent Roles ===

export const AGENT_ROLES = ['reviewer', 'primary', 'plugin-host', 'orchestrator'] as const;
export type AgentRole = typeof AGENT_ROLES[number];
export const AgentRoleSchema = z.enum(AGENT_ROLES);

// === Bundled Agent Names (for IDE autocomplete) ===

export const BUNDLED_AGENT_NAMES = [
  'brain',
  'conversation',
  'learning',
  'skills',
  'plugin-builder',
  'code',
  'skill-tester',
] as const;

export type BundledAgentName = typeof BUNDLED_AGENT_NAMES[number];
export type AgentName = BundledAgentName | (string & {});

export function isBundledAgent(name: string): name is BundledAgentName {
  return (BUNDLED_AGENT_NAMES as readonly string[]).includes(name);
}

// === Bundled Task Types (for IDE autocomplete) ===

export const BUNDLED_TASK_TYPES = [
  'conversation_turn',
  'brain_review',
  'brain_routing',
  'brain_permission',
  'brain_ask_review',
  'learning_review',
  'skill_task',
  'skill_test',
  'plugin_task',
  'code_task',
] as const;

export type BundledTaskType = typeof BUNDLED_TASK_TYPES[number];
export type TaskType = BundledTaskType | (string & {});

// === Agent Classification ===

export const AGENT_LEVELS = [1, 2, 3] as const;
export type AgentLevel = typeof AGENT_LEVELS[number];

export const AGENT_STATUSES = [
  'registered',
  'starting',
  'ready',
  'running',
  'stopped',
  'crashed',
  'stalled',
  'failed',
  'disabled',
  'circuit_broken',
] as const;

export const TASK_STATUSES = [
  'created',
  'persisted',
  'dispatched',
  'acknowledged',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'timeout',
  'cancelled',
  'resumable',
] as const;

export const TASK_EVENT_TYPES = [
  'created',
  'dispatched',
  'acknowledged',
  'started',
  'progress',
  'waiting_approval',
  'resumed',
  'completed',
  'failed',
  'timeout',
  'cancelled',
  'notification',
] as const;

export const MODULE_KINDS = [
  'kernel',
  'agent',
  'module',
  'channel',
  'plugin',
  'testing',
] as const;

export type AgentStatus = typeof AGENT_STATUSES[number];
export type TaskStatus = typeof TASK_STATUSES[number];
export type TaskEventType = typeof TASK_EVENT_TYPES[number];
export type ModuleKind = typeof MODULE_KINDS[number];

// === Zod Schemas (permissive for dynamic agents) ===

export const AgentNameSchema = z.string().min(1);
export const TaskTypeSchema = z.string().min(1);
export const AgentLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const AgentStatusSchema = z.enum(AGENT_STATUSES);
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export const TaskEventTypeSchema = z.enum(TASK_EVENT_TYPES);

// === Data Structures ===

export interface AgentTask {
  id: string;
  runId: string | null;
  sessionId: string;
  correlationId: string;
  taskType: TaskType;
  requester: string;
  targetAgent: AgentName;
  foreground: boolean;
  priority: number;
  inputPayload: Record<string, unknown>;
  outputPayload: Record<string, unknown> | null;
  status: TaskStatus;
  error: string | null;
  createdAt: number;
  dispatchedAt: number | null;
  acknowledgedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  runId: string | null;
  sessionId: string | null;
  source: string;
  eventType: TaskEventType;
  level: 'error' | 'warn' | 'info' | 'debug' | null;
  message: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface AgentCapability {
  name: string;
  taskTypes: TaskType[];
  tools: string[];
  description: string;
}

export interface AgentHome {
  agentName: AgentName;
  level: AgentLevel;
  homeDir: string;
  agentYamlPath: string;
  agentMdPath: string;
  capabilitiesPath: string;
  stateDbPath: string;
  runtimeDir: string;
  tasksDir: string;
  cacheDir: string;
  logsDir: string;
  configHash: string | null;
  instructionHash: string | null;
  capabilitiesHash: string | null;
  status: AgentStatus;
  createdAt: number;
  updatedAt: number;
}

export const AgentTaskSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  sessionId: z.string(),
  correlationId: z.string(),
  taskType: TaskTypeSchema,
  requester: z.string(),
  targetAgent: AgentNameSchema,
  foreground: z.boolean(),
  priority: z.number().int(),
  inputPayload: z.record(z.string(), z.unknown()),
  outputPayload: z.record(z.string(), z.unknown()).nullable(),
  status: TaskStatusSchema,
  error: z.string().nullable(),
  createdAt: z.number(),
  dispatchedAt: z.number().nullable(),
  acknowledgedAt: z.number().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});

export const TaskEventSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  runId: z.string().nullable(),
  sessionId: z.string().nullable(),
  source: z.string(),
  eventType: TaskEventTypeSchema,
  level: z.enum(['error', 'warn', 'info', 'debug']).nullable(),
  message: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
});

export interface AgentRegisterPayload {
  name: string;
  pid: number;
}

export interface AgentHeartbeatPayload {
  name: string;
  uptime: number;
}

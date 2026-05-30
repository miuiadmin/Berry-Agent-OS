export const EXIT_CODES = {
  SUCCESS: 0,
  UNKNOWN_ERROR: 1,
  ARGUMENT_ERROR: 2,
  SERVICE_NOT_RUNNING: 10,
  PERMISSION_DENIED: 13,
  LLM_ERROR: 20,
  TEST_TIMEOUT: 30,
  DB_ERROR: 40,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export interface StructuredError {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function makeError(code: string, message: string, details?: Record<string, unknown>): StructuredError {
  return {
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  };
}

export function exitWithError(code: ExitCode, errorCode: string, message: string, json: boolean = false): never {
  if (json) {
    process.stdout.write(JSON.stringify(makeError(errorCode, message)) + '\n');
  } else {
    process.stderr.write(`错误: ${message}\n`);
  }
  process.exit(code);
}

// --- Typed kernel errors ---

export abstract class KernelError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;

  toStructured(): StructuredError {
    return makeError(this.code, this.message);
  }
}

export class TimeoutError extends KernelError {
  readonly code = 'TIMEOUT';
  readonly retryable = true;
  constructor(message: string, readonly target?: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class AgentUnavailableError extends KernelError {
  readonly code = 'AGENT_UNAVAILABLE';
  readonly retryable = true;
  constructor(message: string, readonly agentName?: string) {
    super(message);
    this.name = 'AgentUnavailableError';
  }
}

export class PermissionDeniedError extends KernelError {
  readonly code = 'PERMISSION_DENIED';
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

export class IpcError extends KernelError {
  readonly code = 'IPC_FAILURE';
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'IpcError';
  }
}

export class TaskStateError extends KernelError {
  readonly code = 'TASK_STATE_INVALID';
  readonly retryable = false;
  constructor(message: string, readonly taskId?: string) {
    super(message);
    this.name = 'TaskStateError';
  }
}

export class AgentTimeoutError extends KernelError {
  readonly code = 'AGENT_TIMEOUT';
  readonly retryable = true;
  constructor(message: string, readonly agentName?: string, readonly taskId?: string) {
    super(message);
    this.name = 'AgentTimeoutError';
  }
}

export class PluginExecutionError extends KernelError {
  readonly code = 'PLUGIN_EXECUTION_FAILED';
  readonly retryable = false;
  constructor(message: string, readonly pluginName?: string, readonly toolName?: string) {
    super(message);
    this.name = 'PluginExecutionError';
  }
}

export class BudgetExceededError extends KernelError {
  readonly code = 'BUDGET_EXCEEDED';
  readonly retryable = false;
  constructor(message: string, readonly scope?: string, readonly scopeId?: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export class ConfigError extends KernelError {
  readonly code = 'CONFIG_INVALID';
  readonly retryable = false;
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class BackpressureError extends KernelError {
  readonly code = 'BACKPRESSURE';
  readonly retryable = true;
  constructor(message: string, readonly messageType?: string) {
    super(message);
    this.name = 'BackpressureError';
  }
}

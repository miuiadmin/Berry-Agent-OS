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

export class ConfigError extends KernelError {
  readonly code = 'CONFIG_INVALID';
  readonly retryable = false;
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Agent 超时错误 — 目标 Agent 在指定时间内未回复。
 *
 * 含义：Agent 还活着（进程未崩溃），但处理慢或卡住了。
 * 调用方可安全重试，或尝试替代路径（如自己查 SQLite）。
 */
export class AgentTimeoutError extends KernelError {
  readonly code = 'AGENT_TIMEOUT';
  readonly retryable = true;
  constructor(message: string, readonly target?: string, readonly timeoutMs?: number) {
    super(message);
    this.name = 'AgentTimeoutError';
  }
}

/**
 * Agent 崩溃错误 — 目标 Agent 进程已终止（非正常退出）。
 *
 * 含义：Agent 进程已经不存在了，重试无意义。
 * 调用方应换其他路径（自己处理 / 问其他 Agent / 告知用户）。
 */
export class AgentCrashError extends KernelError {
  readonly code = 'AGENT_CRASHED';
  readonly retryable = false;
  constructor(message: string, readonly target?: string) {
    super(message);
    this.name = 'AgentCrashError';
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

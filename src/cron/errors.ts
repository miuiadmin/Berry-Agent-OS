import { KernelError } from '../kernel/errors.js';

export class CronExecutionError extends KernelError {
  readonly code = 'CRON_EXECUTION_FAILED';
  readonly retryable = true;
  constructor(message: string, readonly taskId?: string) {
    super(message);
    this.name = 'CronExecutionError';
  }
}

export class CronParseError extends KernelError {
  readonly code = 'CRON_PARSE_INVALID';
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'CronParseError';
  }
}

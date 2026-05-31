export type LlmErrorType =
  | 'auth'
  | 'auth_permanent'
  | 'rate_limit'
  | 'overloaded'
  | 'server_error'
  | 'timeout'
  | 'context_overflow'
  | 'model_not_found'
  | 'format_error';

export interface ClassifiedError {
  type: LlmErrorType;
  retryable: boolean;
  shouldCompress: boolean;
  shouldFallback: boolean;
  backoffMs: number;
  maxRetries: number;
  originalMessage: string;
}

export function classifyLlmError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  const status = extractStatus(err);

  if (status === 401 || message.includes('token expired') || message.includes('invalid api key')) {
    if (message.includes('permanent') || message.includes('revoked')) {
      return { type: 'auth_permanent', retryable: false, shouldCompress: false, shouldFallback: false, backoffMs: 0, maxRetries: 0, originalMessage: message };
    }
    return { type: 'auth', retryable: true, shouldCompress: false, shouldFallback: false, backoffMs: 1000, maxRetries: 1, originalMessage: message };
  }

  if (status === 429 || message.includes('rate limit') || message.includes('too many requests')) {
    return { type: 'rate_limit', retryable: true, shouldCompress: false, shouldFallback: false, backoffMs: 5000, maxRetries: 3, originalMessage: message };
  }

  if (status === 503 || status === 529 || message.includes('overloaded')) {
    return { type: 'overloaded', retryable: true, shouldCompress: false, shouldFallback: false, backoffMs: 30_000, maxRetries: 3, originalMessage: message };
  }

  if (status === 500 || status === 502) {
    return { type: 'server_error', retryable: true, shouldCompress: false, shouldFallback: false, backoffMs: 2000, maxRetries: 2, originalMessage: message };
  }

  if (message.includes('timeout') || message.includes('ETIMEDOUT') || message.includes('ECONNRESET')) {
    return { type: 'timeout', retryable: true, shouldCompress: false, shouldFallback: false, backoffMs: 3000, maxRetries: 2, originalMessage: message };
  }

  if (message.includes('too many tokens') || message.includes('context length') || message.includes('maximum context')) {
    return { type: 'context_overflow', retryable: true, shouldCompress: true, shouldFallback: false, backoffMs: 0, maxRetries: 1, originalMessage: message };
  }

  if (status === 404 || message.includes('model not found') || message.includes('does not exist')) {
    return { type: 'model_not_found', retryable: false, shouldCompress: false, shouldFallback: true, backoffMs: 0, maxRetries: 0, originalMessage: message };
  }

  if (status === 400 || message.includes('bad request') || message.includes('invalid')) {
    return { type: 'format_error', retryable: true, shouldCompress: false, shouldFallback: false, backoffMs: 0, maxRetries: 1, originalMessage: message };
  }

  return { type: 'server_error', retryable: true, shouldCompress: false, shouldFallback: false, backoffMs: 2000, maxRetries: 1, originalMessage: message };
}

function extractStatus(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    const status = obj.status ?? obj.statusCode ?? obj.code;
    if (typeof status === 'number') return status;
  }
  return null;
}

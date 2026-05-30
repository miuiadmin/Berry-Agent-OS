import type { ErrorType, ResumeDecision } from '../contracts/checkpoint.js';
import { MAX_RESUME_COUNT } from '../contracts/checkpoint.js';

const TRANSIENT_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENETUNREACH/i,
  /socket hang up/i,
  /network/i,
  /rate.?limit/i,
  /too many requests/i,
  /429/,
  /503/,
  /502/,
  /504/,
  /overloaded/i,
  /temporarily unavailable/i,
  /retry/i,
  /connection reset/i,
];

const PERMANENT_PATTERNS = [
  /401/,
  /403/,
  /authentication/i,
  /unauthorized/i,
  /forbidden/i,
  /permission denied/i,
  /invalid.*key/i,
  /model.*not.*found/i,
  /invalid.*request/i,
  /400.*bad request/i,
  /malformed/i,
];

const RESOURCE_PATTERNS = [
  /quota/i,
  /token.*limit/i,
  /context.*length/i,
  /ENOSPC/i,
  /disk.*full/i,
  /out of memory/i,
  /OOM/,
  /insufficient.*resources/i,
];

const TIMEOUT_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /deadline exceeded/i,
  /heartbeat.*expired/i,
];

export class ErrorClassifier {
  classify(error: string | Error): ErrorType {
    const msg = typeof error === 'string' ? error : error.message;

    if (TIMEOUT_PATTERNS.some((p) => p.test(msg))) return 'timeout';
    if (PERMANENT_PATTERNS.some((p) => p.test(msg))) return 'permanent';
    if (RESOURCE_PATTERNS.some((p) => p.test(msg))) return 'resource';
    if (TRANSIENT_PATTERNS.some((p) => p.test(msg))) return 'transient';

    return 'permanent';
  }

  shouldAutoResume(
    errorType: ErrorType,
    resumeCount: number,
    hasCheckpoint: boolean,
  ): ResumeDecision {
    if (resumeCount >= MAX_RESUME_COUNT) {
      return { strategy: 'continue', reason: `max resume count (${MAX_RESUME_COUNT}) reached` };
    }

    switch (errorType) {
      case 'transient':
        if (hasCheckpoint) {
          return { strategy: 'continue', reason: 'transient error with valid checkpoint' };
        }
        return { strategy: 'retry_last', reason: 'transient error without checkpoint' };

      case 'timeout':
        if (hasCheckpoint) {
          return { strategy: 'continue', reason: 'timeout with valid checkpoint' };
        }
        return { strategy: 'retry_last', reason: 'timeout without checkpoint' };

      case 'resource':
      case 'permanent':
        return { strategy: 'continue', reason: `${errorType} error — no auto-resume` };
    }
  }

  canAutoResume(errorType: ErrorType, resumeCount: number): boolean {
    if (resumeCount >= MAX_RESUME_COUNT) return false;
    return errorType === 'transient' || errorType === 'timeout';
  }
}

import type { ErrorClassifier } from '../kernel/error-classifier.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('retry-policy');

export interface RetryDecision {
  shouldRetry: boolean;
  delayMs: number;
  reason?: string;
}

export class RetryPolicy {
  constructor(private readonly errorClassifier: ErrorClassifier) {}

  shouldRetry(error: string, currentRetryCount: number, maxRetries: number): RetryDecision {
    if (currentRetryCount >= maxRetries) {
      return { shouldRetry: false, delayMs: 0, reason: 'Max retries exceeded' };
    }

    const errorType = this.errorClassifier.classify(error);

    switch (errorType) {
      case 'permanent':
        return { shouldRetry: false, delayMs: 0, reason: 'Permanent error' };

      case 'transient':
        return {
          shouldRetry: true,
          delayMs: this.computeBackoff(currentRetryCount, 5_000),
        };

      case 'resource':
        return {
          shouldRetry: true,
          delayMs: this.computeBackoff(currentRetryCount, 15_000),
        };

      case 'timeout':
        return { shouldRetry: false, delayMs: 0, reason: 'Timeout error - not retryable' };

      default:
        return {
          shouldRetry: true,
          delayMs: this.computeBackoff(currentRetryCount, 5_000),
        };
    }
  }

  private computeBackoff(retryCount: number, baseDelayMs: number): number {
    const exponential = baseDelayMs * Math.pow(2, retryCount);
    const jitter = exponential * (0.5 + Math.random() * 0.5);
    return Math.min(jitter, 60_000);
  }
}

import { describe, it, expect, vi } from 'vitest';
import { RetryPolicy } from './retry-policy.js';
import type { ErrorClassifier } from '../kernel/error-classifier.js';
import type { ErrorType } from '../contracts/checkpoint.js';

/** Create a mock ErrorClassifier that returns a fixed type for every call. */
function mockClassifier(errorType: ErrorType): ErrorClassifier {
  return { classify: vi.fn().mockReturnValue(errorType) } as unknown as ErrorClassifier;
}

/** Seed Math.random so jitter is deterministic (0.75 factor). */
function seedRandom(value: number) {
  return vi.spyOn(Math, 'random').mockReturnValue(value);
}

describe('RetryPolicy', () => {
  describe('happy path — exponential backoff', () => {
    it('returns shouldRetry=true with backoff delay for transient errors', () => {
      const restore = seedRandom(0);
      const policy = new RetryPolicy(mockClassifier('transient'));

      const decision = policy.shouldRetry('ECONNREFUSED', 0, 3);

      expect(decision.shouldRetry).toBe(true);
      // base 5000 * 2^0 * (0.5 + 0*0.5) = 5000 * 0.5 = 2500
      expect(decision.delayMs).toBe(2500);
      expect(decision.reason).toBeUndefined();

      restore();
    });

    it('increases delay exponentially on successive retries', () => {
      const restore = seedRandom(0.5);
      const policy = new RetryPolicy(mockClassifier('transient'));

      const d0 = policy.shouldRetry('ECONNREFUSED', 0, 5);
      const d1 = policy.shouldRetry('ECONNREFUSED', 1, 5);
      const d2 = policy.shouldRetry('ECONNREFUSED', 2, 5);

      // jitter factor = 0.5 + 0.5*0.5 = 0.75
      // base for transient = 5000
      // d0: 5000 * 2^0 * 0.75 = 3750
      // d1: 5000 * 2^1 * 0.75 = 7500
      // d2: 5000 * 2^2 * 0.75 = 15000
      expect(d0.delayMs).toBe(3750);
      expect(d1.delayMs).toBe(7500);
      expect(d2.delayMs).toBe(15000);

      restore();
    });

    it('uses higher base delay (15s) for resource errors', () => {
      const restore = seedRandom(0);
      const policy = new RetryPolicy(mockClassifier('resource'));

      const decision = policy.shouldRetry('out of memory', 0, 3);

      expect(decision.shouldRetry).toBe(true);
      // base 15000 * 2^0 * (0.5 + 0*0.5) = 7500
      expect(decision.delayMs).toBe(7500);

      restore();
    });
  });

  describe('max retry limit', () => {
    it('stops retrying when currentRetryCount equals maxRetries', () => {
      const policy = new RetryPolicy(mockClassifier('transient'));

      const decision = policy.shouldRetry('ECONNREFUSED', 3, 3);

      expect(decision.shouldRetry).toBe(false);
      expect(decision.delayMs).toBe(0);
      expect(decision.reason).toBe('Max retries exceeded');
    });

    it('stops retrying when currentRetryCount exceeds maxRetries', () => {
      const policy = new RetryPolicy(mockClassifier('transient'));

      const decision = policy.shouldRetry('ECONNREFUSED', 10, 3);

      expect(decision.shouldRetry).toBe(false);
      expect(decision.delayMs).toBe(0);
      expect(decision.reason).toBe('Max retries exceeded');
    });

    it('allows retry when currentRetryCount is just below maxRetries', () => {
      const restore = seedRandom(0);
      const policy = new RetryPolicy(mockClassifier('transient'));

      const decision = policy.shouldRetry('ECONNREFUSED', 2, 3);

      expect(decision.shouldRetry).toBe(true);
      expect(decision.delayMs).toBeGreaterThan(0);

      restore();
    });

    it('max retry check takes precedence over error classification', () => {
      const classifier = mockClassifier('transient');
      const policy = new RetryPolicy(classifier);

      // Even though the error would normally be retried, max is hit first
      const decision = policy.shouldRetry('ECONNREFUSED', 5, 5);

      expect(decision.shouldRetry).toBe(false);
      // The classifier should not have been called at all
      expect(classifier.classify).not.toHaveBeenCalled();
    });
  });

  describe('error types — transient vs permanent', () => {
    it('does not retry permanent errors', () => {
      const policy = new RetryPolicy(mockClassifier('permanent'));

      const decision = policy.shouldRetry('authentication failed', 0, 3);

      expect(decision.shouldRetry).toBe(false);
      expect(decision.delayMs).toBe(0);
      expect(decision.reason).toBe('Permanent error');
    });

    it('does not retry timeout errors', () => {
      const policy = new RetryPolicy(mockClassifier('timeout'));

      const decision = policy.shouldRetry('request timed out', 0, 3);

      expect(decision.shouldRetry).toBe(false);
      expect(decision.delayMs).toBe(0);
      expect(decision.reason).toBe('Timeout error - not retryable');
    });

    it('retries transient errors', () => {
      const restore = seedRandom(0.5);
      const policy = new RetryPolicy(mockClassifier('transient'));

      const decision = policy.shouldRetry('ECONNRESET', 0, 3);

      expect(decision.shouldRetry).toBe(true);
      expect(decision.delayMs).toBeGreaterThan(0);

      restore();
    });

    it('retries resource errors', () => {
      const restore = seedRandom(0.5);
      const policy = new RetryPolicy(mockClassifier('resource'));

      const decision = policy.shouldRetry('quota exceeded', 0, 3);

      expect(decision.shouldRetry).toBe(true);
      expect(decision.delayMs).toBeGreaterThan(0);

      restore();
    });

    it('defaults to retry with transient-style backoff for unknown error types', () => {
      // The classifier returns a value not in the switch — simulate by
      // overriding classify to return an arbitrary string that TypeScript
      // allows at runtime.
      const classifier = {
        classify: vi.fn().mockReturnValue('unknown_type' as ErrorType),
      } as unknown as ErrorClassifier;
      const restore = seedRandom(0.5);
      const policy = new RetryPolicy(classifier);

      const decision = policy.shouldRetry('something weird', 0, 3);

      expect(decision.shouldRetry).toBe(true);
      // default branch uses base 5000 (same as transient)
      expect(decision.delayMs).toBe(3750);

      restore();
    });
  });

  describe('retry delay calculation', () => {
    it('caps delay at 60 seconds', () => {
      const restore = seedRandom(1); // max jitter factor = 0.5 + 1*0.5 = 1.0
      const policy = new RetryPolicy(mockClassifier('resource'));

      // resource base = 15000, retryCount = 10 => 15000 * 2^10 = 15_360_000
      // jitter = 15_360_000 * 1.0 = 15_360_000, capped at 60_000
      const decision = policy.shouldRetry('out of memory', 10, 20);

      expect(decision.shouldRetry).toBe(true);
      expect(decision.delayMs).toBe(60_000);

      restore();
    });

    it('applies jitter within expected range', () => {
      // With jitter factor = 0.5 + random * 0.5, range is [0.5, 1.0) of exponential
      const policy = new RetryPolicy(mockClassifier('transient'));
      const delays: number[] = [];

      // Collect multiple samples with different random seeds
      for (let r = 0; r < 10; r++) {
        const restore = seedRandom(r / 10);
        const d = policy.shouldRetry('ECONNREFUSED', 0, 3);
        delays.push(d.delayMs);
        restore();
      }

      // exponential = 5000 * 2^0 = 5000
      // jitter range: 5000 * 0.5 = 2500 to 5000 * 1.0 = 5000
      for (const delay of delays) {
        expect(delay).toBeGreaterThanOrEqual(2500);
        expect(delay).toBeLessThanOrEqual(5000);
      }
    });

    it('doubles base delay for each retry count (before jitter)', () => {
      const restore = seedRandom(0); // jitter factor = 0.5 exactly
      const policy = new RetryPolicy(mockClassifier('transient'));

      const delays = [0, 1, 2, 3, 4].map((n) =>
        policy.shouldRetry('ECONNREFUSED', n, 10).delayMs,
      );

      // factor = 0.5, base = 5000
      // n=0: 5000*1*0.5    = 2500
      // n=1: 5000*2*0.5    = 5000
      // n=2: 5000*4*0.5    = 10000
      // n=3: 5000*8*0.5    = 20000
      // n=4: 5000*16*0.5   = 40000
      expect(delays[0]).toBe(2500);
      expect(delays[1]).toBe(5000);
      expect(delays[2]).toBe(10000);
      expect(delays[3]).toBe(20000);
      expect(delays[4]).toBe(40000);

      restore();
    });
  });

  describe('edge cases', () => {
    it('handles empty error string', () => {
      const policy = new RetryPolicy(mockClassifier('transient'));

      const decision = policy.shouldRetry('', 0, 3);

      // Should still attempt retry — the classifier decides, not the policy
      expect(decision.shouldRetry).toBe(true);
    });

    it('handles zero maxRetries', () => {
      const classifier = mockClassifier('transient');
      const policy = new RetryPolicy(classifier);

      const decision = policy.shouldRetry('ECONNREFUSED', 0, 0);

      // currentRetryCount(0) >= maxRetries(0) → no retry
      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toBe('Max retries exceeded');
    });

    it('delegates to classifier for classification, not internal logic', () => {
      const classifier = mockClassifier('permanent');
      const policy = new RetryPolicy(classifier);

      policy.shouldRetry('some error message', 0, 3);

      expect(classifier.classify).toHaveBeenCalledWith('some error message');
    });

    it('calls classifier exactly once per shouldRetry invocation', () => {
      const classifier = mockClassifier('transient');
      const policy = new RetryPolicy(classifier);

      policy.shouldRetry('ECONNREFUSED', 0, 3);
      policy.shouldRetry('ECONNRESET', 1, 3);

      expect(classifier.classify).toHaveBeenCalledTimes(2);
    });
  });
});

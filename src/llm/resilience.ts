import { getLogger } from '../utils/logger.js';

const logger = getLogger('llm-resilience');

// === Retry Policy ===

export interface RetryConfig {
  maxRetries: number;
  streamMaxRetries?: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableStatuses: number[];
}

// === Circuit Breaker ===

interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeMs: number;
  halfOpenMaxAttempts: number;
}

const DEFAULT_CIRCUIT: CircuitBreakerConfig = {
  failureThreshold: 5,
  recoveryTimeMs: 30000,
  halfOpenMaxAttempts: 1,
};

type CircuitState = 'closed' | 'open' | 'half_open';

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CIRCUIT, ...config };
  }

  canAttempt(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.config.recoveryTimeMs) {
        this.state = 'half_open';
        this.halfOpenAttempts = 1;
        return true;
      }
      return false;
    }
    if (this.halfOpenAttempts < this.config.halfOpenMaxAttempts) {
      this.halfOpenAttempts++;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    if (this.state === 'half_open') {
      this.state = 'closed';
      this.failures = 0;
    }
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.state === 'half_open') {
      this.state = 'open';
      return;
    }
    if (this.failures >= this.config.failureThreshold) {
      this.state = 'open';
      logger.warn({ failures: this.failures }, 'LLM circuit breaker opened');
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.halfOpenAttempts = 0;
  }
}

// === Rate Limiter (Token Bucket) ===

interface RateLimiterConfig {
  requestsPerMinute: number;
}

const DEFAULT_RATE_LIMIT: RateLimiterConfig = {
  requestsPerMinute: 50,
};

export class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private lastRefill: number;
  private refillRate: number;

  constructor(config: Partial<RateLimiterConfig> = {}) {
    const rpm = config.requestsPerMinute ?? DEFAULT_RATE_LIMIT.requestsPerMinute;
    this.maxTokens = rpm;
    this.tokens = rpm;
    this.lastRefill = Date.now();
    this.refillRate = rpm / 60000;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens--;
      return;
    }
    const waitMs = (1 - this.tokens) / this.refillRate;
    await sleep(Math.ceil(waitMs));
    this.refill();
    this.tokens--;
  }

  updateLimit(rpm: number): void {
    this.maxTokens = rpm;
    this.refillRate = rpm / 60000;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// === Combined Config ===

export interface ConcurrencyConfig {
  maxConcurrent: number;
}

export interface ResilienceConfig {
  retry?: Partial<RetryConfig>;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  rateLimiter?: Partial<RateLimiterConfig>;
  concurrency?: Partial<ConcurrencyConfig>;
  defaultTimeoutMs?: number;
}

// === Concurrency Semaphore ===

const DEFAULT_CONCURRENCY: ConcurrencyConfig = {
  maxConcurrent: 10,
};

export class ConcurrencySemaphore {
  private running = 0;
  private queue: Array<() => void> = [];
  private readonly max: number;

  constructor(config: Partial<ConcurrencyConfig> = {}) {
    this.max = config.maxConcurrent ?? DEFAULT_CONCURRENCY.maxConcurrent;
  }

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  getRunning(): number { return this.running; }
  getQueueLength(): number { return this.queue.length; }
}

let sharedSemaphore: ConcurrencySemaphore | null = null;

export function getSharedSemaphore(config?: Partial<ConcurrencyConfig>): ConcurrencySemaphore {
  if (!sharedSemaphore) {
    sharedSemaphore = new ConcurrencySemaphore(config);
  }
  return sharedSemaphore;
}

export function resetSharedSemaphore(): void {
  sharedSemaphore = null;
}

// === Helpers ===

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

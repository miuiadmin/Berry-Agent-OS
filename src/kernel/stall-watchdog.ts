import { getLogger } from '../utils/logger.js';

const logger = getLogger('stall-watchdog');

export interface StallWatchdogOptions {
  label: string;
  timeoutMs: number;
  checkIntervalMs?: number;
  onStall: (meta: { label: string; idleMs: number; timeoutMs: number }) => void;
}

export interface StallWatchdog {
  touch(): void;
  stop(): void;
  isActive(): boolean;
}

export function createStallWatchdog(options: StallWatchdogOptions): StallWatchdog {
  const { label, timeoutMs, onStall } = options;
  const checkIntervalMs = options.checkIntervalMs ?? Math.min(5_000, Math.max(250, timeoutMs / 4));

  let lastActivityAt = Date.now();
  let stopped = false;
  let fired = false;

  const timer = setInterval(() => {
    if (stopped) return;
    const idleMs = Date.now() - lastActivityAt;
    if (idleMs >= timeoutMs && !fired) {
      fired = true;
      logger.warn({ label, idleMs, timeoutMs }, 'Stall detected');
      onStall({ label, idleMs, timeoutMs });
    }
  }, checkIntervalMs);

  timer.unref();

  return {
    touch() {
      lastActivityAt = Date.now();
      fired = false;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
    isActive() {
      return !stopped;
    },
  };
}

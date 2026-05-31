/**
 * 看护进程（Watchdog）配置接口
 *
 * 控制 CoreService 子进程的崩溃检测和自动重启策略。
 */

export interface WatchdogConfig {
  /** 首次重启前延迟，毫秒 */
  restartDelayMs: number;
  /** 指数退避倍数 */
  backoffMultiplier: number;
  /** 最大退避延迟，毫秒 */
  maxBackoffMs: number;
  /** 滚动时间窗口内的最大重启次数 */
  maxRestarts: number;
  /** 滚动窗口持续时间，毫秒 */
  restartWindowMs: number;
  /** 最低正常运行秒数；低于此视为崩溃 */
  minUptimeSeconds: number;
  /** 优雅停止超时，毫秒（SIGTERM → SIGKILL） */
  stopTimeoutMs: number;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  restartDelayMs: 1000,
  backoffMultiplier: 2,
  maxBackoffMs: 30_000,
  maxRestarts: 5,
  restartWindowMs: 600_000, // 10 minutes
  minUptimeSeconds: 10,
  stopTimeoutMs: 5_000,
};

export interface WatchdogState {
  pid: number;
  childPid: number | null;
  restartCount: number;
  lastRestartAt: string | null;
  startedAt: string;
}

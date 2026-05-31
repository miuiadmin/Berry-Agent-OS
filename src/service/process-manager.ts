/**
 * 子进程生命周期管理器
 *
 * 负责 spawn CoreService 子进程、熔断器检查、退避延迟计算和优雅停止。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WatchdogConfig } from './watchdog-config.js';

export interface ManagedChild {
  child: ChildProcess;
  startedAt: number;
}

export class ProcessManager {
  private config: WatchdogConfig;
  private current: ManagedChild | null = null;
  private restartTimestamps: number[] = [];
  private stopped = false;

  constructor(config: WatchdogConfig) {
    this.config = config;
  }

  /** 启动 CoreService 子进程 */
  start(env: NodeJS.ProcessEnv): ChildProcess {
    this.stopped = false;

    const thisFile = fileURLToPath(import.meta.url);
    const ext = thisFile.endsWith('.ts') ? '.ts' : '.js';
    const coreScript = resolve(dirname(thisFile), '..', 'kernel', `core-service${ext}`);

    const isTsx = ext === '.ts';
    const execPath = isTsx
      ? resolve(dirname(thisFile), '..', '..', 'node_modules', '.bin', 'tsx')
      : 'node';

    // stdio: ignore — CoreService 通过 Pino 自行写入 berry.log，不需要 stdio 转发
    const child = spawn(execPath, [coreScript], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env,
      detached: false,
    });

    this.current = { child, startedAt: Date.now() };
    return child;
  }

  /** 当前子进程信息 */
  getCurrent(): ManagedChild | null {
    return this.current;
  }

  /** 当前子进程 PID */
  getChildPid(): number | null {
    return this.current?.child.pid ?? null;
  }

  /** 判断子进程退出是否为崩溃（需要重启） */
  isCrash(code: number | null, signal: string | null): boolean {
    if (this.stopped) return false;
    if (signal === 'SIGTERM' || signal === 'SIGINT') return false;
    if (code === 0) return false;
    return true;
  }

  /** 熔断器检查：窗口内重启次数是否超限 */
  canRestart(): boolean {
    const windowStart = Date.now() - this.config.restartWindowMs;
    this.restartTimestamps = this.restartTimestamps.filter(t => t > windowStart);
    return this.restartTimestamps.length < this.config.maxRestarts;
  }

  /** 记录一次重启 */
  recordRestart(): void {
    this.restartTimestamps.push(Date.now());
  }

  /** 计算退避延迟（毫秒） */
  getBackoffDelay(): number {
    const count = this.restartTimestamps.length;
    const delay = this.config.restartDelayMs * Math.pow(this.config.backoffMultiplier, count);
    return Math.min(delay, this.config.maxBackoffMs);
  }

  /** 获取窗口内重启统计 */
  getRestartCount(): number {
    const windowStart = Date.now() - this.config.restartWindowMs;
    return this.restartTimestamps.filter(t => t > windowStart).length;
  }

  /** 清理已退出子进程的引用 */
  clearCurrent(): void {
    this.current = null;
  }

  /** 优雅停止子进程 */
  async stop(): Promise<void> {
    this.stopped = true;
    if (!this.current) return;

    const child = this.current.child;
    this.current = null;

    if (child.killed || child.exitCode !== null) return;

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!child.killed && child.exitCode === null) {
          child.kill('SIGKILL');
        }
        resolve();
      }, this.config.stopTimeoutMs);

      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });

      child.kill('SIGTERM');
    });
  }
}

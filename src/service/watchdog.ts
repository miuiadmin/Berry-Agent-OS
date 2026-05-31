/**
 * 看护进程（Watchdog）主循环
 *
 * 负责 spawn CoreService 子进程、监控退出、按策略重启。
 * 通过环境变量 __WATCHDOG_MODE=1 激活（由 CLI service start 设置）。
 */

import { writeFileSync, appendFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_WATCHDOG_CONFIG, type WatchdogConfig, type WatchdogState } from './watchdog-config.js';
import { ProcessManager } from './process-manager.js';
import { getWatchdogPidPath, getWatchdogStatePath, getLogDir, ensureDirs } from '../utils/paths.js';

export class Watchdog {
  private config: WatchdogConfig;
  private processManager: ProcessManager;
  private running = false;
  private stopping = false;
  private startedAt: string;

  constructor(config?: Partial<WatchdogConfig>) {
    this.config = { ...DEFAULT_WATCHDOG_CONFIG, ...config };
    this.processManager = new ProcessManager(this.config);
    this.startedAt = new Date().toISOString();
  }

  /** 进入看护进程主循环。阻塞直到停止。 */
  async run(env: NodeJS.ProcessEnv): Promise<void> {
    this.running = true;
    ensureDirs();

    // 写入看护进程 PID
    writeFileSync(getWatchdogPidPath(), String(process.pid));

    // 信号处理
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());

    log(`看护进程启动 (pid: ${process.pid})`);

    // 初始启动
    this.startChild(env);

    // 持续运行直到被停止
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!this.running) {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });
  }

  /** 启动 CoreService 子进程 */
  private startChild(env: NodeJS.ProcessEnv): void {
    this.processManager.clearCurrent();
    const child = this.processManager.start(env);

    log(`CoreService 子进程启动 (pid: ${child.pid})`);

    // 保存状态
    this.writeState({
      pid: process.pid,
      childPid: child.pid ?? null,
      restartCount: this.processManager.getRestartCount(),
      lastRestartAt: this.processManager.getRestartCount() > 0
        ? new Date().toISOString()
        : null,
      startedAt: this.startedAt,
    });

    child.on('exit', (code, signal) => {
      if (!this.running) return;
      this.handleChildExit(code, signal, env);
    });
  }

  /** 处理子进程退出 */
  private handleChildExit(
    code: number | null,
    signal: string | null,
    env: NodeJS.ProcessEnv,
  ): void {
    // 正常停止（由 shutdown 发起的 SIGTERM）
    if (this.stopping) {
      this.running = false;
      return;
    }

    // 子进程主动退出（code=0）
    if (code === 0 && signal === null) {
      log('CoreService 正常退出，看护进程退出');
      this.cleanup();
      this.running = false;
      return;
    }

    log(`CoreService 异常退出 (code: ${code}, signal: ${signal})`);

    // 熔断器检查
    if (!this.processManager.canRestart()) {
      log(`熔断器触发：${this.config.restartWindowMs / 1000}s 内已重启 ${this.config.maxRestarts} 次，停止重启`);
      this.cleanup();
      this.running = false;
      return;
    }

    // 退避重启
    this.processManager.recordRestart();
    const delay = this.processManager.getBackoffDelay();
    const count = this.processManager.getRestartCount();

    log(`${delay / 1000}s 后重启 (第 ${count} 次)`);

    setTimeout(() => {
      if (!this.running) return;
      this.startChild(env);
    }, delay);
  }

  /** 优雅关闭 */
  private async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    log('收到停止信号，正在关闭...');

    await this.processManager.stop();
    this.cleanup();
    this.running = false;
  }

  /** 清理 PID 和状态文件 */
  private cleanup(): void {
    try {
      const pidPath = getWatchdogPidPath();
      if (existsSync(pidPath)) unlinkSync(pidPath);
    } catch { /* ignore */ }
    try {
      const statePath = getWatchdogStatePath();
      if (existsSync(statePath)) unlinkSync(statePath);
    } catch { /* ignore */ }
  }

  /** 原子写入状态文件 */
  private writeState(state: WatchdogState): void {
    try {
      const tmpPath = getWatchdogStatePath() + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(state, null, 2));
      renameSync(tmpPath, getWatchdogStatePath());
    } catch {
      // 非关键路径，忽略写入失败
    }
  }
}

/** 写入看护进程独立日志文件（detached 进程 stderr 不可用） */
function log(message: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] [watchdog] ${message}\n`;
  try {
    ensureDirs();
    appendFileSync(resolve(getLogDir(), 'watchdog.log'), line);
  } catch {
    // 日志写入失败不影响主流程
  }
}

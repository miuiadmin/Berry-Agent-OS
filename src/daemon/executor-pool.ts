import { Executor, type ExecutionResult, type ProgressCallback } from './executor.js';
import type { RuntimeAdapter } from './adapters/types.js';
import type { DaemonTaskInput } from '../contracts/daemon-protocol.js';
import { createAdapter } from './adapters/registry.js';
import type { RuntimeInfo } from '../contracts/daemon-protocol.js';

export interface PoolTask {
  taskId: string;
  executionId: string;
  runtime: string;
  input: DaemonTaskInput;
  onProgress: ProgressCallback;
  resolve: (result: ExecutionResult) => void;
  reject: (error: Error) => void;
}

export class ExecutorPool {
  private maxSlots: number;
  private running = new Map<string, { executor: Executor; task: PoolTask }>();
  private runtimes: RuntimeInfo[];
  private taskTimeoutMs: number;

  constructor(maxSlots: number, runtimes: RuntimeInfo[], taskTimeoutMs: number) {
    this.maxSlots = maxSlots;
    this.runtimes = runtimes;
    this.taskTimeoutMs = taskTimeoutMs;
  }

  get availableSlots(): number {
    return Math.max(0, this.maxSlots - this.running.size);
  }

  get runningTaskIds(): string[] {
    return [...this.running.keys()];
  }

  get runningCount(): number {
    return this.running.size;
  }

  canAccept(): boolean {
    return this.running.size < this.maxSlots;
  }

  async execute(task: PoolTask): Promise<void> {
    if (!this.canAccept()) {
      task.reject(new Error('No available execution slots'));
      return;
    }

    const runtimeInfo = this.runtimes.find(r => r.name === task.runtime);
    if (!runtimeInfo) {
      task.reject(new Error(`Runtime not available: ${task.runtime}`));
      return;
    }

    let adapter: RuntimeAdapter;
    try {
      adapter = createAdapter(task.runtime, runtimeInfo.command);
    } catch (err) {
      task.reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const executor = new Executor(adapter);
    this.running.set(task.taskId, { executor, task });

    try {
      const result = await executor.execute(
        task.input,
        task.onProgress,
        task.input.timeoutMs ?? this.taskTimeoutMs,
      );
      task.resolve(result);
    } catch (err) {
      task.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.running.delete(task.taskId);
    }
  }

  cancelTask(taskId: string): boolean {
    const entry = this.running.get(taskId);
    if (!entry) return false;
    entry.executor.cancel('cancelled by core');
    return true;
  }

  cancelAll(): void {
    for (const [, entry] of this.running) {
      entry.executor.cancel('daemon shutdown');
    }
  }

  getPid(taskId: string): number | undefined {
    return this.running.get(taskId)?.executor.pid;
  }
}

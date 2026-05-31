import { randomUUID } from 'node:crypto';
import { SocketClient } from './socket-client.js';
import { ExecutorPool, type PoolTask } from './executor-pool.js';
import { discoverRuntimes } from './runtime-discovery.js';
import { getLogger } from '../utils/logger.js';
import type { DaemonConfig } from './config.js';
import type {
  DaemonRegisterMessage,
  DaemonHeartbeatMessage,
  DaemonTaskNotifyMessage,
  DaemonTaskClaimMessage,
  DaemonTaskClaimAckMessage,
  DaemonTaskStartedMessage,
  DaemonTaskProgressMessage,
  DaemonTaskResultMessage,
  DaemonDisconnectMessage,
  DaemonTaskCancelMessage,
  RuntimeInfo,
} from '../contracts/daemon-protocol.js';
import type { NormalizedExternalEvent } from '../contracts/daemon-events.js';
import type { ExecutionResult } from './executor.js';

export class DaemonProcess {
  private config: DaemonConfig;
  private socketPath: string;
  private client: SocketClient;
  private pool: ExecutorPool | null = null;
  private daemonId: string;
  private runtimes: RuntimeInfo[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();
  private stopped = false;

  constructor(config: DaemonConfig, socketPath: string) {
    this.config = config;
    this.socketPath = socketPath;
    this.daemonId = `daemon-${randomUUID().slice(0, 8)}`;
    this.client = new SocketClient({
      socketPath,
      reconnectIntervalMs: 1000,
      maxReconnectMs: 30_000,
    });
  }

  async start(): Promise<void> {
    this.runtimes = await discoverRuntimes(this.config.runtimes);
    if (this.runtimes.length === 0) {
      throw new Error('No external agent runtimes discovered');
    }

    this.pool = new ExecutorPool(this.config.maxSlots, this.runtimes, this.config.taskTimeoutMs);

    this.client.on('connected', () => this.onConnected());
    this.client.on('disconnected', () => this.onDisconnected());
    this.client.on('message', (msg: Record<string, unknown>) => this.onMessage(msg));

    this.client.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.pool?.cancelAll();

    const disconnect: DaemonDisconnectMessage = {
      type: 'daemon.disconnect',
      daemonId: this.daemonId,
      reason: 'shutdown',
    };
    this.client.send(disconnect);

    const waitForDrain = new Promise<void>(resolve => {
      const check = () => {
        if (!this.pool || this.pool.runningCount === 0) { resolve(); return; }
        setTimeout(check, 200);
      };
      check();
    });
    const timeout = new Promise<void>(resolve => setTimeout(resolve, 6000));
    await Promise.race([waitForDrain, timeout]);

    this.client.destroy();
  }

  private onConnected(): void {
    const register: DaemonRegisterMessage = {
      type: 'daemon.register',
      daemonId: this.daemonId,
      pid: process.pid,
      runtimes: this.runtimes,
      maxSlots: this.config.maxSlots,
      availableSlots: this.pool?.availableSlots ?? 0,
    };
    this.client.send(register);

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.config.heartbeatIntervalMs);
  }

  private onDisconnected(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;

    switch (type) {
      case 'daemon.register_ack':
        break;
      case 'daemon.heartbeat_ack':
        break;
      case 'daemon.task.notify':
        if (typeof msg.taskId !== 'string' || !msg.inputPayload) {
          getLogger('daemon').warn('Invalid task.notify: missing taskId or inputPayload');
          return;
        }
        this.handleTaskNotify(msg as unknown as DaemonTaskNotifyMessage);
        break;
      case 'daemon.task.claim_ack':
        if (typeof msg.taskId !== 'string' || typeof msg.ok !== 'boolean') {
          return;
        }
        this.handleClaimAck(msg as unknown as DaemonTaskClaimAckMessage);
        break;
      case 'daemon.task.cancel':
        if (typeof msg.taskId !== 'string') return;
        this.handleTaskCancel(msg as unknown as DaemonTaskCancelMessage);
        break;
      default:
        getLogger('daemon').warn({ type }, 'Unknown message type');
    }
  }

  private handleTaskNotify(msg: DaemonTaskNotifyMessage): void {
    if (this.stopped || !this.pool?.canAccept()) return;

    const runtime = this.resolveRuntime(msg.preferredRuntime, msg.taskType);
    if (!runtime) {
      this.reportError(msg.taskId, 'none', 'unknown', new Error(
        msg.preferredRuntime
          ? `Preferred runtime '${msg.preferredRuntime}' not available`
          : 'No suitable runtime available',
      ));
      return;
    }

    const executionId = randomUUID();

    const claim: DaemonTaskClaimMessage = {
      type: 'daemon.task.claim',
      taskId: msg.taskId,
      runtime,
      executionId,
    };
    this.client.send(claim);

    const task: PoolTask = {
      taskId: msg.taskId,
      executionId,
      runtime,
      input: msg.inputPayload,
      onProgress: (event: NormalizedExternalEvent) => this.reportProgress(msg.taskId, executionId, event),
      resolve: (result: ExecutionResult) => this.reportResult(msg.taskId, executionId, runtime, result),
      reject: (error: Error) => this.reportError(msg.taskId, executionId, runtime, error),
    };

    const started: DaemonTaskStartedMessage = {
      type: 'daemon.task.started',
      taskId: msg.taskId,
      executionId,
      runtime,
      pid: process.pid,
    };
    this.client.send(started);

    this.pool.execute(task).catch(() => {
      // Errors already reported via task.reject → reportError
    });
  }

  private handleClaimAck(msg: DaemonTaskClaimAckMessage): void {
    if (!msg.ok) {
      this.pool?.cancelTask(msg.taskId);
    }
  }

  private handleTaskCancel(msg: DaemonTaskCancelMessage): void {
    this.pool?.cancelTask(msg.taskId);
  }

  private reportProgress(taskId: string, executionId: string, event: NormalizedExternalEvent): void {
    const progress: DaemonTaskProgressMessage = {
      type: 'daemon.task.progress',
      taskId,
      executionId,
      event,
    };
    this.client.send(progress);
  }

  private reportResult(taskId: string, executionId: string, runtime: string, result: ExecutionResult): void {
    const msg: DaemonTaskResultMessage = {
      type: 'daemon.task.result',
      taskId,
      executionId,
      runtime,
      ok: result.ok,
      output: result.output,
      error: result.error,
      sessionId: result.sessionId,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
      },
      durationMs: result.durationMs,
      toolCallCount: result.toolCallCount,
    };
    this.client.send(msg);
  }

  private reportError(taskId: string, executionId: string, runtime: string, error: Error): void {
    const msg: DaemonTaskResultMessage = {
      type: 'daemon.task.result',
      taskId,
      executionId,
      runtime,
      ok: false,
      error: error.message,
      durationMs: 0,
      toolCallCount: 0,
    };
    this.client.send(msg);
  }

  private sendHeartbeat(): void {
    const heartbeat: DaemonHeartbeatMessage = {
      type: 'daemon.heartbeat',
      daemonId: this.daemonId,
      availableSlots: this.pool?.availableSlots ?? 0,
      runningTasks: this.pool?.runningTaskIds ?? [],
      uptimeMs: Date.now() - this.startTime,
    };
    this.client.send(heartbeat);
  }

  private resolveRuntime(preferredRuntime: string | undefined, _taskType: string): string | null {
    if (preferredRuntime) {
      const found = this.runtimes.find(r => r.name === preferredRuntime);
      return found ? found.name : null;
    }
    if (this.runtimes.length === 0) return null;
    return this.runtimes[0].name;
  }
}

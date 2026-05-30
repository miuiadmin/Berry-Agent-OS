import type { Socket } from 'node:net';
import type { EventBus } from './event-bus.js';
import type { TaskManager } from './task-manager.js';
import type {
  DaemonRegisterMessage,
  DaemonHeartbeatMessage,
  DaemonTaskClaimMessage,
  DaemonTaskStartedMessage,
  DaemonTaskProgressMessage,
  DaemonTaskResultMessage,
  DaemonDisconnectMessage,
  DaemonTaskNotifyMessage,
  DaemonTaskCancelMessage,
  DaemonTaskCorrectionMessage,
  DaemonHeartbeatAckMessage,
  DaemonRegisterAckMessage,
  DaemonTaskClaimAckMessage,
  RuntimeInfo,
  DaemonTaskInput,
} from '../contracts/daemon-protocol.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('daemon-bridge');

export interface DaemonState {
  daemonId: string;
  pid: number;
  socket: Socket;
  runtimes: RuntimeInfo[];
  maxSlots: number;
  availableSlots: number;
  runningTasks: Set<string>;
  lastHeartbeat: number;
  connectedAt: number;
}

export interface DaemonBridgeConfig {
  heartbeatTimeoutMs: number;
  taskTimeoutMs: number;
}

export class DaemonBridge {
  private daemon: DaemonState | null = null;
  private eventBus: EventBus;
  private taskManager: TaskManager;
  private config: DaemonBridgeConfig;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private pendingClaims = new Map<string, { resolve: (ok: boolean) => void }>();
  private dispatchedTasks = new Set<string>();

  constructor(eventBus: EventBus, taskManager: TaskManager, config: DaemonBridgeConfig) {
    this.eventBus = eventBus;
    this.taskManager = taskManager;
    this.config = config;
  }

  get isAvailable(): boolean {
    return this.daemon !== null;
  }

  get runtimes(): RuntimeInfo[] {
    return this.daemon?.runtimes ?? [];
  }

  get availableSlots(): number {
    return this.daemon?.availableSlots ?? 0;
  }

  handleRegister(msg: DaemonRegisterMessage, socket: Socket): void {
    if (this.daemon) {
      logger.warn({ existingId: this.daemon.daemonId, newId: msg.daemonId }, 'Replacing existing daemon connection');
      this.cleanup('replaced by new daemon');
    }

    this.daemon = {
      daemonId: msg.daemonId,
      pid: msg.pid,
      socket,
      runtimes: msg.runtimes,
      maxSlots: msg.maxSlots,
      availableSlots: msg.availableSlots,
      runningTasks: new Set(),
      lastHeartbeat: Date.now(),
      connectedAt: Date.now(),
    };

    socket.on('close', () => {
      if (this.daemon?.socket === socket) {
        this.cleanup('socket closed');
      }
    });

    this.startHealthCheck();
    this.sendToDaemon<DaemonRegisterAckMessage>({ type: 'daemon.register_ack', ok: true });

    logger.info({ daemonId: msg.daemonId, runtimes: msg.runtimes.map(r => r.name) }, 'Daemon registered');
    this.eventBus.emit('daemon.connected', { daemonId: msg.daemonId, runtimes: msg.runtimes });
  }

  handleHeartbeat(msg: DaemonHeartbeatMessage): void {
    if (!this.daemon || this.daemon.daemonId !== msg.daemonId) return;

    this.daemon.lastHeartbeat = Date.now();
    this.daemon.availableSlots = msg.availableSlots;
    this.daemon.runningTasks = new Set(msg.runningTasks);

    this.sendToDaemon<DaemonHeartbeatAckMessage>({ type: 'daemon.heartbeat_ack', ok: true });
  }

  handleTaskClaim(msg: DaemonTaskClaimMessage): void {
    if (!this.daemon) return;

    this.daemon.runningTasks.add(msg.taskId);
    this.taskManager.acknowledge(msg.taskId);

    this.sendToDaemon<DaemonTaskClaimAckMessage>({
      type: 'daemon.task.claim_ack',
      taskId: msg.taskId,
      ok: true,
    });

    const pending = this.pendingClaims.get(msg.taskId);
    if (pending) {
      pending.resolve(true);
      this.pendingClaims.delete(msg.taskId);
    }
  }

  handleTaskStarted(msg: DaemonTaskStartedMessage): void {
    this.taskManager.start(msg.taskId);
    this.taskManager.resetTimeout(msg.taskId, this.config.taskTimeoutMs);
  }

  handleTaskProgress(msg: DaemonTaskProgressMessage): void {
    this.eventBus.emit('daemon.task.progress', {
      taskId: msg.taskId,
      event: msg.event,
    });
  }

  handleTaskResult(msg: DaemonTaskResultMessage): void {
    if (!this.daemon) return;

    this.daemon.runningTasks.delete(msg.taskId);
    this.dispatchedTasks.delete(msg.taskId);

    if (msg.ok) {
      this.taskManager.complete(msg.taskId, {
        output: msg.output,
        sessionId: msg.sessionId,
        usage: msg.usage,
        durationMs: msg.durationMs,
        toolCallCount: msg.toolCallCount,
      });
      this.eventBus.emit('daemon.task.completed', {
        taskId: msg.taskId,
        runtime: msg.runtime,
        durationMs: msg.durationMs,
      });
    } else {
      this.taskManager.fail(msg.taskId, msg.error ?? 'Unknown daemon error');
      this.eventBus.emit('daemon.task.failed', {
        taskId: msg.taskId,
        runtime: msg.runtime,
        error: msg.error ?? 'Unknown error',
      });
    }
  }

  handleDisconnect(msg: DaemonDisconnectMessage): void {
    if (this.daemon?.daemonId === msg.daemonId) {
      this.cleanup(msg.reason);
    }
  }

  async dispatch(taskId: string, input: DaemonTaskInput, preferredRuntime?: string): Promise<boolean> {
    if (!this.daemon) {
      logger.warn({ taskId }, 'Cannot dispatch: no daemon connected');
      return false;
    }

    const notify: DaemonTaskNotifyMessage = {
      type: 'daemon.task.notify',
      taskId,
      taskType: 'external_code_task',
      priority: 1,
      preferredRuntime,
      inputPayload: input,
    };

    this.sendToDaemon(notify);
    this.dispatchedTasks.add(taskId);
    this.taskManager.dispatch(taskId);
    return true;
  }

  cancelTask(taskId: string, reason?: string): void {
    if (!this.daemon) return;

    const cancel: DaemonTaskCancelMessage = {
      type: 'daemon.task.cancel',
      taskId,
      reason,
    };
    this.sendToDaemon(cancel);
  }

  deliverCorrection(taskId: string, action: 'adjust' | 'stop', instruction?: string, newConstraints?: DaemonTaskCorrectionMessage['newConstraints']): void {
    if (!this.daemon) return;

    const msg: DaemonTaskCorrectionMessage = {
      type: 'daemon.task.correction',
      taskId,
      action,
      instruction,
      newConstraints,
    };
    this.sendToDaemon(msg);
  }

  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    this.daemon = null;
  }

  private sendToDaemon<T extends object>(msg: T): boolean {
    if (!this.daemon || this.daemon.socket.destroyed) return false;
    return this.daemon.socket.write(JSON.stringify(msg) + '\n');
  }

  private startHealthCheck(): void {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);

    this.healthCheckTimer = setInterval(() => {
      if (!this.daemon) return;

      const elapsed = Date.now() - this.daemon.lastHeartbeat;
      if (elapsed > this.config.heartbeatTimeoutMs) {
        logger.warn({ daemonId: this.daemon.daemonId, elapsed }, 'Daemon heartbeat timeout');
        this.cleanup('heartbeat timeout');
      }
    }, this.config.heartbeatTimeoutMs / 2);
  }

  private cleanup(reason: string): void {
    if (!this.daemon) return;

    const daemonId = this.daemon.daemonId;
    logger.info({ daemonId, reason }, 'Daemon disconnected');

    const tasksToFail = new Set([...this.daemon.runningTasks, ...this.dispatchedTasks]);
    for (const taskId of tasksToFail) {
      this.taskManager.fail(taskId, `Daemon disconnected: ${reason}`);
      this.eventBus.emit('daemon.task.failed', {
        taskId,
        runtime: 'unknown',
        error: `Daemon disconnected: ${reason}`,
      });
    }
    this.dispatchedTasks.clear();

    for (const [, pending] of this.pendingClaims) {
      pending.resolve(false);
    }
    this.pendingClaims.clear();

    this.daemon = null;

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    this.eventBus.emit('daemon.disconnected', { daemonId, reason });
  }
}

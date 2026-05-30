import type { AgentName } from '../contracts/agents.js';
import type { TaskManager } from './task-manager.js';
import { EventBus } from './event-bus.js';
import { getLogger } from '../utils/logger.js';
import { metrics } from '../observability/metrics.js';

const logger = getLogger('task-scheduler');

export interface TaskSchedulerConfig {
  maxConcurrencyPerAgent: number;
  starvationBoostIntervalMs: number;
  starvationBoostAmount: number;
}

const DEFAULT_CONFIG: TaskSchedulerConfig = {
  maxConcurrencyPerAgent: 3,
  starvationBoostIntervalMs: 10000,
  starvationBoostAmount: 1,
};

export interface QueuedTask {
  taskId: string;
  targetAgent: AgentName;
  basePriority: number;
  enqueuedAt: number;
}

export class TaskScheduler {
  private queues = new Map<AgentName, QueuedTask[]>();
  private activeCounts = new Map<AgentName, number>();
  private config: TaskSchedulerConfig;
  private boostTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private taskManager: TaskManager,
    private eventBus: EventBus,
    config: Partial<TaskSchedulerConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.listenForCompletions();
    this.startStarvationBoost();
  }

  enqueue(taskId: string, targetAgent: AgentName, priority: number): void {
    const item: QueuedTask = {
      taskId,
      targetAgent,
      basePriority: priority,
      enqueuedAt: Date.now(),
    };

    if (!this.queues.has(targetAgent)) {
      this.queues.set(targetAgent, []);
    }
    this.queues.get(targetAgent)!.push(item);
    this.sortQueue(targetAgent);

    metrics.counter('task_scheduler_enqueued_total').inc({ agent: targetAgent });
    logger.debug({ taskId, targetAgent, priority }, 'Task enqueued');

    this.tick(targetAgent);
  }

  private tick(agent: AgentName): void {
    const queue = this.queues.get(agent);
    if (!queue || queue.length === 0) return;

    const active = this.activeCounts.get(agent) ?? 0;
    if (active >= this.config.maxConcurrencyPerAgent) return;

    const item = queue.shift()!;
    this.activeCounts.set(agent, active + 1);

    const waitMs = Date.now() - item.enqueuedAt;
    metrics.histogram('task_queue_wait_ms').observe(waitMs, { agent });
    metrics.counter('task_scheduler_dispatched_total').inc({ agent });

    try {
      this.taskManager.dispatch(item.taskId);
    } catch (err) {
      this.activeCounts.set(agent, Math.max(0, (this.activeCounts.get(agent) ?? 1) - 1));
      logger.warn({ taskId: item.taskId, error: (err as Error).message }, 'Dispatch failed');
    }
  }

  onTaskComplete(taskId: string, agent: AgentName): void {
    const count = Math.max(0, (this.activeCounts.get(agent) ?? 1) - 1);
    this.activeCounts.set(agent, count);
    this.tick(agent);
  }

  getEffectivePriority(item: QueuedTask): number {
    const waitMs = Date.now() - item.enqueuedAt;
    const boosts = Math.floor(waitMs / this.config.starvationBoostIntervalMs);
    return item.basePriority + boosts * this.config.starvationBoostAmount;
  }

  private sortQueue(agent: AgentName): void {
    const queue = this.queues.get(agent);
    if (!queue) return;
    queue.sort((a, b) => {
      const pa = this.getEffectivePriority(a);
      const pb = this.getEffectivePriority(b);
      if (pb !== pa) return pb - pa;
      return a.enqueuedAt - b.enqueuedAt;
    });
  }

  private startStarvationBoost(): void {
    this.boostTimer = setInterval(() => {
      for (const agent of this.queues.keys()) {
        this.sortQueue(agent);
        this.tick(agent);
      }
    }, this.config.starvationBoostIntervalMs);
  }

  private listenForCompletions(): void {
    this.eventBus.on('task.completed', ({ taskId, targetAgent }) => {
      this.onTaskComplete(taskId, targetAgent);
    });
    this.eventBus.on('task.failed', ({ taskId, targetAgent }) => {
      this.onTaskComplete(taskId, targetAgent);
    });
    this.eventBus.on('task.timeout', ({ taskId, targetAgent }) => {
      this.onTaskComplete(taskId, targetAgent);
    });
    this.eventBus.on('task.cancelled', ({ taskId }) => {
      for (const [agent, queue] of this.queues) {
        const idx = queue.findIndex(q => q.taskId === taskId);
        if (idx >= 0) {
          queue.splice(idx, 1);
          this.tick(agent);
          return;
        }
      }
      for (const [agent, count] of this.activeCounts) {
        const task = this.taskManager.getTask(taskId);
        if (task && task.target_agent === agent) {
          this.activeCounts.set(agent, Math.max(0, count - 1));
          this.tick(agent);
          return;
        }
      }
    });
  }

  getQueueLength(agent: AgentName): number {
    return this.queues.get(agent)?.length ?? 0;
  }

  getActiveCount(agent: AgentName): number {
    return this.activeCounts.get(agent) ?? 0;
  }

  dispose(): void {
    if (this.boostTimer) {
      clearInterval(this.boostTimer);
      this.boostTimer = null;
    }
    this.queues.clear();
    this.activeCounts.clear();
  }
}

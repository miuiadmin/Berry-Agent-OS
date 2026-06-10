/**
 * 13.0 §13.10: 长时间任务进度心跳管理器。
 *
 * 解决的问题：
 *   - 长时间任务（>5min）没有 tool_call 输出时，前端看不到「还在工作」的信号
 *   - 任务卡住时无法及时发现
 *
 * 工作机制：
 *   - 每 30s 扫描活跃 delegation
 *   - 如果任务的 lastTelemetryAt > 心跳间隔，发 task.heartbeat 事件
 *   - 心跳带 elapsedMs（任务总运行时长）+ lastActivity（最近事件类型）
 *   - 任务完成时自动从追踪中移除
 *
 * 性能：
 *   - 单次扫描 O(N) N=活跃 delegation 数（通常 < 20）
 *   - 总开销 < 1ms/30s
 */

import type { EventBus } from './event-bus.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('task-heartbeat');

export interface HeartbeatEntry {
  delegationId: string;
  taskId: string;
  agentName: string;
  startedAt: number;
  lastActivityAt: number;
  lastActivityType: string;
}

export interface HeartbeatConfig {
  /** 心跳扫描间隔（ms） */
  intervalMs: number;
  /** 无活动超过此值才发心跳（ms） */
  thresholdMs: number;
}

const DEFAULT_CONFIG: HeartbeatConfig = {
  intervalMs: 30_000,
  thresholdMs: 60_000, // 1 分钟无活动触发
};

/** DelegationEntry 的最小子集（避免循环依赖） */
export interface HeartbeatSource {
  getActiveDelegations(): HeartbeatEntry[];
  markHeartbeat(delegationId: string): void;
}

export class TaskHeartbeatManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: HeartbeatConfig;
  private source: HeartbeatSource | null = null;

  constructor(
    private readonly eventBus: EventBus,
    config: Partial<HeartbeatConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 注入 delegation 数据源（启动后绑定避免循环依赖） */
  setSource(source: HeartbeatSource): void {
    this.source = source;
  }

  /** 启动心跳扫描 */
  start(): void {
    if (this.timer) return;
    logger.info({ intervalMs: this.config.intervalMs, thresholdMs: this.config.thresholdMs }, 'task-heartbeat: started');
    this.timer = setInterval(() => this.tick(), this.config.intervalMs);
  }

  /** 停止心跳扫描 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('task-heartbeat: stopped');
    }
  }

  /** 单次扫描（测试用） */
  tick(): void {
    if (!this.source) return;

    const now = Date.now();
    const active = this.source.getActiveDelegations();
    for (const entry of active) {
      const elapsed = now - entry.startedAt;
      const sinceLast = now - entry.lastActivityAt;

      // 只在「无活动超过阈值」时发心跳（避免和正常 tool_call progress 重复）
      if (sinceLast < this.config.thresholdMs) continue;

      this.eventBus.emit('task.heartbeat', {
        taskId: entry.taskId,
        agentName: entry.agentName,
        elapsedMs: elapsed,
        lastActivity: entry.lastActivityType,
        timestamp: now,
      });

      this.source.markHeartbeat(entry.delegationId);
      logger.debug({
        taskId: entry.taskId,
        delegationId: entry.delegationId,
        elapsedMs: elapsed,
        sinceLastMs: sinceLast,
      }, 'task-heartbeat: emitted');
    }
  }
}

/** 全局单例 */
let globalManager: TaskHeartbeatManager | null = null;

export function getTaskHeartbeatManager(eventBus: EventBus): TaskHeartbeatManager {
  if (!globalManager) {
    globalManager = new TaskHeartbeatManager(eventBus);
  }
  return globalManager;
}

export function resetTaskHeartbeatManager(): void {
  globalManager = null;
}
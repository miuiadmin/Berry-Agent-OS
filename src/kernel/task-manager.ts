import type { Database } from 'better-sqlite3';
import type { AgentName, TaskType, TaskStatus, TaskEventType } from '../contracts/agents.js';
import { EventBus } from './event-bus.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import { metrics } from '../observability/metrics.js';
import { getCurrentTrace } from '../observability/trace-context.js';

const logger = getLogger('task-manager');

export interface CreateTaskInput {
  sessionId: string;
  correlationId: string;
  taskType: TaskType;
  requester: string;
  targetAgent: AgentName;
  foreground?: boolean;
  priority?: number;
  inputPayload: Record<string, unknown>;
  runId?: string;
}

export interface TaskRow {
  id: string;
  run_id: string | null;
  session_id: string;
  correlation_id: string;
  task_type: TaskType;
  requester: string;
  target_agent: AgentName;
  foreground: number;
  priority: number;
  input_payload: string;
  output_payload: string | null;
  status: TaskStatus;
  error: string | null;
  created_at: number;
  dispatched_at: number | null;
  acknowledged_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  requeue_count: number;
  resume_count: number;
  error_type: string | null;
}

export interface TaskManagerConfig {
  defaultTimeoutMs: number;
}

const DEFAULT_CONFIG: TaskManagerConfig = {
  defaultTimeoutMs: 120_000,
};

/** Exposed for checkpoint-service DB access */
export interface TaskManagerDb {
  readonly db: Database;
}

export class TaskManager implements TaskManagerDb {
  readonly db: Database;
  private eventBus: EventBus;
  private config: TaskManagerConfig;
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private abortControllers = new Map<string, AbortController>();

  constructor(db: Database, eventBus: EventBus, config?: Partial<TaskManagerConfig>) {
    this.db = db;
    this.eventBus = eventBus;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  create(input: CreateTaskInput): string {
    const id = genId('tsk');
    const now = Date.now();
    const traceId = getCurrentTrace()?.traceId ?? null;

    this.db.prepare(`
      INSERT INTO agent_tasks (
        id, run_id, session_id, correlation_id, task_type,
        requester, target_agent, foreground, priority,
        input_payload, status, created_at, trace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)
    `).run(
      id,
      input.runId ?? null,
      input.sessionId,
      input.correlationId,
      input.taskType,
      input.requester,
      input.targetAgent,
      input.foreground ? 1 : 0,
      input.priority ?? 0,
      JSON.stringify(input.inputPayload),
      now,
      traceId,
    );

    this.writeEvent(id, input.sessionId, input.requester, 'created', 'info', '任务已创建');
    this.eventBus.emit('task.created', { taskId: id, taskType: input.taskType, targetAgent: input.targetAgent });
    metrics.counter('task_lifecycle_total').inc({ task_type: input.taskType, status: 'created' });

    logger.debug({ taskId: id, type: input.taskType, target: input.targetAgent }, '任务已创建');
    return id;
  }

  dispatch(taskId: string): void {
    const now = Date.now();
    const task = this.getTask(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status !== 'created') {
      throw new Error(`任务状态不允许派发: ${task.status}`);
    }

    this.db.prepare(`
      UPDATE agent_tasks SET status = 'dispatched', dispatched_at = ? WHERE id = ?
    `).run(now, taskId);

    const controller = new AbortController();
    this.abortControllers.set(taskId, controller);

    this.writeEvent(taskId, task.session_id, 'core', 'dispatched', 'info', `已派发至 ${task.target_agent}`);
    this.eventBus.emit('task.dispatched', { taskId, targetAgent: task.target_agent });
    this.startTimeout(taskId);
  }

  getSignal(taskId: string): AbortSignal | undefined {
    return this.abortControllers.get(taskId)?.signal;
  }

  acknowledge(taskId: string): void {
    const now = Date.now();
    const task = this.getTask(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status !== 'dispatched') {
      throw new Error(`任务状态不允许确认: ${task.status}`);
    }

    this.db.prepare(`
      UPDATE agent_tasks SET status = 'acknowledged', acknowledged_at = ? WHERE id = ?
    `).run(now, taskId);

    this.writeEvent(taskId, task.session_id, task.target_agent, 'acknowledged', 'info', '已确认接收');
    this.eventBus.emit('task.acknowledged', { taskId, targetAgent: task.target_agent });
  }

  start(taskId: string): void {
    const now = Date.now();
    const task = this.getTask(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status !== 'acknowledged' && task.status !== 'dispatched') {
      throw new Error(`任务状态不允许启动: ${task.status}`);
    }

    this.db.prepare(`
      UPDATE agent_tasks SET status = 'running', started_at = ? WHERE id = ?
    `).run(now, taskId);

    this.writeEvent(taskId, task.session_id, task.target_agent, 'started', 'info', '开始执行');
    this.eventBus.emit('task.started', { taskId, targetAgent: task.target_agent });
  }

  complete(taskId: string, outputPayload: Record<string, unknown>): boolean {
    const now = Date.now();
    const task = this.getTask(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'timeout' || task.status === 'cancelled') {
      logger.debug({ taskId, status: task.status }, '任务已终结，忽略 complete');
      return false;
    }

    this.clearTimeout(taskId);
    this.abortControllers.delete(taskId);
    const result = this.db.prepare(`
      UPDATE agent_tasks SET status = 'completed', output_payload = ?, finished_at = ?, version = version + 1
      WHERE id = ? AND status NOT IN ('completed','failed','timeout','cancelled')
    `).run(JSON.stringify(outputPayload), now, taskId);

    if (result.changes === 0) {
      logger.debug({ taskId }, 'Concurrent modification detected on complete');
      return false;
    }

    this.writeEvent(taskId, task.session_id, task.target_agent, 'completed', 'info', '执行完成');
    this.eventBus.emit('task.completed', { taskId, targetAgent: task.target_agent, outputPayload });
    metrics.counter('task_lifecycle_total').inc({ task_type: task.task_type, status: 'completed' });
    if (task.started_at) {
      metrics.histogram('task_execution_ms').observe(now - task.started_at, { task_type: task.task_type, agent: task.target_agent });
    }
    logger.debug({ taskId }, '任务完成');
    return true;
  }

  fail(taskId: string, error: string): boolean {
    const now = Date.now();
    const task = this.getTask(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'timeout' || task.status === 'cancelled') {
      logger.debug({ taskId, status: task.status }, '任务已终结，忽略 fail');
      return false;
    }

    this.clearTimeout(taskId);
    this.abortControllers.delete(taskId);
    const result = this.db.prepare(`
      UPDATE agent_tasks SET status = 'failed', error = ?, finished_at = ?, version = version + 1
      WHERE id = ? AND status NOT IN ('completed','failed','timeout','cancelled')
    `).run(error, now, taskId);

    if (result.changes === 0) {
      logger.debug({ taskId }, 'Concurrent modification detected on fail');
      return false;
    }

    this.writeEvent(taskId, task.session_id, task.target_agent, 'failed', 'error', error);
    this.eventBus.emit('task.failed', { taskId, targetAgent: task.target_agent, error });
    metrics.counter('task_lifecycle_total').inc({ task_type: task.task_type, status: 'failed' });
    logger.warn({ taskId, error }, '任务失败');
    return true;
  }

  cancel(taskId: string, reason?: string): void {
    const now = Date.now();
    const task = this.getTask(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return;
    }

    this.clearTimeout(taskId);
    this.abortTask(taskId);
    const result = this.db.prepare(`
      UPDATE agent_tasks SET status = 'cancelled', error = ?, finished_at = ?, version = version + 1
      WHERE id = ? AND status NOT IN ('completed','failed','cancelled')
    `).run(reason ?? '已取消', now, taskId);

    if (result.changes === 0) return;

    this.writeEvent(taskId, task.session_id, 'core', 'cancelled', 'warn', reason ?? '已取消');
    this.eventBus.emit('task.cancelled', { taskId, reason });
  }

  forceUpdate(taskId: string, status: TaskStatus, reason: string): void {
    const now = Date.now();
    this.clearTimeout(taskId);
    this.abortTask(taskId);
    this.db.prepare(
      'UPDATE agent_tasks SET status = ?, error = ?, finished_at = ?, version = version + 1 WHERE id = ?',
    ).run(status, reason, now, taskId);
    this.eventBus.emit('task.force_updated', { taskId, status, reason });
    logger.info({ taskId, status, reason }, 'Task force-updated by user');
  }

  getTask(taskId: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
  }

  getTasksByStatus(status: TaskStatus): TaskRow[] {
    return this.db.prepare('SELECT * FROM agent_tasks WHERE status = ? ORDER BY created_at').all(status) as TaskRow[];
  }

  getTasksBySession(sessionId: string): TaskRow[] {
    return this.db.prepare('SELECT * FROM agent_tasks WHERE session_id = ? ORDER BY created_at').all(sessionId) as TaskRow[];
  }

  failByAgent(agentName: string, error: string): void {
    const now = Date.now();
    const active = this.db.prepare(
      `SELECT id, session_id FROM agent_tasks WHERE target_agent = ? AND status NOT IN ('completed','failed','timeout','cancelled')`,
    ).all(agentName) as { id: string; session_id: string }[];

    for (const row of active) {
      this.clearTimeout(row.id);
      this.abortControllers.delete(row.id);
      this.db.prepare(
        `UPDATE agent_tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
      ).run(error, now, row.id);
      this.writeEvent(row.id, row.session_id, 'core', 'failed', 'error', error);
      this.eventBus.emit('task.failed', { taskId: row.id, targetAgent: agentName as AgentName, error });
    }

    if (active.length > 0) {
      logger.warn({ agent: agentName, count: active.length }, '智能体崩溃，孤立任务已标记失败');
    }
  }

  requeue(taskId: string, reason: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;

    const requeueCount = (task.requeue_count ?? 0) + 1;
    if (requeueCount > 3) {
      logger.warn({ taskId, requeueCount }, 'Requeue limit exceeded, failing task');
      this.fail(taskId, `Requeue limit exceeded after ${requeueCount - 1} retries: ${reason}`);
      return false;
    }

    this.clearTimeout(taskId);
    this.abortControllers.delete(taskId);

    this.db.prepare(`
      UPDATE agent_tasks SET status = 'created', error = NULL, finished_at = NULL,
        dispatched_at = NULL, acknowledged_at = NULL, started_at = NULL,
        requeue_count = ? WHERE id = ?
    `).run(requeueCount, taskId);

    this.writeEvent(taskId, task.session_id, 'core', 'created', 'warn', `Requeued (attempt ${requeueCount}): ${reason}`);
    this.eventBus.emit('task.created', { taskId, taskType: task.task_type, targetAgent: task.target_agent });
    metrics.counter('task_lifecycle_total').inc({ task_type: task.task_type, status: 'requeued' });

    logger.info({ taskId, requeueCount, reason }, 'Task requeued');
    return true;
  }

  requeueByAgent(agentName: string, reason: string): { requeued: string[]; failed: string[] } {
    const active = this.db.prepare(
      `SELECT id, session_id, requeue_count FROM agent_tasks WHERE target_agent = ? AND status NOT IN ('completed','failed','timeout','cancelled')`,
    ).all(agentName) as { id: string; session_id: string; requeue_count: number | null }[];

    const requeued: string[] = [];
    const failed: string[] = [];

    for (const row of active) {
      this.clearTimeout(row.id);
      this.abortControllers.delete(row.id);
      if (this.requeue(row.id, reason)) {
        requeued.push(row.id);
      } else {
        failed.push(row.id);
      }
    }

    return { requeued, failed };
  }

  getPendingCount(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM agent_tasks WHERE status NOT IN ('completed','failed','timeout','cancelled')"
    ).get() as { cnt: number };
    return row.cnt;
  }

  dispose(): void {
    for (const timer of this.timeouts.values()) {
      clearTimeout(timer);
    }
    this.timeouts.clear();
    this.abortControllers.clear();
  }

  private abortTask(taskId: string): void {
    const controller = this.abortControllers.get(taskId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(taskId);
    }
  }

  private startTimeout(taskId: string): void {
    const timer = setTimeout(() => {
      const task = this.getTask(taskId);
      if (!task) return;
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return;

      this.abortTask(taskId);
      const now = Date.now();
      this.db.prepare(`
        UPDATE agent_tasks SET status = 'timeout', error = '执行超时', finished_at = ? WHERE id = ?
      `).run(now, taskId);

      this.writeEvent(taskId, task.session_id, 'core', 'timeout', 'error', '执行超时');
      this.eventBus.emit('task.timeout', { taskId, targetAgent: task.target_agent });
      this.timeouts.delete(taskId);
      logger.warn({ taskId }, '任务超时');
    }, this.config.defaultTimeoutMs);

    this.timeouts.set(taskId, timer);
  }

  resetTimeout(taskId: string, newTimeoutMs: number): void {
    this.clearTimeout(taskId);
    const timer = setTimeout(() => {
      const task = this.getTask(taskId);
      if (!task) return;
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return;

      this.abortTask(taskId);
      const now = Date.now();
      this.db.prepare(`
        UPDATE agent_tasks SET status = 'timeout', error = '执行超时', finished_at = ? WHERE id = ?
      `).run(now, taskId);

      this.writeEvent(taskId, task.session_id, 'core', 'timeout', 'error', '执行超时');
      this.eventBus.emit('task.timeout', { taskId, targetAgent: task.target_agent });
      this.timeouts.delete(taskId);
      logger.warn({ taskId }, '任务超时');
    }, newTimeoutMs);
    this.timeouts.set(taskId, timer);
  }

  private clearTimeout(taskId: string): void {
    const timer = this.timeouts.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timeouts.delete(taskId);
    }
  }

  private writeEvent(
    taskId: string,
    sessionId: string,
    source: string,
    eventType: TaskEventType,
    level: 'error' | 'warn' | 'info' | 'debug',
    message: string,
    payload: Record<string, unknown> = {},
  ): void {
    try {
      this.db.prepare(`
        INSERT INTO task_events (id, task_id, session_id, source, event_type, level, message, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        genId('evt'),
        taskId,
        sessionId,
        source,
        eventType,
        level,
        message,
        JSON.stringify(payload),
        Date.now(),
      );
    } catch (err) {
      logger.error({ err, taskId, eventType }, '写入任务事件失败');
    }
  }
}

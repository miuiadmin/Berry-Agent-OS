import type { Database } from 'better-sqlite3';
import type { AgentName, TaskType, TaskStatus, TaskEventType } from '../contracts/agents.js';
import { EventBus } from './event-bus.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import { metrics } from '../observability/metrics.js';
import { getCurrentTrace } from '../observability/trace-context.js';
import { redactSecrets } from '../observability/redaction.js';

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

  /**
   * P2-9: 启动时扫描残留任务并重建 AbortController / 超时定时器。
   *
   * 进程重启后 AbortController 和 timeout timers 丢失，但 SQLite 中仍有
   * running/dispatched/acknowledged 状态的任务。这些任务：
   * 1. 无法被 abort（AbortController 丢失）
   * 2. 不会超时（timer 丢失）
   * 3. 需要等 sweep 定时器（60s 间隔）发现并标记，最长 30 分钟窗口
   *
   * 策略：对残留任务立即 fail + 发事件，让上层（checkpoint-service 等）决定是否重试。
   * 不尝试重建 AbortController（重启后 agent 进程也已丢失，无法继续执行）。
   */
  recoverOnStartup(): { failed: number } {
    const now = Date.now();
    const staleStatuses: TaskStatus[] = ['dispatched', 'running', 'acknowledged'];

    let failed = 0;
    for (const status of staleStatuses) {
      const tasks = this.db.prepare(
        `SELECT id, session_id, target_agent, created_at, dispatched_at, started_at FROM agent_tasks WHERE status = ?`,
      ).all(status) as Array<{ id: string; session_id: string; target_agent: string; created_at: number; dispatched_at: number | null; started_at: number | null }>;

      for (const task of tasks) {
        const elapsed = now - task.created_at;
        const error = `任务因服务重启被标记失败（原状态: ${status}，已耗时 ${Math.round(elapsed / 1000)}s）`;

        this.db.prepare(
          `UPDATE agent_tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
        ).run(error, now, task.id);

        this.writeEvent(task.id, task.session_id, 'core', 'failed', 'warn', error);
        this.eventBus.emit('task.failed', {
          taskId: task.id,
          targetAgent: task.target_agent as AgentName,
          error,
        });
        failed++;
        logger.info({ taskId: task.id, session_id: task.session_id, originalStatus: status }, '启动恢复: 残留任务已标记失败');
      }
    }

    if (failed > 0) {
      logger.info({ failed }, '启动恢复: 残留任务清理完成');
    }
    return { failed };
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
      // 15.0 V-7（sec-1 收尾）：input_payload 是任务输入的 JSON blob。delegation-orchestrator 会把
      // userMessage / assistantResponse / 被拒指令直接嵌进 inputPayload（extract_feedback / detect_gap 等），
      // 与 output_payload 同样可能内嵌用户贴的密钥。落库前 redact，对称覆盖两个 JSON blob 列。
      // 安全性：input_payload 仅用于事后 mission 元数据提取（missionId/planTaskId 是 ID，非密钥形态，
      // 不会被 redact 命中），永不回读喂给 agent 执行——live 派发用内存中的 inputPayload。故 redact 不影响执行路径。
      redactSecrets(JSON.stringify(input.inputPayload)),
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
    // 15.0 V-6（sec-1）：output_payload 是 Agent 最终输出的 JSON blob（可回显/转述工具结果中的密钥），
    // 与对话正文同等脱敏。序列化后整体 redactSecrets——占位符是普通字符，不破坏 JSON 结构。
    const payloadJson = redactSecrets(JSON.stringify(outputPayload));
    const result = this.db.prepare(`
      UPDATE agent_tasks SET status = 'completed', output_payload = ?, finished_at = ?, version = version + 1
      WHERE id = ? AND status NOT IN ('completed','failed','timeout','cancelled')
    `).run(payloadJson, now, taskId);

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

  /**
   * 将流式累积文本刷写到 output_payload，用于断连/刷新后的恢复。
   * 只在 running/acknowledged 状态时写入；任务已完成则 no-op（complete() 会覆盖最终内容）。
   */
  flushStreamingContent(taskId: string, content: string, reasoning?: string): void {
    // 15.0 V-6（sec-1）：streamingContent 是 Agent 流式累积文本，同样可能内嵌密钥，写前 redact。
    const payloadJson = redactSecrets(JSON.stringify({ streamingContent: content, reasoning: reasoning ?? null, flushedAt: Date.now() }));
    this.db.prepare(
      `UPDATE agent_tasks SET output_payload = ? WHERE id = ? AND status IN ('running','acknowledged')`,
    ).run(payloadJson, taskId);
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
    this.stopSweep();
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
      logger.warn({
        taskId,
        targetAgent: task.target_agent,
        sessionId: task.session_id,
        taskType: task.task_type,
        elapsed: now - task.created_at,
        status: task.status,
      }, '任务超时');
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
      logger.warn({
        taskId,
        targetAgent: task.target_agent,
        sessionId: task.session_id,
        taskType: task.task_type,
        elapsed: now - task.created_at,
        status: task.status,
      }, '任务超时');
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

  // §9.0 M8: Sweep stale tasks that are stuck in intermediate states
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepStaleTasks(), 60_000);
  }

  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private sweepStaleTasks(): void {
    const now = Date.now();
    const DISPATCH_TIMEOUT = 5 * 60_000;
    const RUNNING_TIMEOUT = 30 * 60_000;

    try {
      const staleDispatched = this.db.prepare(
        `SELECT id FROM agent_tasks WHERE status = 'dispatched' AND dispatched_at < ?`,
      ).all(now - DISPATCH_TIMEOUT) as Array<{ id: string }>;

      for (const { id } of staleDispatched) {
        this.fail(id, 'dispatch timeout (5 min)');
        logger.warn({ taskId: id }, 'Task swept: dispatch timeout');
      }

      const staleRunning = this.db.prepare(
        `SELECT id FROM agent_tasks WHERE status = 'running' AND started_at < ?`,
      ).all(now - RUNNING_TIMEOUT) as Array<{ id: string }>;

      for (const { id } of staleRunning) {
        this.fail(id, 'execution timeout (30 min)');
        logger.warn({ taskId: id }, 'Task swept: execution timeout');
      }
    } catch (err) {
      logger.debug({ err }, 'Task sweep failed');
    }
  }
}

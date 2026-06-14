import type { TaskManager } from './task-manager.js';
import { getEventBus } from './event-bus.js';
import type {
  DelegationEntry,
  DelegationState,
  DelegationGroup,
  DelegationMetrics,
  DelegationBudget,
  TurnOutputPayload,
  TurnFinalPayload,
  CreateDelegationParams,
  GuardAction,
  CorrectionContext,
  CorrectionConstraints,
} from '../contracts/delegation.js';
import { isDelegationTerminal, DEFAULT_INTERNAL_BUDGET, DEFAULT_EXTERNAL_BUDGET, CORRECTION_LIMITS } from '../contracts/delegation.js';
import { getLogger } from '../utils/logger.js';
import { postSystemReportEnvelope } from './board-projection.js';

const logger = getLogger('delegation-manager');

const MAX_RETAINED_OUTPUTS = 10;
/** 连续同工具失败 ≥ N → checkpoint（失败连续是真异常信号，不需要放宽） */
const GUARD_CONSECUTIVE_FAILURES = 3;
/** 连续同**写**工具 ≥ N → checkpoint。只读工具（inspect_code/read_file/search/list_directory 等）
 *  不计数——探索代码库连续调 inspect_code × 20 是正常的，不是死循环。
 *  只有连续写同一工具（write_file/edit_code/shell × N 无产出）才是真 loop 信号。 */
const GUARD_SAME_WRITE_TOOL_REPEAT = 8;
const GUARD_BUDGET_WARNING_RATIO = 0.7;

/**
 * 只读工具集合——这些工具连续调用是「探索」而非「死循环」：
 * inspect_code / read_file / list_directory / summarize_changes / search /
 * cron_list / list_skills / list_plugins / inspect_plugin 等。
 * delegation-manager 无法 import tool registry（会循环依赖），所以硬编码只读工具名。
 * 判断逻辑：工具名在 READ_ONLY_TOOLS 里 或 以 read_/list_/inspect_/search/ 开头 → 只读。
 */
const READ_ONLY_TOOLS = new Set([
  'inspect_code', 'read_file', 'list_directory', 'summarize_changes',
  'search', 'cron_list', 'list_skills', 'list_plugins', 'inspect_plugin',
  'dry_run_plugin', 'validate_plugin', 'cross_team_summary',
]);

/** 判断工具是否只读（不产生副作用）——连续调用只读工具不触发 same_tool_repeat guard */
function isReadOnlyTool(toolName: string | null | undefined): boolean {
  if (!toolName) return false;
  if (READ_ONLY_TOOLS.has(toolName)) return true;
  return toolName.startsWith('read_') || toolName.startsWith('list_') ||
         toolName.startsWith('inspect_') || toolName.startsWith('search');
}

function emptyMetrics(): DelegationMetrics {
  return {
    toolCallCount: 0,
    tokenUsed: { input: 0, output: 0 },
    consecutiveToolFailures: 0,
    sameToolRepeatCount: 0,
    lastToolName: null,
    checkpointCount: 0,
  };
}

// Used only by transitionState() for acknowledge — other methods guard individually
// to handle IPC out-of-order delivery gracefully
const VALID_TRANSITIONS: Record<DelegationState, DelegationState[]> = {
  routing: ['delegated', 'failed'],
  delegated: ['active', 'failed'],
  active: ['active', 'awaiting_user', 'reviewing', 'failed'],
  awaiting_user: ['active', 'failed'],
  reviewing: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export class DelegationManager {
  private entries = new Map<string, DelegationEntry>();
  private groups = new Map<string, DelegationGroup>();
  private correlationIndex = new Map<string, string>();
  private childToGroupIndex = new Map<string, string>();

  /**
   * M6: 每个目标 Agent 的活跃委托计数 + 平均完成时间。
   * 用于计算排队 ETA 和实现公平调度。
   */
  private agentQueueStats = new Map<string, {
    /** 当前活跃（非终态）的委托数量 */
    activeCount: number;
    /** 最近 N 次完成耗时（毫秒），用于估算 ETA */
    recentDurations: number[];
  }>();

  /** M6: 保留最近几次完成的时长用于 ETA 计算 */
  private static readonly ETA_WINDOW_SIZE = 5;

  constructor(
    private taskManager: TaskManager,
  ) {}

  create(params: CreateDelegationParams): string {
    const defaultBudget = params.targetKind === 'daemon' ? DEFAULT_EXTERNAL_BUDGET : DEFAULT_INTERNAL_BUDGET;
    const budget: DelegationBudget = { ...defaultBudget, ...params.budget };

    const taskId = this.taskManager.create({
      sessionId: params.sessionId,
      correlationId: params.correlationId,
      taskType: params.taskType,
      requester: params.requester,
      targetAgent: params.targetAgent,
      foreground: params.foreground,
      inputPayload: params.inputPayload,
    });

    this.taskManager.dispatch(taskId);

    const entry: DelegationEntry = {
      id: taskId,
      state: 'delegated',
      sessionId: params.sessionId,
      correlationId: params.correlationId,
      targetAgent: params.targetAgent,
      targetKind: params.targetKind,
      userMessage: params.userMessage,
      routeInstruction: typeof params.inputPayload.instruction === 'string' ? params.inputPayload.instruction : undefined,
      createdAt: Date.now(),
      reRouteDepth: params.reRouteDepth ?? 0,
      metrics: emptyMetrics(),
      outputs: [],
      parentId: params.parentId,
      budget,
    };

    this.entries.set(taskId, entry);
    this.correlationIndex.set(params.correlationId, taskId);

    // M6: 更新 Agent 队列统计 + 计算 ETA
    const queueInfo = this.updateQueueOnCreate(params.targetAgent);
    const eta = this.estimateWaitMs(params.targetAgent);

    getEventBus().emit('delegation.created', {
      delegationId: taskId,
      sessionId: params.sessionId,
      targetAgent: params.targetAgent,
      // M6: 排队信息（前端可展示 "预计等待 X 秒"）
      queuePosition: queueInfo.activeCount,
      expectedWaitMs: eta,
    });

    logger.debug({ delegationId: taskId, target: params.targetAgent, queuePosition: queueInfo.activeCount, etaMs: eta }, 'Delegation created');
    return taskId;
  }

  acknowledge(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (!this.transitionState(entry, 'active')) return false;

    try {
      this.taskManager.acknowledge(id);
    } catch {
      // TaskManager may reject if state mismatch — tolerate
    }
    try {
      this.taskManager.start(id);
    } catch {
      // May already be started
    }

    getEventBus().emit('delegation.acknowledged', { delegationId: id, targetAgent: entry.targetAgent });
    return true;
  }

  recordOutput(id: string, output: TurnOutputPayload): boolean {
    const entry = this.entries.get(id);
    if (!entry || isDelegationTerminal(entry.state)) return false;

    this.updateMetrics(entry, output);

    entry.outputs.push(output);
    if (entry.outputs.length > MAX_RETAINED_OUTPUTS) {
      entry.outputs.shift();
    }

    const guard = this.checkGuards(entry);
    if (guard.type === 'terminate') {
      this.fail(id, guard.reason);
      return false;
    }
    if (guard.type === 'checkpoint') {
      if (entry.metrics.checkpointCount >= CORRECTION_LIMITS.maxCheckpointsPerDelegation) {
        this.fail(id, 'Max checkpoint count exceeded — task complexity beyond expectations');
        return false;
      }
      const now = Date.now();
      if (entry.lastCheckpointAt && now - entry.lastCheckpointAt < CORRECTION_LIMITS.minIntervalMs) {
        return true;
      }
      entry.metrics.checkpointCount++;
      entry.lastCheckpointAt = now;
      getEventBus().emit('delegation.checkpoint_needed', { delegationId: id, trigger: guard.trigger });
      logger.info({ delegationId: id, trigger: guard.trigger }, 'Checkpoint triggered');
    }

    return true;
  }

  reportUncertainty(id: string, reason: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.state !== 'active') return;

    if (entry.metrics.checkpointCount >= CORRECTION_LIMITS.maxCheckpointsPerDelegation) return;
    const now = Date.now();
    if (entry.lastCheckpointAt && now - entry.lastCheckpointAt < CORRECTION_LIMITS.minIntervalMs) return;

    entry.metrics.checkpointCount++;
    entry.lastCheckpointAt = now;
    getEventBus().emit('delegation.checkpoint_needed', { delegationId: id, trigger: 'agent_uncertainty' });
    logger.info({ delegationId: id, reason, trigger: 'agent_uncertainty' }, 'Checkpoint triggered by agent uncertainty');
  }

  markAskingUser(id: string, question: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.state !== 'active') return false;
    entry.state = 'awaiting_user';
    logger.debug({ delegationId: id, question: question.slice(0, 80) }, 'Delegation awaiting user');
    return true;
  }

  resumeFromUserReply(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.state !== 'awaiting_user') return false;
    entry.state = 'active';
    return true;
  }

  submitForReview(id: string, final: TurnFinalPayload): boolean {
    const entry = this.entries.get(id);
    if (!entry || isDelegationTerminal(entry.state)) return false;
    if (entry.state !== 'active' && entry.state !== 'delegated') return false;
    entry.state = 'reviewing';
    entry.finalResponse = final.response;
    if (final.totalUsage) {
      entry.metrics.tokenUsed.input += final.totalUsage.inputTokens;
      entry.metrics.tokenUsed.output += final.totalUsage.outputTokens;
    }
    return true;
  }

  complete(id: string, response: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || isDelegationTerminal(entry.state)) return false;

    entry.state = 'completed';
    entry.finalResponse = response;

    this.taskManager.complete(id, { response });

    const durationMs = Date.now() - entry.createdAt;

    // M6: 记录完成耗时，更新 Agent 队列统计（用于后续 ETA 计算）
    this.updateQueueOnComplete(entry.targetAgent, durationMs);

    getEventBus().emit('delegation.completed', {
      delegationId: id,
      targetAgent: entry.targetAgent,
      durationMs,
    });

    logger.debug({ delegationId: id, durationMs }, 'Delegation completed');
    return true;
  }

  fail(id: string, error: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || isDelegationTerminal(entry.state)) return false;

    entry.state = 'failed';

    this.taskManager.fail(id, error);

    // M6: 更新队列统计（减少活跃计数）
    this.updateQueueOnComplete(entry.targetAgent);

    getEventBus().emit('delegation.failed', {
      delegationId: id,
      targetAgent: entry.targetAgent,
      error,
    });

    // 16.0 §7.5 板即审计：fail 同步投影 system report 信封（best-effort），让 board 忠实镜像所有 fail
    // 转换——包括不经 orchestrator report 的路径（agent.crashed/task.timeout/sweepStale/guard-terminate/
    // failByAgent）。不替代权威 delegation.failed emit（状态机仍是权威源）；board 是 best-effort 审计镜像。
    try {
      postSystemReportEnvelope(id, { summary: `任务失败：${error}`, sessionId: entry.sessionId });
    } catch { /* best-effort 审计镜像，失败不影响状态机 */ }

    logger.warn({ delegationId: id, error }, 'Delegation failed');
    return true;
  }

  interrupt(id: string, reason?: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || isDelegationTerminal(entry.state)) return false;

    entry.state = 'failed';

    try {
      this.taskManager.fail(id, reason ?? 'interrupted');
    } catch {
      // Tolerate if already terminal in TaskManager
    }

    getEventBus().emit('delegation.failed', {
      delegationId: id,
      targetAgent: entry.targetAgent,
      error: reason ?? 'interrupted',
    });

    // 16.0 §7.5 板即审计：interrupt 同步投影 system report（best-effort，让 board 镜像用户中断转换）
    try {
      postSystemReportEnvelope(id, { summary: `执行已取消：${reason ?? 'interrupted'}`, sessionId: entry.sessionId });
    } catch { /* best-effort 审计镜像 */ }

    logger.info({ delegationId: id, reason }, 'Delegation interrupted');
    return true;
  }

  // --- Query Methods ---

  get(id: string): DelegationEntry | undefined {
    return this.entries.get(id);
  }

  getByCorrelation(correlationId: string): DelegationEntry | undefined {
    const id = this.correlationIndex.get(correlationId);
    if (!id) return undefined;
    return this.entries.get(id);
  }

  getActiveForSession(sessionId: string): DelegationEntry[] {
    const result: DelegationEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.sessionId === sessionId && !isDelegationTerminal(entry.state)) {
        result.push(entry);
      }
    }
    return result;
  }

  /**
   * 13.0 §13.16: 返回所有委托条目（含终态）。
   * TaskHeartbeatManager 通过此方法扫描活跃委托，过滤终态后发心跳。
   */
  getAll(): DelegationEntry[] {
    return [...this.entries.values()];
  }

  // --- Multi-route Group Management ---

  createGroup(parentId: string, correlationId: string, sessionId: string): DelegationGroup {
    const group: DelegationGroup = {
      parentId,
      childIds: new Set(),
      completedResults: new Map(),
      correlationId,
      sessionId,
      createdAt: Date.now(),
    };
    this.groups.set(correlationId, group);
    return group;
  }

  addChildToGroup(correlationId: string, childId: string): void {
    const group = this.groups.get(correlationId);
    if (group) {
      group.childIds.add(childId);
      this.childToGroupIndex.set(childId, correlationId);
    }
  }

  completeChild(correlationId: string, childId: string, agentName: string, response: string): boolean {
    const group = this.groups.get(correlationId);
    if (!group) return false;

    group.childIds.delete(childId);
    group.completedResults.set(childId, { agentName, response });
    this.childToGroupIndex.delete(childId);

    return group.childIds.size === 0;
  }

  getGroup(correlationId: string): DelegationGroup | undefined {
    return this.groups.get(correlationId);
  }

  getGroupByChild(childId: string): { group: DelegationGroup; correlationId: string } | undefined {
    const correlationId = this.childToGroupIndex.get(childId);
    if (!correlationId) return undefined;
    const group = this.groups.get(correlationId);
    if (!group) return undefined;
    return { group, correlationId };
  }

  removeGroup(correlationId: string): DelegationGroup | undefined {
    const group = this.groups.get(correlationId);
    if (group) {
      for (const childId of group.childIds) {
        this.childToGroupIndex.delete(childId);
      }
      this.groups.delete(correlationId);
    }
    return group;
  }

  // --- Correction Support ---

  buildCorrectionContext(id: string): CorrectionContext | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;

    const recentOutputs: string[] = [];
    for (const out of entry.outputs.slice(-5)) {
      if (out.kind === 'tool_result' || out.kind === 'tool_error') {
        const d = out.data as { toolName?: string; error?: string; summary?: string };
        recentOutputs.push(`[${out.kind}] ${d.toolName ?? 'unknown'}: ${d.summary ?? d.error ?? ''}`);
      } else if (out.kind === 'text_delta') {
        const d = out.data as { text?: string };
        if (d.text) recentOutputs.push(`[text] ${d.text.slice(0, 100)}`);
      }
    }

    const failedToolsMap = new Map<string, { count: number; error: string }>();
    for (const out of entry.outputs) {
      if (out.kind === 'tool_error') {
        const d = out.data as { toolName?: string; error?: string };
        const name = d.toolName ?? 'unknown';
        const existing = failedToolsMap.get(name);
        if (existing) {
          existing.count++;
        } else {
          failedToolsMap.set(name, { count: 1, error: d.error ?? '' });
        }
      }
    }
    const failedTools = [...failedToolsMap.entries()].map(([name, v]) => ({
      name,
      error: v.error,
      count: v.count,
    }));

    return {
      userMessage: entry.userMessage,
      routeInstruction: entry.routeInstruction ?? '',
      metrics: { ...entry.metrics },
      budget: { ...entry.budget },
      recentOutputs,
      failedTools,
    };
  }

  applyConstraints(id: string, constraints: CorrectionConstraints): boolean {
    const entry = this.entries.get(id);
    if (!entry || isDelegationTerminal(entry.state)) return false;

    if (constraints.maxRemainingTokens != null) {
      const remaining = Math.min(
        entry.budget.maxOutputTokens - entry.metrics.tokenUsed.output,
        constraints.maxRemainingTokens,
      );
      entry.budget.maxOutputTokens = entry.metrics.tokenUsed.output + Math.max(remaining, 0);
    }
    if (constraints.reducedTimeout != null) {
      entry.budget.maxDurationMs = Math.min(entry.budget.maxDurationMs, constraints.reducedTimeout);
    }
    if (constraints.forbiddenTools) {
      entry.forbiddenTools = [...(entry.forbiddenTools ?? []), ...constraints.forbiddenTools];
    }

    logger.debug({ delegationId: id, constraints }, 'Constraints applied');
    return true;
  }

  // --- Cleanup ---

  sweepStale(maxAgeMs: number): number {
    const now = Date.now();
    let swept = 0;

    for (const [id, entry] of this.entries) {
      if (isDelegationTerminal(entry.state)) {
        if (now - entry.createdAt > maxAgeMs * 2) {
          this.entries.delete(id);
          this.correlationIndex.delete(entry.correlationId);
          swept++;
        }
        continue;
      }

      if (now - entry.createdAt > maxAgeMs) {
        this.fail(id, 'Delegation stale — exceeded max age');
        swept++;
      }
    }

    for (const [correlationId, group] of this.groups) {
      if (now - group.createdAt > maxAgeMs) {
        for (const childId of group.childIds) {
          this.childToGroupIndex.delete(childId);
        }
        this.groups.delete(correlationId);
        swept++;
      }
    }

    return swept;
  }

  failByAgent(agentName: string, error: string): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.targetAgent === agentName && !isDelegationTerminal(entry.state)) {
        this.fail(entry.id, error);
        count++;
      }
    }
    return count;
  }

  // --- Private ---

  private transitionState(entry: DelegationEntry, to: DelegationState): boolean {
    const allowed = VALID_TRANSITIONS[entry.state];
    if (!allowed.includes(to)) {
      logger.debug({ delegationId: entry.id, from: entry.state, to }, 'Invalid state transition');
      return false;
    }
    entry.state = to;
    return true;
  }

  private updateMetrics(entry: DelegationEntry, output: TurnOutputPayload): void {
    const m = entry.metrics;

    switch (output.kind) {
      case 'usage': {
        const data = output.data as { inputTokens?: number; outputTokens?: number };
        m.tokenUsed.input += data.inputTokens ?? 0;
        m.tokenUsed.output += data.outputTokens ?? 0;
        break;
      }
      case 'tool_result': {
        const data = output.data as { toolName?: string };
        m.toolCallCount++;
        m.consecutiveToolFailures = 0;
        if (data.toolName === m.lastToolName) {
          m.sameToolRepeatCount++;
        } else {
          m.sameToolRepeatCount = 1;
          m.lastToolName = data.toolName ?? null;
        }
        break;
      }
      case 'tool_error': {
        const data = output.data as { toolName?: string };
        m.toolCallCount++;
        m.consecutiveToolFailures++;
        if (data.toolName === m.lastToolName) {
          m.sameToolRepeatCount++;
        } else {
          m.sameToolRepeatCount = 1;
          m.lastToolName = data.toolName ?? null;
        }
        break;
      }
    }
  }

  private checkGuards(entry: DelegationEntry): GuardAction {
    const m = entry.metrics;
    const b = entry.budget;
    const elapsed = Date.now() - entry.createdAt;

    if (m.tokenUsed.output >= b.maxOutputTokens) {
      return { type: 'terminate', reason: `Output token budget exceeded (${m.tokenUsed.output}/${b.maxOutputTokens})` };
    }
    if (m.toolCallCount >= b.maxToolCalls) {
      return { type: 'terminate', reason: `Tool call limit reached (${m.toolCallCount}/${b.maxToolCalls})` };
    }
    if (elapsed >= b.maxDurationMs) {
      return { type: 'terminate', reason: `Duration limit exceeded (${elapsed}ms/${b.maxDurationMs}ms)` };
    }

    if (m.consecutiveToolFailures >= GUARD_CONSECUTIVE_FAILURES) {
      return { type: 'checkpoint', trigger: 'consecutive_tool_failures' };
    }
    // same_tool_repeat 只对写工具触发——只读工具连续调用是探索不是 loop（见 isReadOnlyTool）
    if (!isReadOnlyTool(m.lastToolName) && m.sameToolRepeatCount >= GUARD_SAME_WRITE_TOOL_REPEAT) {
      return { type: 'checkpoint', trigger: 'same_tool_repeat' };
    }
    if (!entry.budgetWarningTriggered && m.tokenUsed.output >= b.maxOutputTokens * GUARD_BUDGET_WARNING_RATIO) {
      entry.budgetWarningTriggered = true;
      return { type: 'checkpoint', trigger: 'budget_warning' };
    }

    return { type: 'none' };
  }

  // ─────────────────────────────────────────────────────────────
  // M6: 多用户排队 & ETA 管理
  // ─────────────────────────────────────────────────────────────

  /**
   * M6: 新委托创建时更新 Agent 队列统计。
   * @returns 更新后的队列信息
   */
  private updateQueueOnCreate(targetAgent: string): { activeCount: number } {
    const stats = this.getOrCreateStats(targetAgent);
    stats.activeCount++;

    // 重新扫描确认计数准确（防止 drift）
    this.recountActive(targetAgent, stats);

    return { activeCount: stats.activeCount };
  }

  /**
   * M6: 委托完成/失败时更新 Agent 队列统计 + 记录耗时。
   * @param durationMs 完成耗时（失败时传 undefined）
   */
  private updateQueueOnComplete(targetAgent: string, durationMs?: number): void {
    const stats = this.getOrCreateStats(targetAgent);
    stats.activeCount = Math.max(0, stats.activeCount - 1);

    if (durationMs !== undefined) {
      stats.recentDurations.push(durationMs);
      if (stats.recentDurations.length > DelegationManager.ETA_WINDOW_SIZE) {
        stats.recentDurations.shift();
      }
    }
  }

  /**
   * M6: 估算目标 Agent 的排队等待时间（毫秒）。
   *
   * 算法：活跃数 × 最近 N 次的平均耗时。
   * 无历史数据时返回保守估计（30 秒 / 个）。
   */
  estimateWaitMs(targetAgent: string): number {
    const stats = this.agentQueueStats.get(targetAgent);
    if (!stats || stats.activeCount <= 1) return 0;

    const queueDepth = stats.activeCount - 1; // 第一个正在处理，其余在排队
    if (queueDepth <= 0) return 0;

    // 有历史数据时用平均值
    if (stats.recentDurations.length > 0) {
      const avg = stats.recentDurations.reduce((a, b) => a + b, 0) / stats.recentDurations.length;
      return Math.round(queueDepth * avg);
    }

    // 无历史数据：保守估计 30 秒 / 个
    return queueDepth * 30_000;
  }

  /**
   * M6: 获取目标 Agent 的队列状态（供外部查询）。
   */
  getQueueStatus(targetAgent: string): { activeCount: number; expectedWaitMs: number } {
    const stats = this.agentQueueStats.get(targetAgent);
    return {
      activeCount: stats?.activeCount ?? 0,
      expectedWaitMs: this.estimateWaitMs(targetAgent),
    };
  }

  /** 获取或创建 Agent 的队列统计 */
  private getOrCreateStats(targetAgent: string): { activeCount: number; recentDurations: number[] } {
    let stats = this.agentQueueStats.get(targetAgent);
    if (!stats) {
      stats = { activeCount: 0, recentDurations: [] };
      this.agentQueueStats.set(targetAgent, stats);
    }
    return stats;
  }

  /** 重新扫描确认活跃计数准确（防止 drift） */
  private recountActive(targetAgent: string, stats: { activeCount: number; recentDurations: number[] }): void {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.targetAgent === targetAgent && !isDelegationTerminal(entry.state)) {
        count++;
      }
    }
    stats.activeCount = count;
  }
}

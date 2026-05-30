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

const logger = getLogger('delegation-manager');

const MAX_RETAINED_OUTPUTS = 10;
const GUARD_CONSECUTIVE_FAILURES = 3;
const GUARD_SAME_TOOL_REPEAT = 5;
const GUARD_BUDGET_WARNING_RATIO = 0.7;

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
  active: ['awaiting_user', 'reviewing', 'failed'],
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

    getEventBus().emit('delegation.created', {
      delegationId: taskId,
      sessionId: params.sessionId,
      targetAgent: params.targetAgent,
    });

    logger.debug({ delegationId: taskId, target: params.targetAgent }, 'Delegation created');
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

    getEventBus().emit('delegation.failed', {
      delegationId: id,
      targetAgent: entry.targetAgent,
      error,
    });

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
    if (m.sameToolRepeatCount >= GUARD_SAME_TOOL_REPEAT) {
      return { type: 'checkpoint', trigger: 'same_tool_repeat' };
    }
    if (!entry.budgetWarningTriggered && m.tokenUsed.output >= b.maxOutputTokens * GUARD_BUDGET_WARNING_RATIO) {
      entry.budgetWarningTriggered = true;
      return { type: 'checkpoint', trigger: 'budget_warning' };
    }

    return { type: 'none' };
  }
}

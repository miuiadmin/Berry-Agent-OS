import type Database from 'better-sqlite3';
import type { EventBus } from '../contracts/infrastructure.js';
import type { AgentName } from '../contracts/agents.js';

export type AlertTier = 'info' | 'warning' | 'critical' | 'exceeded';
export type BudgetScope = 'session' | 'agent' | 'task' | 'daily';

export interface ModelCostConfig {
  inputTokenCost: number;
  outputTokenCost: number;
}

export interface BudgetConfig {
  sessionLimit: number;
  agentLimit: number;
  taskLimit: number;
  dailyLimit: number;
  alertThresholds: { info: number; warning: number; critical: number };
  costPerInputToken: number;
  costPerOutputToken: number;
  modelCosts?: Record<string, ModelCostConfig>;
  locale?: 'zh' | 'en';
}

export interface TokenUsageSnapshot {
  scope: BudgetScope;
  scopeId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  budgetLimit: number;
  budgetUsedPercent: number;
  currentTier: AlertTier;
}

export interface BudgetAlert {
  scope: BudgetScope;
  scopeId: string;
  tier: AlertTier;
  usedPercent: number;
  totalTokens: number;
  limit: number;
  message: string;
}

export interface RecordUsageInput {
  sessionId: string;
  agentName: AgentName;
  taskId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  model: string;
}

const DEFAULT_CONFIG: BudgetConfig = {
  sessionLimit: 500_000,
  agentLimit: 200_000,
  taskLimit: 100_000,
  dailyLimit: 2_000_000,
  alertThresholds: { info: 0.5, warning: 0.75, critical: 0.9 },
  costPerInputToken: 0.000003,
  costPerOutputToken: 0.000015,
  locale: 'zh',
};

const TIER_ORDER: AlertTier[] = ['info', 'warning', 'critical', 'exceeded'];

function tierIndex(tier: AlertTier): number {
  return TIER_ORDER.indexOf(tier);
}

export class TokenBudgetController {
  private config: BudgetConfig;
  private lastAlertedTier = new Map<string, AlertTier>();

  constructor(
    private readonly db: Database.Database,
    private readonly eventBus: EventBus | null,
    config?: Partial<BudgetConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  recordUsage(input: RecordUsageInput): BudgetAlert | null {
    const total = input.inputTokens + input.outputTokens;
    const cost = this.estimateCost(input.inputTokens, input.outputTokens, input.model);

    this.db.prepare(`
      INSERT INTO token_usage (session_id, agent_name, task_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, cost_usd, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId,
      input.agentName,
      input.taskId ?? null,
      input.inputTokens,
      input.outputTokens,
      input.cacheReadTokens ?? 0,
      input.cacheCreationTokens ?? 0,
      input.model,
      cost,
      Date.now(),
    );

    const scopes: Array<{ scope: BudgetScope; scopeId: string; limit: number }> = [
      { scope: 'session', scopeId: input.sessionId, limit: this.config.sessionLimit },
      { scope: 'agent', scopeId: `${input.sessionId}:${input.agentName}`, limit: this.config.agentLimit },
      { scope: 'daily', scopeId: 'global', limit: this.config.dailyLimit },
    ];
    if (input.taskId) {
      scopes.push({ scope: 'task', scopeId: input.taskId, limit: this.config.taskLimit });
    }

    let highestAlert: BudgetAlert | null = null;
    for (const { scope, scopeId, limit } of scopes) {
      const usage = this.getUsage(scope, scopeId);
      const alert = this.checkAndEmitAlert(scope, scopeId, usage.totalTokens, limit);
      if (alert && (!highestAlert || tierIndex(alert.tier) > tierIndex(highestAlert.tier))) {
        highestAlert = alert;
      }
    }

    return highestAlert;
  }

  getUsage(scope: BudgetScope, scopeId: string): TokenUsageSnapshot {
    const limit = this.getLimitForScope(scope);
    const row = this.queryUsage(scope, scopeId);
    const totalTokens = row.inputTokens + row.outputTokens;
    const usedPercent = limit > 0 ? totalTokens / limit : 0;

    return {
      scope,
      scopeId,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheCreationTokens: row.cacheCreationTokens,
      totalTokens,
      estimatedCostUsd: row.costUsd,
      budgetLimit: limit,
      budgetUsedPercent: usedPercent,
      currentTier: this.computeTier(usedPercent),
    };
  }

  getSessionUsage(sessionId: string): TokenUsageSnapshot {
    return this.getUsage('session', sessionId);
  }

  getAgentUsage(sessionId: string, agentName: AgentName): TokenUsageSnapshot {
    return this.getUsage('agent', `${sessionId}:${agentName}`);
  }

  getTaskUsage(taskId: string): TokenUsageSnapshot {
    return this.getUsage('task', taskId);
  }

  getDailyUsage(): TokenUsageSnapshot {
    return this.getUsage('daily', 'global');
  }

  checkBudget(scope: BudgetScope, scopeId: string): { allowed: boolean; alert?: BudgetAlert } {
    const usage = this.getUsage(scope, scopeId);
    if (usage.currentTier === 'exceeded') {
      return {
        allowed: false,
        alert: {
          scope,
          scopeId,
          tier: 'exceeded',
          usedPercent: usage.budgetUsedPercent,
          totalTokens: usage.totalTokens,
          limit: usage.budgetLimit,
          message: this.buildExceededMessage(scope, scopeId, usage.budgetUsedPercent),
        },
      };
    }
    return { allowed: true };
  }

  checkPostResponse(input: RecordUsageInput, abortController?: AbortController): BudgetAlert | null {
    const alert = this.recordUsage(input);
    if (alert && alert.tier === 'exceeded' && abortController) {
      abortController.abort(alert.message);
    }
    return alert;
  }

  estimateCost(inputTokens: number, outputTokens: number, model?: string): number {
    if (model && this.config.modelCosts?.[model]) {
      const mc = this.config.modelCosts[model];
      return inputTokens * mc.inputTokenCost + outputTokens * mc.outputTokenCost;
    }
    return inputTokens * this.config.costPerInputToken + outputTokens * this.config.costPerOutputToken;
  }

  private queryUsage(scope: BudgetScope, scopeId: string): {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
  } {
    let sql: string;
    let params: unknown[];

    switch (scope) {
      case 'session':
        sql = `SELECT COALESCE(SUM(input_tokens),0) as i, COALESCE(SUM(output_tokens),0) as o,
               COALESCE(SUM(cache_read_tokens),0) as cr, COALESCE(SUM(cache_creation_tokens),0) as cc,
               COALESCE(SUM(cost_usd),0) as cost FROM token_usage WHERE session_id = ?`;
        params = [scopeId];
        break;
      case 'agent': {
        const parts = scopeId.split(':');
        if (parts.length < 2) throw new Error(`invalid agent scopeId format, expected "sessionId:agentName": ${scopeId}`);
        const [sessionId, agentName] = parts;
        sql = `SELECT COALESCE(SUM(input_tokens),0) as i, COALESCE(SUM(output_tokens),0) as o,
               COALESCE(SUM(cache_read_tokens),0) as cr, COALESCE(SUM(cache_creation_tokens),0) as cc,
               COALESCE(SUM(cost_usd),0) as cost FROM token_usage WHERE session_id = ? AND agent_name = ?`;
        params = [sessionId, agentName];
        break;
      }
      case 'task':
        sql = `SELECT COALESCE(SUM(input_tokens),0) as i, COALESCE(SUM(output_tokens),0) as o,
               COALESCE(SUM(cache_read_tokens),0) as cr, COALESCE(SUM(cache_creation_tokens),0) as cc,
               COALESCE(SUM(cost_usd),0) as cost FROM token_usage WHERE task_id = ?`;
        params = [scopeId];
        break;
      case 'daily': {
        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0);
        sql = `SELECT COALESCE(SUM(input_tokens),0) as i, COALESCE(SUM(output_tokens),0) as o,
               COALESCE(SUM(cache_read_tokens),0) as cr, COALESCE(SUM(cache_creation_tokens),0) as cc,
               COALESCE(SUM(cost_usd),0) as cost FROM token_usage WHERE created_at >= ?`;
        params = [dayStart.getTime()];
        break;
      }
      default: {
        const _exhaustive: never = scope;
        throw new Error(`unknown budget scope: ${_exhaustive}`);
      }
    }

    const row = this.db.prepare(sql).get(...params) as Record<string, number> | undefined;
    if (!row) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
    return {
      inputTokens: row.i,
      outputTokens: row.o,
      cacheReadTokens: row.cr,
      cacheCreationTokens: row.cc,
      costUsd: row.cost,
    };
  }

  private getLimitForScope(scope: BudgetScope): number {
    switch (scope) {
      case 'session': return this.config.sessionLimit;
      case 'agent': return this.config.agentLimit;
      case 'task': return this.config.taskLimit;
      case 'daily': return this.config.dailyLimit;
    }
  }

  private computeTier(usedPercent: number): AlertTier {
    if (usedPercent >= 1.0) return 'exceeded';
    if (usedPercent >= this.config.alertThresholds.critical) return 'critical';
    if (usedPercent >= this.config.alertThresholds.warning) return 'warning';
    if (usedPercent >= this.config.alertThresholds.info) return 'info';
    return 'info';
  }

  private checkAndEmitAlert(scope: BudgetScope, scopeId: string, totalTokens: number, limit: number): BudgetAlert | null {
    const usedPercent = limit > 0 ? totalTokens / limit : 0;
    const tier = this.computeTier(usedPercent);

    if (usedPercent < this.config.alertThresholds.info) return null;

    const key = `${scope}:${scopeId}`;
    const lastTier = this.lastAlertedTier.get(key);
    if (lastTier && tierIndex(tier) <= tierIndex(lastTier)) return null;

    this.lastAlertedTier.set(key, tier);

    const alert: BudgetAlert = {
      scope,
      scopeId,
      tier,
      usedPercent,
      totalTokens,
      limit,
      message: this.buildAlertMessage(scope, scopeId, tier, usedPercent),
    };

    this.eventBus?.emit('budget.alert', alert);
    return alert;
  }

  private buildAlertMessage(scope: BudgetScope, scopeId: string, tier: AlertTier, usedPercent: number): string {
    const pct = Math.round(usedPercent * 100);
    if (this.config.locale === 'en') {
      const scopeLabel = scope === 'session' ? 'Session' : scope === 'agent' ? 'Agent' : scope === 'task' ? 'Task' : 'Daily';
      switch (tier) {
        case 'info': return `${scopeLabel}(${scopeId}) token usage at ${pct}%`;
        case 'warning': return `${scopeLabel}(${scopeId}) token usage at ${pct}%, please monitor`;
        case 'critical': return `${scopeLabel}(${scopeId}) token usage at ${pct}%, approaching limit`;
        case 'exceeded': return `${scopeLabel}(${scopeId}) token budget exceeded (${pct}%)`;
      }
    }
    const scopeLabel = scope === 'session' ? '会话' : scope === 'agent' ? '智能体' : scope === 'task' ? '任务' : '每日';
    switch (tier) {
      case 'info': return `${scopeLabel}(${scopeId}) Token 使用已达 ${pct}%`;
      case 'warning': return `${scopeLabel}(${scopeId}) Token 使用已达 ${pct}%，请注意控制`;
      case 'critical': return `${scopeLabel}(${scopeId}) Token 使用已达 ${pct}%，接近上限`;
      case 'exceeded': return `${scopeLabel}(${scopeId}) Token 预算已超限（${pct}%）`;
    }
  }

  private buildExceededMessage(scope: BudgetScope, scopeId: string, usedPercent: number): string {
    const pct = Math.round(usedPercent * 100);
    if (this.config.locale === 'en') {
      return `Token budget exceeded: ${scope}(${scopeId}) at ${pct}%`;
    }
    return `Token 预算已超限：${scope}(${scopeId}) 使用 ${pct}%`;
  }
}

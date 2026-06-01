import type Database from 'better-sqlite3';
import type { EventBus } from '../contracts/infrastructure.js';
import type { ChainConfig, ChainStep, CronJobRow, CronExecutionRow } from './contracts.js';
import type { TriggerDispatcher } from './trigger-dispatcher.js';
import { genId } from '../utils/id.js';
import { safeJsonParse } from '../utils/safe-json.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('chain-executor');

interface ChainState {
  steps: Record<string, 'pending' | 'running' | 'completed' | 'failed' | 'awaiting_approval'>;
  results: Record<string, string>;
}

export class ChainExecutor {
  constructor(
    private readonly db: Database.Database,
    private readonly eventBus: EventBus,
    private readonly dispatcher: TriggerDispatcher,
  ) {}

  startChain(job: CronJobRow, triggerPayload?: unknown): string | null {
    if (!job.chain_config) return null;

    let config: ChainConfig;
    try {
      config = JSON.parse(job.chain_config);
    } catch {
      logger.warn({ jobId: job.id }, 'Invalid chain_config JSON');
      return null;
    }

    if (!config.steps || config.steps.length === 0) return null;

    const roundId = genId('rnd');
    const state: ChainState = { steps: {}, results: {} };
    for (const step of config.steps) {
      state.steps[step.id] = 'pending';
    }

    this.db.prepare(`
      INSERT INTO cron_executions (id, job_id, workspace_id, round_id, trigger_source, status, total_agents, started_at, summary)
      VALUES (?, ?, ?, ?, 'cron', 'running', ?, ?, ?)
    `).run(genId('exec'), job.id, job.workspace_id, roundId, config.steps.length, Date.now(), JSON.stringify(state));

    this.eventBus.emit('scheduler.chain_started', {
      jobId: job.id,
      roundId,
      totalSteps: config.steps.length,
    });

    this.advanceChain(job, config, roundId, state);
    return roundId;
  }

  completeStep(roundId: string, stepId: string, result: string): void {
    const execution = this.getChainExecution(roundId);
    if (!execution) return;

    const job = this.db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(execution.job_id) as CronJobRow | undefined;
    if (!job || !job.chain_config) return;

    const config: ChainConfig = safeJsonParse<ChainConfig>(job.chain_config, { steps: [] });
    const state = this.getState(execution);

    state.steps[stepId] = 'completed';
    state.results[stepId] = result;
    this.saveState(roundId, state);

    this.eventBus.emit('scheduler.chain_step_completed', { roundId, stepId });

    const allDone = Object.values(state.steps).every(s => s === 'completed' || s === 'failed');
    if (allDone) {
      this.completeChain(roundId);
      return;
    }

    this.advanceChain(job, config, roundId, state);
  }

  failStep(roundId: string, stepId: string, error: string): void {
    const execution = this.getChainExecution(roundId);
    if (!execution) return;

    const state = this.getState(execution);
    state.steps[stepId] = 'failed';
    state.results[stepId] = `ERROR: ${error}`;
    this.saveState(roundId, state);

    this.completeChain(roundId);
  }

  approveStep(roundId: string, stepId: string): void {
    const execution = this.getChainExecution(roundId);
    if (!execution) return;

    const job = this.db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(execution.job_id) as CronJobRow | undefined;
    if (!job || !job.chain_config) return;

    const config: ChainConfig = safeJsonParse<ChainConfig>(job.chain_config, { steps: [] });
    const state = this.getState(execution);

    if (state.steps[stepId] !== 'awaiting_approval') return;

    state.steps[stepId] = 'pending';
    this.saveState(roundId, state);

    this.advanceChain(job, config, roundId, state);
  }

  rejectStep(roundId: string, stepId: string, reason: string): void {
    const execution = this.getChainExecution(roundId);
    if (!execution) return;

    const state = this.getState(execution);
    state.steps[stepId] = 'failed';
    state.results[stepId] = `REJECTED: ${reason}`;
    this.saveState(roundId, state);

    this.completeChain(roundId);
  }

  private advanceChain(job: CronJobRow, config: ChainConfig, roundId: string, state: ChainState): void {
    for (const step of config.steps) {
      if (state.steps[step.id] !== 'pending') continue;

      const depsReady = !step.dependsOn || step.dependsOn.every(dep => state.steps[dep] === 'completed');
      if (!depsReady) continue;

      if (config.approvalRequired?.includes(step.id)) {
        state.steps[step.id] = 'awaiting_approval';
        this.saveState(roundId, state);
        this.eventBus.emit('scheduler.chain_approval_pending', { roundId, stepId: step.id });
        logger.debug({ roundId, stepId: step.id }, 'Chain step awaiting approval');
        continue;
      }

      state.steps[step.id] = 'running';
      this.saveState(roundId, state);
      this.dispatchStep(job, step, roundId);
    }
  }

  private dispatchStep(job: CronJobRow, step: ChainStep, roundId: string): void {
    this.dispatcher.trigger(job.id, { type: 'cron' }, {
      chainRoundId: roundId,
      chainStepId: step.id,
      stepPrompt: step.prompt,
      targetAgent: step.agentId,
    });
  }

  private completeChain(roundId: string): void {
    this.db.prepare(`
      UPDATE cron_executions SET status = 'completed', completed_at = ? WHERE round_id = ? AND status = 'running'
    `).run(Date.now(), roundId);

    this.eventBus.emit('scheduler.chain_completed', { roundId });
    logger.debug({ roundId }, 'Chain completed');
  }

  private getChainExecution(roundId: string): CronExecutionRow | null {
    return (this.db.prepare(
      "SELECT * FROM cron_executions WHERE round_id = ? AND status = 'running' LIMIT 1"
    ).get(roundId) as CronExecutionRow | undefined) ?? null;
  }

  private getState(execution: CronExecutionRow): ChainState {
    if (!execution.summary) return { steps: {}, results: {} };
    try {
      return JSON.parse(execution.summary);
    } catch {
      return { steps: {}, results: {} };
    }
  }

  private saveState(roundId: string, state: ChainState): void {
    this.db.prepare(
      "UPDATE cron_executions SET summary = ? WHERE round_id = ? AND status = 'running'"
    ).run(JSON.stringify(state), roundId);
  }
}

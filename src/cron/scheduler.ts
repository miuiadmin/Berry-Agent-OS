import { exec } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { LlmClient } from '../llm/client.js';
import type { ISkillLoader } from '../skills/contract.js';
import type { EventBus } from '../contracts/infrastructure.js';
import { checkBlocklist } from '../safety/blocklist.js';
import { CronExecutionError } from './errors.js';
import { computeNextRun, isOneShot } from './parser.js';
import type { ICronScheduler } from './contract.js';
import type { CronConfig, ScheduledTaskRow, ScriptResult, RunningJob } from './types.js';
import { metrics } from '../observability/metrics.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('cron');

export class CronScheduler implements ICronScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = new Map<string, RunningJob>();
  private ticking = false;

  constructor(
    private readonly db: Database.Database,
    private readonly llm: LlmClient,
    private readonly skillLoader: ISkillLoader,
    private readonly eventBus: EventBus,
    private readonly config: CronConfig,
  ) {}

  start(): void {
    if (this.timer) return;
    logger.info({ intervalMs: this.config.checkIntervalMs }, '定时调度器启动');
    this.timer = setInterval(() => void this.tick(), this.config.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const [, job] of this.running) {
      job.abort.abort();
    }
    this.running.clear();
    logger.info('定时调度器已停止');
  }

  async catchUp(): Promise<void> {
    const now = Date.now();
    const missed = this.db.prepare(
      `SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at < ?`,
    ).all(now) as ScheduledTaskRow[];

    if (missed.length === 0) return;
    logger.info({ count: missed.length }, '发现漏报任务，逐个补执行');

    for (const task of missed) {
      await this.executeJob(task);
    }
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const dueTasks = this.db.prepare(
        `SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`,
      ).all(now) as ScheduledTaskRow[];

      for (const task of dueTasks) {
        if (this.running.has(task.id)) continue;
        this.executeJob(task).catch(err => {
          logger.error({ err, taskId: task.id }, '定时任务执行异常');
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  private async executeJob(task: ScheduledTaskRow): Promise<void> {
    const abort = new AbortController();
    const entry: RunningJob = { taskId: task.id, attempt: 0, startedAt: Date.now(), abort };
    this.running.set(task.id, entry);

    this.eventBus.emit('cron.fired', { taskId: task.id, description: task.description });

    try {
      await this.retryWithBackoff(async (attempt) => {
        entry.attempt = attempt;
        const output = await this.runJobOnce(task, abort.signal);
        this.eventBus.emit('cron.completed', { taskId: task.id, output });
        metrics.counter('cron_executions_total').inc({ status: 'completed' });
        metrics.histogram('cron_duration_ms').observe(Date.now() - entry.startedAt, { task_id: task.id });
        await this.deliver(task, output);
      }, task.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ taskId: task.id, error: message }, '定时任务最终失败');
      metrics.counter('cron_executions_total').inc({ status: 'failed' });
      metrics.histogram('cron_duration_ms').observe(Date.now() - entry.startedAt, { task_id: task.id });
      this.eventBus.emit('cron.failed', { taskId: task.id, error: message, attempt: entry.attempt });
    } finally {
      this.advanceNextRun(task, Date.now());
      this.running.delete(task.id);
    }
  }

  private async runJobOnce(task: ScheduledTaskRow, signal: AbortSignal): Promise<string> {
    let scriptOutput = '';
    let wakeAgent = true;

    if (task.script) {
      const blockResult = checkBlocklist(task.script);
      if (blockResult.blocked) {
        throw new CronExecutionError(`脚本被安全策略阻止: ${blockResult.reason}`, task.id);
      }
      const result = await this.runScript(task.script, task.workdir ?? undefined, signal);
      if (!result.ok) {
        throw new CronExecutionError(`脚本执行失败: ${result.output}`, task.id);
      }
      scriptOutput = this.truncate(result.output);
      wakeAgent = result.wakeAgent;
    }

    if (!wakeAgent) return scriptOutput || '(WakeGate: agent skipped)';

    if (task.prompt) {
      const prompt = this.buildPrompt(task, scriptOutput);
      const llmOutput = await this.runLlm(prompt, signal);
      return this.truncate(llmOutput);
    }

    return scriptOutput || '(no prompt configured)';
  }

  private buildPrompt(task: ScheduledTaskRow, scriptOutput: string): string {
    const parts: string[] = [];

    if (task.skill_name) {
      const content = this.skillLoader.getContent(task.skill_name);
      if (content) parts.push(content);
    }

    if (scriptOutput) {
      parts.push(`## Script Output\n\`\`\`\n${scriptOutput}\n\`\`\``);
    }

    parts.push(task.prompt!);
    return parts.join('\n\n');
  }

  private runScript(cmd: string, cwd?: string, signal?: AbortSignal): Promise<ScriptResult> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve({ ok: false, output: 'Aborted', wakeAgent: true });
        return;
      }

      const child = exec(cmd, {
        timeout: this.config.scriptTimeoutMs,
        cwd: cwd || undefined,
        maxBuffer: 1024 * 1024,
      }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, output: stderr || err.message, wakeAgent: true });
          return;
        }

        let wakeAgent = true;
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1]?.trim();
        if (lastLine) {
          try {
            const gate = JSON.parse(lastLine);
            if (gate && typeof gate.wakeAgent === 'boolean') {
              wakeAgent = gate.wakeAgent;
            }
          } catch { /* not JSON, ignore */ }
        }

        resolve({ ok: true, output: stdout.trim(), wakeAgent });
      });

      if (signal) {
        const onAbort = () => child.kill();
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  private async runLlm(prompt: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new CronExecutionError('Aborted'));
        return;
      }

      const timer = setTimeout(() => {
        reject(new CronExecutionError('LLM 执行超时'));
      }, this.config.defaultTimeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        reject(new CronExecutionError('Aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      this.llm.chat(
        [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        { system: '你是一个定时任务执行引擎。执行给定的任务并返回结果摘要。' },
      ).then(result => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(result.content || '(empty response)');
      }).catch(err => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(new CronExecutionError(err instanceof Error ? err.message : String(err)));
      });
    });
  }

  private async deliver(task: ScheduledTaskRow, output: string): Promise<void> {
    if (!task.delivery_channel || !output) return;
    logger.debug({ taskId: task.id, channel: task.delivery_channel }, '投递任务结果');
  }

  private async retryWithBackoff(
    fn: (attempt: number) => Promise<void>,
    taskId: string,
  ): Promise<void> {
    const delays = this.config.retryDelaysMs;
    const maxAttempts = this.config.retryAttempts;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await fn(attempt);
        return;
      } catch (err) {
        const isRetryable = err instanceof CronExecutionError && err.retryable;
        if (!isRetryable || attempt >= maxAttempts) throw err;

        const delay = delays[attempt - 1] ?? delays[delays.length - 1];
        logger.warn({ taskId, attempt, delay }, '定时任务重试');
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  private truncate(s: string): string {
    if (s.length <= this.config.maxOutputChars) return s;
    return s.slice(0, this.config.maxOutputChars) + '\n...(输出被截断)';
  }

  private advanceNextRun(task: ScheduledTaskRow, now: number): void {
    if (isOneShot(task.cron)) {
      this.db.prepare(
        `UPDATE scheduled_tasks SET enabled = 0, last_run_at = ? WHERE id = ?`,
      ).run(now, task.id);
      return;
    }

    const nextRun = computeNextRun(task.cron, now);
    this.db.prepare(
      `UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ? WHERE id = ?`,
    ).run(now, nextRun, task.id);
  }
}

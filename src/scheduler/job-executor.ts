import { exec } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { LlmClient } from '../llm/index.js';
import type { ISkillLoader } from '../skills/contract.js';
import type { EventBus } from '../contracts/infrastructure.js';
import type { TaskManager } from '../kernel/task-manager.js';
import type { CronJobRow, JobQueueRow, ExecutionMode } from './contracts.js';
import { checkBlocklist } from '../safety/index.js';
import { getLogger } from '../utils/logger.js';
import { metrics } from '../observability/metrics.js';
import { genId } from '../utils/id.js';

const logger = getLogger('job-executor');

export interface JobExecutorDeps {
  db: Database.Database;
  llm: LlmClient;
  skillLoader: ISkillLoader;
  eventBus: EventBus;
  taskManager: TaskManager;
}

export interface ExecutionResult {
  ok: boolean;
  output: string;
  durationMs: number;
}

export interface JobExecutorConfig {
  defaultTimeoutMs: number;
  scriptTimeoutMs: number;
  maxOutputChars: number;
}

const DEFAULT_CONFIG: JobExecutorConfig = {
  defaultTimeoutMs: 60_000,
  scriptTimeoutMs: 30_000,
  maxOutputChars: 8_000,
};

export class JobExecutor {
  private readonly db: Database.Database;
  private readonly llm: LlmClient;
  private readonly skillLoader: ISkillLoader;
  private readonly eventBus: EventBus;
  private readonly taskManager: TaskManager;
  private readonly config: JobExecutorConfig;

  constructor(deps: JobExecutorDeps, config: Partial<JobExecutorConfig> = {}) {
    this.db = deps.db;
    this.llm = deps.llm;
    this.skillLoader = deps.skillLoader;
    this.eventBus = deps.eventBus;
    this.taskManager = deps.taskManager;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async execute(queueItem: JobQueueRow, job: CronJobRow, signal: AbortSignal): Promise<ExecutionResult> {
    const startedAt = Date.now();

    if (job.execution_mode === 'create_task') {
      return this.executeViaTaskManager(queueItem, job, startedAt);
    }

    return this.executeInline(queueItem, job, signal, startedAt);
  }

  private async executeViaTaskManager(queueItem: JobQueueRow, job: CronJobRow, startedAt: number): Promise<ExecutionResult> {
    const taskId = this.taskManager.create({
      sessionId: genId('ses'),
      correlationId: queueItem.id,
      taskType: 'scheduled_job',
      requester: 'scheduler',
      targetAgent: job.agent_id as any,
      foreground: false,
      priority: queueItem.priority,
      inputPayload: {
        prompt: job.prompt,
        jobId: job.id,
        queueItemId: queueItem.id,
        payload: JSON.parse(queueItem.payload || '{}'),
      },
    });

    const durationMs = Date.now() - startedAt;
    logger.debug({ taskId, jobId: job.id }, 'Scheduled job dispatched via TaskManager');

    return {
      ok: true,
      output: `Task created: ${taskId}`,
      durationMs,
    };
  }

  private async executeInline(queueItem: JobQueueRow, job: CronJobRow, signal: AbortSignal, startedAt: number): Promise<ExecutionResult> {
    try {
      const payload = JSON.parse(queueItem.payload || '{}') as Record<string, unknown>;
      let scriptOutput = '';
      let wakeAgent = true;

      const script = payload.script as string | undefined;
      const workdir = payload.workdir as string | undefined;

      if (script) {
        const blockResult = checkBlocklist(script);
        if (blockResult.blocked) {
          return { ok: false, output: `Script blocked: ${blockResult.reason}`, durationMs: Date.now() - startedAt };
        }
        const result = await this.runScript(script, workdir, signal);
        if (!result.ok) {
          return { ok: false, output: `Script failed: ${result.output}`, durationMs: Date.now() - startedAt };
        }
        scriptOutput = this.truncate(result.output);
        wakeAgent = result.wakeAgent;
      }

      if (!wakeAgent) {
        return { ok: true, output: scriptOutput || '(WakeGate: agent skipped)', durationMs: Date.now() - startedAt };
      }

      if (job.prompt) {
        const prompt = this.buildPrompt(job.prompt, scriptOutput, payload.skillName as string | undefined);
        const llmOutput = await this.runLlm(prompt, signal);
        return { ok: true, output: this.truncate(llmOutput), durationMs: Date.now() - startedAt };
      }

      return { ok: true, output: scriptOutput || '(no prompt configured)', durationMs: Date.now() - startedAt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, output: message, durationMs: Date.now() - startedAt };
    }
  }

  private buildPrompt(prompt: string, scriptOutput: string, skillName?: string): string {
    const parts: string[] = [];

    if (skillName) {
      const content = this.skillLoader.getContent(skillName);
      if (content) parts.push(content);
    }

    if (scriptOutput) {
      parts.push(`## Script Output\n\`\`\`\n${scriptOutput}\n\`\`\``);
    }

    parts.push(prompt);
    return parts.join('\n\n');
  }

  private runScript(cmd: string, cwd?: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string; wakeAgent: boolean }> {
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
          } catch { /* not JSON gate */ }
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
        reject(new Error('Aborted'));
        return;
      }

      const timer = setTimeout(() => {
        reject(new Error('LLM execution timeout'));
      }, this.config.defaultTimeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
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
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private truncate(s: string): string {
    if (s.length <= this.config.maxOutputChars) return s;
    return s.slice(0, this.config.maxOutputChars) + '\n...(输出被截断)';
  }
}

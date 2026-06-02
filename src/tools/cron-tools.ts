import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import { computeNextRun } from '../cron/parser.js';
import { genId } from '../utils/id.js';
import type Database from 'better-sqlite3';
import type { ScheduledTaskRow } from '../cron/types.js';

let dbRef: Database.Database | null = null;

export function setCronToolsDb(db: Database.Database): void {
  dbRef = db;
}

function getDb(): Database.Database {
  if (!dbRef) throw new Error('Cron tools DB not initialized — call setCronToolsDb first');
  return dbRef;
}

const cronCreateSchema = z.object({
  schedule: z.string().describe('cron 表达式（如 "0 9 * * *" = 每天 9 点）'),
  prompt: z.string().describe('定时执行的 prompt 内容'),
  description: z.string().optional().default('').describe('任务描述'),
});

const cronDeleteSchema = z.object({
  id: z.string().describe('任务 ID'),
});

const cronListSchema = z.object({});

export const cronCreateTool: ToolDefinition = {
  name: 'cron_create',
  description: '创建定时任务。到时后自动投递 prompt 给 Agent 执行。',
  inputSchema: cronCreateSchema,
  dangerLevel: 'moderate',
  async execute(input: unknown): Promise<ToolResult> {
    const { schedule, prompt, description } = cronCreateSchema.parse(input);

    try {
      const nextRun = computeNextRun(schedule, Date.now());
      if (!nextRun) {
        return { content: `无效 cron 表达式: ${schedule}`, isError: true };
      }

      const db = getDb();
      const id = genId();
      db.prepare(
        `INSERT INTO scheduled_tasks (id, cron, description, prompt, enabled, next_run_at, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      ).run(id, schedule, description, prompt, nextRun, Date.now());

      return {
        content: `定时任务已创建\n  ID: ${id}\n  调度: ${schedule}\n  下次执行: ${new Date(nextRun).toLocaleString()}\n  描述: ${description || '(无)'}`,
      };
    } catch (err) {
      return { content: `创建定时任务失败: ${(err as Error).message}`, isError: true };
    }
  },
};

export const cronDeleteTool: ToolDefinition = {
  name: 'cron_delete',
  description: '删除定时任务。',
  inputSchema: cronDeleteSchema,
  dangerLevel: 'moderate',
  async execute(input: unknown): Promise<ToolResult> {
    const { id } = cronDeleteSchema.parse(input);

    try {
      const db = getDb();
      const result = db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(id);
      if (result.changes === 0) {
        return { content: `未找到任务: ${id}`, isError: true };
      }
      return { content: `已删除定时任务: ${id}` };
    } catch (err) {
      return { content: `删除失败: ${(err as Error).message}`, isError: true };
    }
  },
};

export const cronListTool: ToolDefinition = {
  name: 'cron_list',
  description: '列出所有定时任务。',
  inputSchema: cronListSchema,
  dangerLevel: 'safe',
  async execute(_input: unknown): Promise<ToolResult> {
    try {
      const db = getDb();
      const tasks = db.prepare(
        `SELECT id, cron, description, prompt, enabled, last_run_at, next_run_at FROM scheduled_tasks ORDER BY created_at DESC`,
      ).all() as ScheduledTaskRow[];

      if (tasks.length === 0) {
        return { content: '无定时任务' };
      }

      const lines = tasks.map(t => {
        const status = t.enabled ? '✓' : '✗';
        const lastRun = t.last_run_at ? new Date(t.last_run_at).toLocaleString() : '从未';
        const nextRun = t.next_run_at ? new Date(t.next_run_at).toLocaleString() : '-';
        return `${status} ${t.id}  ${t.cron}  "${t.description || t.prompt?.slice(0, 30) || '?'}"  上次: ${lastRun}  下次: ${nextRun}`;
      });

      return { content: `定时任务 (${tasks.length}):\n${lines.join('\n')}` };
    } catch (err) {
      return { content: `列出失败: ${(err as Error).message}`, isError: true };
    }
  },
};

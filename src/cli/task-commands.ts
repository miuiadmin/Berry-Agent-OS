import type { Command } from 'commander';
import Database from 'better-sqlite3';
import { getDbPath } from '../utils/paths.js';
import { getConsoleRenderer } from '../observability/console.js';
import { TaskLifecycle } from '../kernel/task-lifecycle.js';
import { EventBus } from '../kernel/event-bus.js';

function withDb<T>(fn: (db: Database.Database) => T): T {
  const dbPath = getDbPath();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function registerTaskCommands(program: Command): void {
  const task = program.command('task').description('管理后台任务');

  task
    .command('list')
    .description('列出后台任务')
    .option('--session <id>', '按会话过滤')
    .option('--all', '包括已完成的任务')
    .option('--json', 'JSON 格式输出')
    .action((opts: { session?: string; all?: boolean; json?: boolean }) => {
      const renderer = getConsoleRenderer();
      if (opts.json) renderer.setMode('json');

      withDb(db => {
        const eventBus = new EventBus();
        const lifecycle = new TaskLifecycle(db, eventBus);

        let sql = `SELECT id, task_type, target_agent, status, visibility, notify_state, started_at, finished_at, session_id
                   FROM agent_tasks WHERE 1=1`;
        const params: unknown[] = [];

        if (opts.session) {
          sql += ' AND session_id = ?';
          params.push(opts.session);
        }

        if (!opts.all) {
          sql += " AND status NOT IN ('completed','failed','timeout','cancelled')";
        }

        sql += ' ORDER BY created_at DESC LIMIT 50';

        const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

        if (opts.json) {
          renderer.json(rows.map(row => ({
            taskId: row.id,
            taskType: row.task_type,
            targetAgent: row.target_agent,
            status: row.status,
            visibility: row.visibility ?? 'foreground',
            notifyState: row.notify_state ?? 'none',
            sessionId: row.session_id,
          })));
        } else {
          if (rows.length === 0) {
            renderer.info('暂无任务');
            return;
          }
          for (const row of rows) {
            const vis = row.visibility ?? 'foreground';
            const notify = row.notify_state === 'pending' ? ' [待通知]' : '';
            renderer.info(`${row.id} | ${row.task_type} → ${row.target_agent} | ${row.status} | ${vis}${notify}`);
          }
        }
      });
    });

  task
    .command('show <taskId>')
    .description('查看任务详情')
    .option('--json', 'JSON 格式输出')
    .action((taskId: string, opts: { json?: boolean }) => {
      const renderer = getConsoleRenderer();
      if (opts.json) renderer.setMode('json');

      withDb(db => {
        const row = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
        if (!row) {
          renderer.error(`任务不存在: ${taskId}`);
          return;
        }

        if (opts.json) {
          renderer.json({
            taskId: row.id,
            taskType: row.task_type,
            targetAgent: row.target_agent,
            status: row.status,
            visibility: row.visibility ?? 'foreground',
            notifyState: row.notify_state ?? 'none',
            sessionId: row.session_id,
            createdAt: row.created_at,
            startedAt: row.started_at,
            finishedAt: row.finished_at,
            backgroundedAt: row.backgrounded_at,
            error: row.error,
          });
        } else {
          renderer.info(`任务: ${row.id}`);
          renderer.info(`  类型: ${row.task_type} → ${row.target_agent}`);
          renderer.info(`  状态: ${row.status}`);
          renderer.info(`  可见性: ${row.visibility ?? 'foreground'}`);
          renderer.info(`  通知: ${row.notify_state ?? 'none'}`);
          if (row.error) renderer.error(`  错误: ${row.error}`);
        }
      });
    });

  task
    .command('stop <taskId>')
    .description('停止运行中的任务')
    .option('--reason <text>', '停止原因')
    .option('--json', 'JSON 格式输出')
    .action((taskId: string, opts: { reason?: string; json?: boolean }) => {
      const renderer = getConsoleRenderer();
      if (opts.json) renderer.setMode('json');

      withDb(db => {
        const eventBus = new EventBus();
        const lifecycle = new TaskLifecycle(db, eventBus);
        lifecycle.stop(taskId, opts.reason);

        if (opts.json) {
          renderer.json({ taskId, action: 'stopped', reason: opts.reason ?? '用户停止' });
        } else {
          renderer.info(`已停止任务: ${taskId}`);
        }
      });
    });

  task
    .command('resume <taskId>')
    .description('将后台任务恢复为前台')
    .option('--json', 'JSON 格式输出')
    .action((taskId: string, opts: { json?: boolean }) => {
      const renderer = getConsoleRenderer();
      if (opts.json) renderer.setMode('json');

      withDb(db => {
        const eventBus = new EventBus();
        const lifecycle = new TaskLifecycle(db, eventBus);
        lifecycle.resume(taskId);

        if (opts.json) {
          renderer.json({ taskId, action: 'resumed' });
        } else {
          renderer.info(`已恢复任务: ${taskId}`);
        }
      });
    });

  task
    .command('notifications')
    .description('查看待处理的后台任务通知')
    .option('--session <id>', '按会话过滤')
    .option('--json', 'JSON 格式输出')
    .action((opts: { session?: string; json?: boolean }) => {
      const renderer = getConsoleRenderer();
      if (opts.json) renderer.setMode('json');

      withDb(db => {
        const eventBus = new EventBus();
        const lifecycle = new TaskLifecycle(db, eventBus);

        const sessionId = opts.session ?? 'default';
        const pending = lifecycle.getPendingNotifications(sessionId);

        if (opts.json) {
          renderer.json(pending);
        } else {
          if (pending.length === 0) {
            renderer.info('暂无待处理通知');
            return;
          }
          for (const t of pending) {
            renderer.info(`${t.taskId} | ${t.taskType} → ${t.targetAgent} | ${t.status} | ${t.summary ?? ''}`);
          }
        }
      });
    });
}

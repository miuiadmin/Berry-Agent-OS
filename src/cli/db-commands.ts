import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Command } from 'commander';
import { getDbPath } from '../utils/paths.js';
import { getConsoleRenderer } from '../observability/console.js';

export function registerDbCommands(program: Command): void {
  const db = program.command('db').description('数据库查询（只读）');

  db
    .command('query <sql>')
    .description('执行只读 SQL 查询')
    .option('--json', '以 JSON 格式输出')
    .action((sql: string, opts) => {
      const renderer = getConsoleRenderer();
      const dbPath = getDbPath();
      if (!existsSync(dbPath)) {
        renderer.error('数据库文件不存在，请先启动服务');
        process.exit(40);
      }

      const conn = new Database(dbPath, { readonly: true });
      try {
        const normalized = sql.trim().toLowerCase();
        if (!normalized.startsWith('select') && !normalized.startsWith('pragma') && !normalized.startsWith('explain')) {
          renderer.error('只允许 SELECT / PRAGMA / EXPLAIN 查询');
          process.exit(2);
        }

        const rows = conn.prepare(sql).all();
        if (opts.json) {
          renderer.json(rows);
        } else {
          if (rows.length === 0) {
            renderer.info('(无结果)');
            return;
          }
          const cols = Object.keys(rows[0] as Record<string, unknown>);
          renderer.info(cols.join('\t'));
          for (const row of rows) {
            const r = row as Record<string, unknown>;
            renderer.info(cols.map(c => String(r[c] ?? '')).join('\t'));
          }
        }
      } catch (err) {
        renderer.error(`查询失败: ${(err as Error).message}`);
        process.exit(40);
      } finally {
        conn.close();
      }
    });

  db
    .command('tables')
    .description('列出所有表')
    .option('--json', '以 JSON 格式输出')
    .action((opts) => {
      const renderer = getConsoleRenderer();
      const dbPath = getDbPath();
      if (!existsSync(dbPath)) {
        renderer.error('数据库文件不存在');
        process.exit(40);
      }

      const conn = new Database(dbPath, { readonly: true });
      try {
        const rows = conn.prepare(
          "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name"
        ).all() as Array<{ name: string; type: string }>;

        if (opts.json) {
          renderer.json(rows);
        } else {
          for (const row of rows) {
            renderer.info(`${row.type.padEnd(6)} ${row.name}`);
          }
        }
      } finally {
        conn.close();
      }
    });

  db
    .command('schema [table]')
    .description('查看表结构')
    .option('--json', '以 JSON 格式输出')
    .action((table: string | undefined, opts) => {
      const renderer = getConsoleRenderer();
      const dbPath = getDbPath();
      if (!existsSync(dbPath)) {
        renderer.error('数据库文件不存在');
        process.exit(40);
      }

      const conn = new Database(dbPath, { readonly: true });
      try {
        if (table) {
          const info = conn.prepare(`PRAGMA table_info('${table.replace(/'/g, "''")}')`).all() as Array<{
            cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
          }>;

          if (info.length === 0) {
            renderer.error(`表 ${table} 不存在`);
            process.exit(2);
          }

          if (opts.json) {
            renderer.json({ table, columns: info });
          } else {
            renderer.info(`表: ${table}`);
            renderer.info('---');
            for (const col of info) {
              const pk = col.pk ? ' PK' : '';
              const nn = col.notnull ? ' NOT NULL' : '';
              const dflt = col.dflt_value ? ` DEFAULT ${col.dflt_value}` : '';
              renderer.info(`  ${col.name} ${col.type}${pk}${nn}${dflt}`);
            }
          }
        } else {
          const tables = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
          ).all() as Array<{ name: string }>;

          const schemas: Record<string, unknown[]> = {};
          for (const t of tables) {
            schemas[t.name] = conn.prepare(`PRAGMA table_info('${t.name}')`).all();
          }

          if (opts.json) {
            renderer.json(schemas);
          } else {
            for (const [name, cols] of Object.entries(schemas)) {
              renderer.info(`\n表: ${name}`);
              for (const col of cols as Array<{ name: string; type: string }>) {
                renderer.info(`  ${col.name} ${col.type}`);
              }
            }
          }
        }
      } finally {
        conn.close();
      }
    });
}

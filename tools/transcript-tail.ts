#!/usr/bin/env tsx
/**
 * 15.0 存储层 #6：transcript-tail — tail -f 指定会话的对话流（dev/SRE 调试工具）。
 *
 * 用法：
 *   npx tsx tools/transcript-tail.ts --session=<id> [--follow] [--lines=50]
 *
 * 设计：直接只读打开 memory.db，先 dump 最近 N 条，--follow 时每秒轮询新行（rowid > 上次）。
 * 不订阅进程内 EventBus（独立 CLI 无法接入），用 DB 轮询实现等价 tail -f。
 * SQLite 仍是事实源，本工具只读、不影响业务。
 *
 * 输出：JSONL（每行一条 {rowid, role, content, createdAt}），可被 jq / grep 管道处理。
 */
import Database from 'better-sqlite3';
import { getDbPath } from '../src/utils/paths.js';

interface Args {
  session: string | null;
  follow: boolean;
  lines: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { session: null, follow: false, lines: 50 };
  for (const a of argv.slice(2)) {
    if (a === '--follow' || a === '-f') args.follow = true;
    else if (a.startsWith('--session=')) args.session = a.slice('--session='.length);
    else if (a.startsWith('--lines=')) args.lines = parseInt(a.slice('--lines='.length), 10) || 50;
    else if (a === '--help' || a === '-h') {
      process.stdout.write('用法: transcript-tail --session=<id> [--follow] [--lines=50]\n');
      process.exit(0);
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv);
  if (!args.session) {
    process.stderr.write('错误：缺少 --session=<id>\n');
    process.stderr.write('用法: npx tsx tools/transcript-tail.ts --session=<id> [--follow] [--lines=50]\n');
    process.exit(1);
  }

  // 只读打开，避免任何写副作用；WAL 模式下只读连接可并发安全读取
  const db = new Database(getDbPath(), { readonly: true });
  const fetchSince = db.prepare(
    `SELECT rowid, role, content, created_at FROM conversations
     WHERE session_id = ? AND rowid > ?
     ORDER BY rowid ASC`,
  );

  let lastRowid = 0;

  // 初始 dump：取最近 N 条（先查全部最近 N，记下最大 rowid 作为 tail 起点）
  const recent = db
    .prepare(
      `SELECT rowid, role, content, created_at FROM conversations
       WHERE session_id = ? ORDER BY rowid DESC LIMIT ?`,
    )
    .all(args.session, args.lines) as Array<{ rowid: number; role: string; content: string; created_at: number }>;

  for (const row of recent.reverse()) {
    process.stdout.write(JSON.stringify(row) + '\n');
    lastRowid = Math.max(lastRowid, row.rowid);
  }

  if (!args.follow) {
    db.close();
    return;
  }

  // tail：每秒轮询 rowid > lastRowid 的新行
  process.stderr.write(`[transcript-tail] 跟随 session=${args.session}，Ctrl+C 退出...\n`);
  setInterval(() => {
    try {
      const fresh = fetchSince.all(args.session, lastRowid) as Array<{ rowid: number; role: string; content: string; created_at: number }>;
      for (const row of fresh) {
        process.stdout.write(JSON.stringify(row) + '\n');
        lastRowid = row.rowid;
      }
    } catch (err) {
      process.stderr.write(`[transcript-tail] 轮询出错: ${(err as Error).message}\n`);
    }
  }, 1000);
}

main();

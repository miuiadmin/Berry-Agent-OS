import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getDbPath } from '../utils/paths.js';
import { runMigrations } from './migration-runner.js';
import { ALL_MIGRATIONS } from './migrations/index.js';
import { CORE_INDEX_SQL, CORE_SCHEMA_SQL, KNOWLEDGE_FTS_SQL } from './schema.js';

let db: Database.Database | null = null;

export function initDb(path?: string): Database.Database {
  const dbPath = path ?? getDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  // 15.0 存储层加固：WAL checkpoint 策略。
  // SQLite 默认 wal_autocheckpoint=1000（~4MB）已能防止 .db-wal 单调膨胀（满足 <10MB 验收线）；
  // 这里显式设为 500（~2MB）让 PASSIVE checkpoint 更频繁更小，降低单次 checkpoint 停顿。
  // **不引入应用层写计数器 + jitter**：busy_timeout=5000 让 SQLite 内部用 usleep 指数退避
  // （不烧 CPU）最多等 5s，已比 Hermes 的 1s timeout+2.25s jitter 更强地覆盖写竞争；
  // 用内建机制即满足需求，符合「架构优雅：已有机制优先」（参见 设计文档/21-架构升级-15.0.md §6/§7）。
  db.pragma('wal_autocheckpoint = 500');

  db.exec(CORE_SCHEMA_SQL);
  runMigrations(db, ALL_MIGRATIONS);
  db.exec(CORE_INDEX_SQL);
  db.exec(KNOWLEDGE_FTS_SQL);
  db.prepare(`INSERT INTO knowledge_fts(knowledge_fts) VALUES ('rebuild')`).run();

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

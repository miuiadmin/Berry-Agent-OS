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
  // 15.0 修复：CORE_INDEX_SQL（含 dialogue_messages/agent_chat_messages/brain_observations/
  // agent_tool_calls/intent_anchors 等表）必须在 runMigrations 之前执行——否则 v17(redact
  // 历史扫描)/v18(FTS 触发器)/v19(redact 扩展扫描) 在迁移期间引用这些表会「表不存在」
  // （v18 直接崩溃；v17/v19 静默跳过大部分目标表，redact 实际只清洗了 conversations）。
  db.exec(CORE_INDEX_SQL);
  runMigrations(db, ALL_MIGRATIONS);
  db.exec(KNOWLEDGE_FTS_SQL);
  // 15.0 §5.3 启动自愈：所有 FTS 表行数与源表不一致（触发器遗漏/刚创建/索引损坏/运维清表）
  // 时才 rebuild。FTS5 COUNT(*) 是 O(1)，开销可忽略。修复前仅 knowledge_fts 有此保护，
  // conversations/dialogue/agent_chat 三表无启动自愈——索引损坏会静默「搜不到」。
  // 表可能因旧库/部分迁移缺失，用 try/catch 容错跳过。
  ensureFtsConsistency(db, 'knowledge_fts', 'knowledge');
  ensureFtsConsistency(db, 'conversations_fts', 'conversations');
  ensureFtsConsistency(db, 'dialogue_messages_fts', 'dialogue_messages');
  ensureFtsConsistency(db, 'agent_chat_messages_fts', 'agent_chat_messages');

  return db;
}

/**
 * 15.0 §5.3：FTS 启动自愈。external-content FTS 表的行数应与源表一致（触发器维护）；
 * 不一致（损坏/遗漏/刚创建）则 rebuild 从源表重读。FTS5 `COUNT(*)` 为 O(1)。
 * 表/源不存在时静默跳过（旧库或部分迁移）。
 */
function ensureFtsConsistency(db: Database.Database, fts: string, source: string): void {
  try {
    const ftsCount = (db.prepare(`SELECT COUNT(*) AS c FROM ${fts}`).get() as { c: number }).c;
    const srcCount = (db.prepare(`SELECT COUNT(*) AS c FROM ${source}`).get() as { c: number }).c;
    if (ftsCount !== srcCount) {
      db.prepare(`INSERT INTO ${fts}(${fts}) VALUES ('rebuild')`).run();
    }
  } catch {
    // FTS 虚表或源表不存在（旧库 / 迁移未跑）—— 静默跳过
  }
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

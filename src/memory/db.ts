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

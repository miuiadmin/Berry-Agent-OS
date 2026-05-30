import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import { createHash } from 'node:crypto';

const logger = getLogger('migration-runner');

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
  down?: (db: Database.Database) => void;
}

interface AppliedMigration {
  version: number;
  name: string;
  applied_at: number;
  checksum: string;
}

function computeChecksum(migration: Migration): string {
  const source = migration.up.toString();
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      checksum TEXT NOT NULL
    )
  `);
}

function getAppliedMigrations(db: Database.Database): AppliedMigration[] {
  return db.prepare('SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version').all() as AppliedMigration[];
}

function getMaxVersion(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(version) as max_v FROM schema_migrations').get() as { max_v: number | null };
  return row.max_v ?? -1;
}

export function runMigrations(db: Database.Database, migrations: Migration[]): { applied: number; skipped: number } {
  ensureMigrationsTable(db);

  const maxApplied = getMaxVersion(db);
  const pending = migrations
    .filter((m) => m.version > maxApplied)
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    return { applied: 0, skipped: migrations.length };
  }

  let applied = 0;
  for (const migration of pending) {
    const checksum = computeChecksum(migration);
    const tx = db.transaction(() => {
      migration.up(db);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
      ).run(migration.version, migration.name, Date.now(), checksum);
    });

    try {
      tx();
      applied++;
      logger.info({ version: migration.version, name: migration.name }, '迁移已应用');
    } catch (err) {
      logger.error({ version: migration.version, name: migration.name, err }, '迁移失败');
      throw err;
    }
  }

  return { applied, skipped: migrations.length - pending.length };
}

export function rollbackMigration(db: Database.Database, migrations: Migration[]): { rolledBack: string | null } {
  ensureMigrationsTable(db);

  const maxApplied = getMaxVersion(db);
  if (maxApplied < 0) return { rolledBack: null };

  const migration = migrations.find((m) => m.version === maxApplied);
  if (!migration) {
    logger.warn({ version: maxApplied }, '找不到对应的迁移定义，无法回滚');
    return { rolledBack: null };
  }
  if (!migration.down) {
    logger.warn({ version: maxApplied, name: migration.name }, '迁移无 down 方法，无法回滚');
    return { rolledBack: null };
  }

  const tx = db.transaction(() => {
    migration.down!(db);
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(maxApplied);
  });

  tx();
  logger.info({ version: migration.version, name: migration.name }, '迁移已回滚');
  return { rolledBack: migration.name };
}

export function getMigrationStatus(db: Database.Database, migrations: Migration[]): {
  applied: AppliedMigration[];
  pending: Array<{ version: number; name: string }>;
} {
  ensureMigrationsTable(db);
  const applied = getAppliedMigrations(db);
  const maxApplied = applied.length > 0 ? Math.max(...applied.map((a) => a.version)) : -1;
  const pending = migrations
    .filter((m) => m.version > maxApplied)
    .map((m) => ({ version: m.version, name: m.name }));
  return { applied, pending };
}

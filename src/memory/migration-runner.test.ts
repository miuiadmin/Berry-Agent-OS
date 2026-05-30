import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, rollbackMigration, getMigrationStatus, type Migration } from './migration-runner.js';

describe('MigrationRunner', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
  });

  afterEach(() => {
    db.close();
  });

  const testMigrations: Migration[] = [
    {
      version: 1,
      name: 'create-users',
      up: (d) => { d.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)'); },
      down: (d) => { d.exec('DROP TABLE users'); },
    },
    {
      version: 2,
      name: 'add-email',
      up: (d) => { d.exec('ALTER TABLE users ADD COLUMN email TEXT'); },
      down: (d) => {
        d.exec('CREATE TABLE users_tmp (id INTEGER PRIMARY KEY, name TEXT)');
        d.exec('INSERT INTO users_tmp SELECT id, name FROM users');
        d.exec('DROP TABLE users');
        d.exec('ALTER TABLE users_tmp RENAME TO users');
      },
    },
  ];

  it('applies all pending migrations on fresh database', () => {
    const result = runMigrations(db, testMigrations);
    expect(result.applied).toBe(2);
    expect(result.skipped).toBe(0);

    const cols = db.pragma('table_info(users)') as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('name');
    expect(colNames).toContain('email');
  });

  it('skips already applied migrations', () => {
    runMigrations(db, testMigrations);
    const result = runMigrations(db, testMigrations);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(2);
  });

  it('applies only new migrations incrementally', () => {
    runMigrations(db, [testMigrations[0]]);
    const result = runMigrations(db, testMigrations);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('rolls back the latest migration', () => {
    runMigrations(db, testMigrations);
    const result = rollbackMigration(db, testMigrations);
    expect(result.rolledBack).toBe('add-email');

    const cols = db.pragma('table_info(users)') as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).not.toContain('email');
  });

  it('returns null when no migration to roll back', () => {
    const result = rollbackMigration(db, testMigrations);
    expect(result.rolledBack).toBeNull();
  });

  it('reports migration status correctly', () => {
    runMigrations(db, [testMigrations[0]]);
    const status = getMigrationStatus(db, testMigrations);
    expect(status.applied).toHaveLength(1);
    expect(status.applied[0].name).toBe('create-users');
    expect(status.pending).toHaveLength(1);
    expect(status.pending[0].name).toBe('add-email');
  });

  it('throws and stops on migration failure', () => {
    const badMigrations: Migration[] = [
      { version: 1, name: 'ok', up: (d) => { d.exec('CREATE TABLE t1 (id INTEGER)'); } },
      { version: 2, name: 'bad', up: () => { throw new Error('intentional failure'); } },
      { version: 3, name: 'never', up: (d) => { d.exec('CREATE TABLE t2 (id INTEGER)'); } },
    ];

    expect(() => runMigrations(db, badMigrations)).toThrow('intentional failure');

    const status = getMigrationStatus(db, badMigrations);
    expect(status.applied).toHaveLength(1);
    expect(status.pending).toHaveLength(2);
  });
});

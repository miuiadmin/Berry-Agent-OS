import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDb } from './client.js';

export function runMigrations(dbPath: string) {
  const db = createDb(dbPath);
  migrate(db, { migrationsFolder: './src/db/migrations' });
}

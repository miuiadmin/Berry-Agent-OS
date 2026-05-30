import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDb } from '../db/client.js';
import { createModuleContainer } from '../modules/index.js';
import { startServer } from './index.js';
import { users } from '../db/schema/users.js';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Usage: standalone.ts <db-path>');
  process.exit(1);
}

const db = createDb(dbPath);

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../db/migrations');
migrate(db, { migrationsFolder });

const modules = createModuleContainer(db);

if (!modules.auth.getById('default-user')) {
  db.insert(users).values({
    id: 'default-user',
    email: 'user@local',
    name: 'Default User',
    passwordHash: 'local',
    avatar: null,
    createdAt: new Date(),
  }).run();
}

startServer(modules, 3888);

process.send?.({ type: 'ready', port: 3888 });
console.log('Server listening on http://localhost:3888');

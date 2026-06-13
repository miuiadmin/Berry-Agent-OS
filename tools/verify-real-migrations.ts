/**
 * 临时：在真实 DB 的【拷贝】上跑迁移，验证 v17/v18/v19 在真实数据上成功（非侵入）。
 * 不碰运行中的服务 DB。验证后删除。
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getDbPath } from '../src/utils/paths.js';
import { CORE_INDEX_SQL, CORE_SCHEMA_SQL, KNOWLEDGE_FTS_SQL } from '../src/memory/schema.js';
import { runMigrations } from '../src/memory/migration-runner.js';
import { ALL_MIGRATIONS } from '../src/memory/migrations/index.js';

const src = getDbPath();
console.log('源 DB:', src, existsSync(src) ? `(存在)` : '(不存在!)');

const dir = mkdtempSync(join(tmpdir(), 'berry-realdb-'));
const copy = join(dir, 'agent.db');
copyFileSync(src, copy);
// WAL/SHM 也拷（保证一致快照）；拷贝后用 DELETE journal 避免旧 WAL 干扰
for (const ext of ['-wal', '-shm']) {
  if (existsSync(src + ext)) copyFileSync(src + ext, copy + ext);
}

const db = new Database(copy);
db.pragma('journal_mode = DELETE'); // 切换出 WAL，干净状态
const beforeMax = (db.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as {v:number}).v;
console.log('拷贝前已应用最大迁移版本:', beforeMax);

// 模拟修复后的 initDb 顺序：CORE_SCHEMA → CORE_INDEX → migrations → KNOWLEDGE_FTS
db.exec(CORE_SCHEMA_SQL);
db.exec(CORE_INDEX_SQL);
try {
  const { applied } = runMigrations(db, ALL_MIGRATIONS);
  console.log(`迁移成功，本次应用 ${applied} 条`);
} catch (err) {
  console.log('❌ 迁移失败:', (err as Error).message);
  db.close(); rmSync(dir, { recursive: true, force: true }); process.exit(1);
}
db.exec(KNOWLEDGE_FTS_SQL);

const afterMax = (db.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as {v:number}).v;
console.log('迁移后最大版本:', afterMax, `(应 = ${ALL_MIGRATIONS[ALL_MIGRATIONS.length-1].version})`);

// 验证 v18 FTS 表在真实数据上建立
const fts = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all() as {name:string}[]).map(x=>x.name);
console.log('FTS 表:', fts.join(', '));
// FTS 行数（真实数据是否被索引）
for (const t of ['conversations_fts', 'dialogue_messages_fts', 'agent_chat_messages_fts']) {
  if (fts.includes(t)) {
    const c = (db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as {c:number}).c;
    console.log(`  ${t}: ${c} 行`);
  }
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log('\n✅ 真实数据迁移验证完成（拷贝已清理）');

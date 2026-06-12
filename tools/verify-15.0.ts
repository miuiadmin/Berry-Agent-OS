/**
 * 15.0 运行时验证脚本（临时，验证后删除）：
 * 对临时 DB 跑完整 initDb（CORE_SCHEMA + 全部 migration v0-v19），验证：
 * 1. 启动无迁移错误
 * 2. FTS 虚表 + 触发器建立（conversations_fts / dialogue_messages_fts / agent_chat_messages_fts + update 触发器）
 * 3. auditor agent.json 合法可加载
 * 4. runAudit 在真实 schema 上跑通
 * 5. routeReviewTarget / parsePermissionJudge 等新逻辑可 import
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, getDb } from '../src/memory/index.js';
import { ALL_MIGRATIONS } from '../src/memory/migrations/index.js';
import { runAudit } from '../src/agents/bundled/auditor/scan.js';
import { routeReviewTarget } from '../src/kernel/flows/permission-flow.js';
import { parsePermissionJudge, parseCheckpointResult } from '../src/agents/bundled/brain/prompts.js';

const dir = mkdtempSync(join(tmpdir(), 'berry-verify-'));
const dbPath = join(dir, 'verify.db');
let ok = true;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) ok = false;
};

try {
  // 1. 完整 initDb（跑 CORE_SCHEMA + runMigrations(ALL_MIGRATIONS)）
  initDb(dbPath);
  check('initDb 成功（全部 migration v0-v19 无错误）', true);
  check(`ALL_MIGRATIONS 含 v17/v18/v19`, ALL_MIGRATIONS.some(m => m.version === 17) && ALL_MIGRATIONS.some(m => m.version === 18) && ALL_MIGRATIONS.some(m => m.version === 19));

  const db = getDb();
  const tableExists = (t: string) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
  const triggerExists = (t: string) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`).get(t);

  // 2. FTS 虚表
  check('conversations_fts 虚表存在', tableExists('conversations_fts'));
  check('dialogue_messages_fts 虚表存在', tableExists('dialogue_messages_fts'));
  check('agent_chat_messages_fts 虚表存在', tableExists('agent_chat_messages_fts'));
  // 触发器（含 v18 补的 conversations_fts_update）
  check('conversations_fts_update 触发器存在（v18 补齐）', triggerExists('conversations_fts_update'));
  check('dialogue_messages_fts_insert/delete/update 触发器齐全', triggerExists('dialogue_messages_fts_insert') && triggerExists('dialogue_messages_fts_delete') && triggerExists('dialogue_messages_fts_update'));

  // 3. FTS 端到端：插入 + 搜索
  db.prepare(`INSERT INTO conversations (id, session_id, role, content, created_at) VALUES (?,?,?,?,?)`).run('m1', 's1', 'user', '项目管理最佳实践讨论', Date.now());
  const ftsHit = db.prepare(`SELECT c.content FROM conversations c JOIN conversations_fts f ON c.rowid=f.rowid WHERE conversations_fts MATCH ?`).all('"项目管理"') as Array<{content:string}>;
  check('FTS 插入后可搜索（中文短语）', ftsHit.length === 1 && ftsHit[0].content.includes('项目管理'));

  // 4. runAudit 在真实 schema 上跑通
  const report = runAudit(db);
  check('runAudit 在真实 schema 跑通（riskScore ∈ [0,1]）', report.riskScore >= 0 && report.riskScore <= 1);

  // 5. 新逻辑可 import + 行为正确
  check("routeReviewTarget('moderate','ask')='brain'（机制A L2→Brain）", routeReviewTarget('moderate', 'ask') === 'brain');
  check("routeReviewTarget('dangerous','yolo')='brain'（yolo L3→Brain）", routeReviewTarget('dangerous', 'yolo') === 'brain');
  check("routeReviewTarget('dangerous','ask')='user'（ask L3→用户）", routeReviewTarget('dangerous', 'ask') === 'user');
  const pj = parsePermissionJudge('{"allowed":false,"uncertain":true,"escalationQuestion":"确认?","reason":"x"}');
  check('parsePermissionJudge uncertain→escalation（机制B）', pj.uncertain === true && pj.escalation?.source === 'approval');
  const cp = parseCheckpointResult('{"action":"continue","uncertain":true,"escalationQuestion":"卡住?","command":{"target":"code","type":"inspect"}}', 'd1');
  check('parseCheckpointResult uncertain+command 并存（机制B+D）', cp.escalation?.source === 'checkpoint' && cp.command?.target === 'code');

  // 6. auditor agent.json 合法
  const auditorJson = JSON.parse(readFileSync(join(process.cwd(), 'src/agents/bundled/auditor/agent.json'), 'utf-8'));
  check('auditor agent.json 合法（name/kind/taskTypes）', auditorJson.name === 'auditor' && auditorJson.kind === 'on-demand' && auditorJson.taskTypes?.includes('audit_scan'));

  closeDb();
} catch (err) {
  console.log(`❌ 异常: ${(err as Error).message}`);
  console.log((err as Error).stack);
  ok = false;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(ok ? '\n🎉 全部运行时验证通过' : '\n💥 存在失败项');
process.exit(ok ? 0 : 1);

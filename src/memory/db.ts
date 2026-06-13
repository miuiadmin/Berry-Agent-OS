import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getDbPath } from '../utils/paths.js';
import { runMigrations } from './migration-runner.js';
import { ALL_MIGRATIONS } from './migrations/index.js';
import { CORE_INDEX_SQL, CORE_SCHEMA_SQL, KNOWLEDGE_FTS_SQL, MESSAGE_BLOCKS_FTS_SQL } from './schema.js';

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
  // 对话内联模型 FTS（设计文档/22）：独立虚拟表，由 message-blocks-repo 维护（非 external-content）。
  // 不进 ensureFtsConsistency——本表与 message_blocks 非 1:1（仅 text/thinking 子集），行数对比无意义。
  db.exec(MESSAGE_BLOCKS_FTS_SQL);
  // 启动期 conversations→messages 幂等同步：把冷归档 conversations 里不在 messages 的孤行补进新表。
  // 取代反复追加的回填迁移（v25/v26/v28 打补丁的反模式）——「迁移时刻」与「服务升级时刻」不同步，
  // 一次性迁移只回填它跑那一刻的行；本函数每次启动都收敛，全同步后 LEFT JOIN 返回空集、零写入。
  // 须在 populateMessageBlocksFts 前：先回填 block，同一次启动就能进 FTS。
  syncConversationsToMessages(db);
  // 启动期 FTS 补齐：把 message_blocks 里尚不在 message_blocks_fts 的 text/thinking block 索引进去。
  // 增量幂等——migration（v25/v26 回填）直写 message_blocks 绕过 repo 的 appendBlock，故需此 catch-up；
  // 全新库等价全量；稳态无缺失则零写入。修复 v25→v26 升级窗口回填行补索引（否则历史 user 行搜不到）。
  populateMessageBlocksFts(db);
  // 15.0 §5.3 启动自愈：所有 FTS 表行数与源表不一致（触发器遗漏/刚创建/索引损坏/运维清表）
  // 时才 rebuild。FTS5 COUNT(*) 是 O(1)。修复前仅 knowledge_fts 有保护。
  // 多列 external-content FTS（dialogue/agent_chat 的 from/to/content）的 rebuild 读所有映射列，
  // 正确索引（单列+拼接触发器方案已废弃——rebuild 只读 content 列会丢拼接，是半成品）。
  ensureFtsConsistency(db, 'knowledge_fts', 'knowledge');
  ensureFtsConsistency(db, 'conversations_fts', 'conversations');
  ensureFtsConsistency(db, 'dialogue_messages_fts', 'dialogue_messages');
  ensureFtsConsistency(db, 'agent_chat_messages_fts', 'agent_chat_messages');

  return db;
}

/**
 * 15.0 §5.3：FTS 启动自愈。external-content FTS 表行数应与源表一致（触发器维护）；
 * 不一致则 rebuild（多列表读所有映射列，正确）。FTS5 COUNT(*) 为 O(1)。表不存在时静默跳过。
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

/**
 * 对话内联 FTS 启动期补齐（设计文档/22）。
 * message_blocks_fts 是独立（非 external-content）虚表，只能手动 DELETE+INSERT 维护。
 * repo 的 appendBlock/patchBlock 增量维护 text/thinking block 的索引；但 migration（v25/v26 回填）
 * 直写 message_blocks 绕过 repo，这些行需在此 catch-up。
 *
 * 增量幂等：只索引「message_blocks 有但 message_blocks_fts 没有」的 block（block_id NOT IN 已索引集合）。
 * 三态覆盖——全新库（FTS 空→等价全量）、升级（v25→v26 回填的新行补索引，否则历史 user 行搜不到）、
 * 稳态（无缺失→NOT IN 返回空集，零写入）。比旧的「FTS 非空即 skip」更鲁棒：旧逻辑在升级时
 * （FTS 已有 v25 行非空）会跳过，导致 v26 回填的窗口期 user 行永不进 FTS。
 */
function populateMessageBlocksFts(db: Database.Database): void {
  try {
    db.exec(`
      INSERT INTO message_blocks_fts (session_id, message_id, block_id, content)
      SELECT m.session_id, b.message_id, b.id, json_extract(b.payload_json, '$.text')
      FROM message_blocks b
      JOIN messages m ON m.id = b.message_id
      WHERE b.block_type IN ('text', 'thinking')
        AND json_extract(b.payload_json, '$.text') IS NOT NULL
        AND b.id NOT IN (SELECT block_id FROM message_blocks_fts);
    `);
  } catch {
    // message_blocks_fts / message_blocks 不存在（理论上不该发生）—— 静默跳过
  }
}

/**
 * 对话内联：启动期幂等同步 conversations → messages（设计文档/22）。
 *
 * 为什么需要：消灭双轨制后 messages+message_blocks 是唯一规范存储，conversations 退役为冷归档。
 * 但「迁移时刻」与「服务升级时刻」不同步——v25/v26 一次性迁移只回填它跑那一刻的行，之后若服务
 * 仍跑老代码（写 conversations）会持续制造孤子，而一次性迁移不再跑。本函数取代反复追加的回填迁移
 * （v25→v26→v28 打补丁的反模式）：每次启动幂等把所有 conversations ∉ messages 的孤行补进新表，
 * 收敛到稳定态（全同步）后 LEFT JOIN 返回空集、零写入。与 populateMessageBlocksFts 同构（启动自愈）。
 *
 * user + assistant 都回填（assistant 的 reasoning→thinking block + content→text block，与 v25 同构）。
 * 幂等：LEFT JOIN m.id IS NULL + INSERT OR IGNORE。列存在性按 table_info 容错（旧库可能缺列）。
 * redact：conversations 的 content/reasoning 写入时已清洗（saveUserMessage/saveMessage 入口 redact +
 * v17 历史扫描），此处直搬不再重复 redact。
 */
function syncConversationsToMessages(db: Database.Database): void {
  try {
    const hasConversations = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'conversations'`)
      .get();
    if (!hasConversations) return;

    const cols = new Set(
      (db.pragma('table_info(conversations)') as Array<{ name: string }>).map((c) => c.name),
    );
    const hasReasoning = cols.has('reasoning');
    const hasClientMsgId = cols.has('client_msg_id');
    const hasTaskId = cols.has('task_id');

    // 仅取「尚未进 messages」的孤行（LEFT JOIN 找空）——user + assistant 都要，避免与已回填行重复
    const rows = db
      .prepare(
        `SELECT c.id, c.session_id, c.role, c.content${
          hasReasoning ? ', c.reasoning' : ''
        }${hasClientMsgId ? ', c.client_msg_id' : ''}${hasTaskId ? ', c.task_id' : ''}, c.created_at
         FROM conversations c
         LEFT JOIN messages m ON m.id = c.id
         WHERE m.id IS NULL
         ORDER BY c.created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;

    if (rows.length === 0) return; // 稳态：全同步，零写入

    const insertMessage = db.prepare(
      `INSERT OR IGNORE INTO messages (id, session_id, role, client_msg_id, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertBlock = db.prepare(
      `INSERT OR IGNORE INTO message_blocks (id, message_id, seq, block_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    for (const r of rows) {
      const id = r.id as string;
      insertMessage.run(
        id,
        r.session_id,
        r.role,
        hasClientMsgId ? ((r.client_msg_id as string) ?? null) : null,
        hasTaskId ? ((r.task_id as string) ?? null) : null,
        r.created_at,
      );
      // assistant 的 reasoning（非空）→ thinking block；content → text block（与 v25 同构）
      let seq = 0;
      if (hasReasoning && r.reasoning) {
        seq++;
        insertBlock.run(
          `${id}#b${seq}`,
          id,
          seq,
          'thinking',
          JSON.stringify({ type: 'thinking', text: r.reasoning as string }),
          r.created_at,
        );
      }
      seq++;
      insertBlock.run(
        `${id}#b${seq}`,
        id,
        seq,
        'text',
        JSON.stringify({ type: 'text', text: (r.content as string) ?? '' }),
        r.created_at,
      );
    }
  } catch {
    // conversations/messages/message_blocks 不存在（旧库 / 迁移未跑完）—— 静默跳过
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

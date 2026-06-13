/**
 * 22 号文档（对话内联统一）运行时验证脚本（仿 verify-15.0.ts，临时——验证后删除）。
 *
 * 动机（plan 强约束）：15.0 教训——initDb 全路径不能只靠隔离单测。本脚本对临时 DB 跑完整
 * initDb（CORE_SCHEMA + 全部 migration v0-v25 + MESSAGE_BLOCKS_FTS），在真 DB 上证明：
 *   1. initDb 成功（含 v25 messages/message_blocks reshape）
 *   2. messages / message_blocks 表存在；message_blocks_fts 虚表存在
 *   3. persistAssistantTurn → getTimeline 往返：blocks 按序读回（thinking → tool → text）
 *   4. redact 单漏斗：tool block.input 含 sk-ant- 密钥 → payload_json 无明文
 *   5. FTS 端到端：text block 入库后可被 message_blocks_fts（trigram）搜中
 *
 * 运行：npx tsx tools/verify-22.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, getDb } from '../src/memory/index.js';
import { ALL_MIGRATIONS } from '../src/memory/migrations/index.js';
import { persistAssistantTurn, persistUserMessage, getTimeline } from '../src/memory/message-blocks-repo.js';
import type { Block } from '../src/contracts/message-blocks.js';

const dir = mkdtempSync(join(tmpdir(), 'berry-verify22-'));
const dbPath = join(dir, 'verify22.db');
let ok = true;
/** 断言辅助：❌/✅ 前缀 + 失败计数 */
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) ok = false;
};

try {
  // 1. 完整 initDb（跑 CORE_SCHEMA + runMigrations(ALL_MIGRATIONS) + MESSAGE_BLOCKS_FTS）
  initDb(dbPath);
  check('initDb 成功（含 v25 messages/message_blocks migration）', true);
  check('ALL_MIGRATIONS 含 v25', ALL_MIGRATIONS.some((m) => m.version === 25));

  const db = getDb();
  const tableExists = (t: string) =>
    !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);

  // 2. 表与虚表存在
  check('messages 表存在', tableExists('messages'));
  check('message_blocks 表存在', tableExists('message_blocks'));
  check('message_blocks_fts 虚表存在', tableExists('message_blocks_fts'));

  // 3. persistAssistantTurn → getTimeline 往返（thinking → tool → text 有序）
  const blocks: Block[] = [
    { type: 'thinking', text: '先分析需求' },
    { type: 'tool', id: 'm1#tool#shell#1', name: 'shell', input: { cmd: 'ls' }, state: 'completed', output: 'a\nb', durationMs: 12 },
    { type: 'text', text: '这是回复正文' },
  ];
  persistAssistantTurn({ messageId: 'm1', sessionId: 's1', taskId: 't1', blocks });
  const timeline = getTimeline('s1');
  check('getTimeline 返回 1 条消息', timeline.length === 1);
  check('消息含 3 个有序 blocks', timeline[0]?.blocks.length === 3);
  check('blocks 顺序 = thinking → tool → text', timeline[0]?.blocks.map((b) => b.type).join(',') === 'thinking,tool,text');
  const tb = timeline[0]?.blocks.find((b) => b.type === 'tool');
  check('tool block 字段往返无损（name/input/output/state/durationMs）', tb?.type === 'tool' && tb.name === 'shell' && (tb.input as { cmd: string }).cmd === 'ls' && tb.output === 'a\nb' && tb.state === 'completed' && tb.durationMs === 12);

  // 4. redact 单漏斗：tool block.input 含 sk-ant- 密钥 → payload_json 无明文
  persistAssistantTurn({
    messageId: 'm2',
    sessionId: 's1',
    blocks: [
      { type: 'tool', id: 'm2#tool#fetch#1', name: 'fetch', input: { auth: 'sk-ant-0123456789abcdefghijklmnop' }, state: 'completed' },
    ],
  });
  const rawPayload = db.prepare(`SELECT payload_json FROM message_blocks WHERE message_id = ?`).get('m2') as { payload_json: string };
  check('redact 单漏斗：tool block.input 的 sk-ant- 密钥已脱敏（payload_json 无明文）', !rawPayload.payload_json.includes('sk-ant-0123456789abcdefghijklmnop'));

  // 5. FTS 端到端：text block 入库后可被 message_blocks_fts（trigram，需 ≥3 字符词）搜中
  persistAssistantTurn({
    messageId: 'm3',
    sessionId: 's2',
    blocks: [{ type: 'text', text: '项目管理最佳实践讨论' }],
  });
  const ftsHit = db
    .prepare(`SELECT content FROM message_blocks_fts WHERE message_blocks_fts MATCH ?`)
    .all('"项目管理"') as Array<{ content: string }>;
  check('message_blocks_fts 端到端：text block 入库后可搜中（中文 trigram）', ftsHit.some((r) => r.content.includes('项目管理')));

  // ─── doc 22 期2：user 行落 messages + v26 backfill ───
  // 注：user 消息的活跃写入漏斗已是 persistUserMessage（消灭双轨制后，SessionManager /
  //   MemoryRuntime 的 saveUserMessage 均走它）；旧 conversations.saveUserMessage 已无调用方，
  //   历史遗留 user 行由 v26 一次性回填。此处验证活跃漏斗 + v26 回填两端。
  // 6. v26 migration 注册 + initDb 已应用（user 行回填迁移）
  check('ALL_MIGRATIONS 含 v26', ALL_MIGRATIONS.some((m) => m.version === 26));
  const maxVer = db.prepare(`SELECT MAX(version) as v FROM schema_migrations`).get() as { v: number };
  check('initDb 应用到 v26', maxVer.v === 26);

  // 7. user 消息落 messages（活跃漏斗 persistUserMessage）
  persistUserMessage({ sessionId: 's3', content: '用户消息落库测试', clientMsgId: 'cm-verify22' });
  const tlUser = getTimeline('s3').find((m) => m.role === 'user');
  check('persistUserMessage 写 messages（getTimeline 可见）', !!tlUser);
  check('user timeline 含 text block（内容无损）', !!tlUser && tlUser.blocks.some((b) => b.type === 'text' && (b as { text: string }).text === '用户消息落库测试'));

  // 8. 幂等：同 clientMsgId 再写一次，messages 不产生重复行
  persistUserMessage({ sessionId: 's3', content: '用户消息落库测试', clientMsgId: 'cm-verify22' });
  check('persistUserMessage 幂等（同 clientMsgId 不重复）', getTimeline('s3').filter((m) => m.role === 'user').length === 1);

  // 9. user 文本 redact（payload_json 无明文 secret）
  persistUserMessage({ sessionId: 's4', content: 'key=sk-ant-api03-zzzzzzzzzzzzzzzzz', clientMsgId: 'cm-redact' });
  const tlRedact = getTimeline('s4').find((m) => m.role === 'user');
  const userTextBlock = tlRedact?.blocks.find((b) => b.type === 'text') as { text: string } | undefined;
  check('user text block 脱敏（无明文 sk-ant）', !!userTextBlock && !userTextBlock.text.includes('sk-ant-api03'));

  // 10. v26 backfill 闭合窗口：手工塞一条「只在 conversations 不在 messages」的 user 行，重跑 v26 验证回填
  //     （模拟 v25 之后、消灭双轨制之前的遗留 user 行；v26 幂等重跑只补缺失行，不破坏已有数据）
  db.prepare(`INSERT INTO conversations (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`).run('gap-u1', 's5', '回填窗口测试', 5000);
  const v26 = ALL_MIGRATIONS.find((m) => m.version === 26)!;
  v26.up(db); // 幂等重跑——只回填缺失的 gap-u1
  const gapMsg = db.prepare(`SELECT id FROM messages WHERE id = ?`).get('gap-u1');
  check('v26 backfill：缺失 user 行回填进 messages', !!gapMsg);
  const gapBlock = db.prepare(`SELECT payload_json FROM message_blocks WHERE message_id = ?`).get('gap-u1') as { payload_json: string } | undefined;
  check('v26 backfill：user 行附带 text block（内容无损）', !!gapBlock && JSON.parse(gapBlock.payload_json).text === '回填窗口测试');
  check('v26 backfill 幂等：再跑一次不重复', (v26.up(db), db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE id = ?`).get('gap-u1') as { c: number }).c === 1);

  closeDb();
} catch (err) {
  console.log(`❌ 异常: ${(err as Error).message}`);
  console.log((err as Error).stack);
  ok = false;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(ok ? '\n🎉 22 号文档运行时验证全部通过' : '\n💥 存在失败项');
process.exit(ok ? 0 : 1);

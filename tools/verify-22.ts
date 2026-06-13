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
import { persistAssistantTurn, getTimeline } from '../src/memory/message-blocks-repo.js';
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

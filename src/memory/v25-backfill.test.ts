import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, getDb } from './db.js';
import { ALL_MIGRATIONS } from './migrations/index.js';
import { getTimeline, getMessageBlocks, searchMessageBlocks } from './message-blocks-repo.js';

/**
 * v25 inline-blocks 回填迁移测试 —— 钉死"旧 conversations 历史 → messages + message_blocks"的回填不变量。
 *
 * 用真实 initDb 路径（CORE_SCHEMA + 全部迁移 + FTS）验证，非隔离 mock（15.0 教训：init 全路径必须真跑）。
 * 流程：手工建旧 conversations 行（含 secret / reasoning / client_msg_id）→ initDb 触发 v25 回填 →
 * 用 message-blocks-repo 读取验证：消息 + blocks 顺序、redact 闭合、FTS 命中、幂等重跑。
 */
describe('v25 inline-blocks 回填迁移', () => {
  let dir: string;
  let rawPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'berry-v25-'));
    rawPath = join(dir, 'test.db');
    // 先用一个裸库建旧 conversations + 必要列（模拟 pre-v25 历史），再交 initDb 跑迁移回填。
    // **关键：CREATE 形状必须匹配 v0 runMemoryMigrations 跑完后的「现代」形态**——
    // 带工具列 + role CHECK 约束。否则 rebuildConversationsIfNeeded 会判定需重塑（renames+重建），
    // 重塑只复制 content（见 migrations.ts:226），把 reasoning/client_msg_id/task_id 全丢掉，
    // v25 就读不到 reasoning 了。真实 pre-v25 库此时早过 v0，conversations 已是现代形态。
    const raw = new Database(rawPath);
    raw.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
        content TEXT NOT NULL, tool_name TEXT, tool_input TEXT, tool_result TEXT,
        token_count INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      ALTER TABLE conversations ADD COLUMN reasoning TEXT;
      ALTER TABLE conversations ADD COLUMN client_msg_id TEXT;
      ALTER TABLE conversations ADD COLUMN task_id TEXT;
    `);
    const secret = 'sk-ant-' + 'z'.repeat(30);
    raw.prepare(
      `INSERT INTO conversations (id, session_id, role, content, reasoning, client_msg_id, task_id, created_at)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)`,
    ).run('msg-1', 's1', `回复里带 key ${secret}`, '先推理一下', 'cm-1', 'task-9', 1000);
    raw.prepare(
      `INSERT INTO conversations (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`,
    ).run('msg-0', 's1', '用户提问', 500);
    raw.close();

    // initDb 跑 CORE_SCHEMA（建 messages/message_blocks）+ 全部迁移（含 v25 回填）+ FTS populate
    initDb(rawPath);
  });

  afterEach(() => {
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('回填后 timeline 含旧消息，顺序按 created_at ASC', () => {
    const tl = getTimeline('s1');
    expect(tl.map((m) => m.id)).toEqual(['msg-0', 'msg-1']);
    expect(tl[0].role).toBe('user');
    expect(tl[1].role).toBe('assistant');
  });

  it('assistant 消息回填为 thinking + text 两个 block（顺序正确）', () => {
    const blocks = getMessageBlocks('msg-1');
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'text']);
    expect((blocks[0] as { text: string }).text).toBe('先推理一下');
    expect((blocks[1] as { text: string }).text).toContain('回复里带 key');
  });

  it('回填时 redact 闭合：payload_json 无明文 secret', () => {
    const secret = 'sk-ant-' + 'z'.repeat(30);
    const row = getDb()
      .prepare(`SELECT payload_json FROM message_blocks WHERE message_id = 'msg-1' AND block_type = 'text'`)
      .get() as { payload_json: string };
    expect(row.payload_json).not.toContain(secret);
    expect(row.payload_json).toContain('[REDACTED:anthropic_key]');
  });

  it('回填的 text/thinking block 进 FTS（首启 populate 覆盖）', () => {
    // trigram 分词器需 ≥3 个码点才能成词：用 4 字查询（'推理'/'提问' 仅 2 字无法匹配 trigram 索引）
    expect(searchMessageBlocks('推理一下').length).toBeGreaterThanOrEqual(1);
    expect(searchMessageBlocks('用户提问').length).toBeGreaterThanOrEqual(1);
  });

  it('幂等：v25 重跑不重复回填（同 id 跳过）', () => {
    const before = getTimeline('s1').length;
    // 直接重跑 v25 的 up（模拟迁移重跑 / 部分失败恢复）
    const v25 = ALL_MIGRATIONS.find((m) => m.version === 25)!;
    expect(() => v25.up(getDb())).not.toThrow();
    const after = getTimeline('s1').length;
    expect(after).toBe(before); // 不翻倍
    // blocks 也不重复
    expect(getMessageBlocks('msg-1').length).toBe(2);
  });
});

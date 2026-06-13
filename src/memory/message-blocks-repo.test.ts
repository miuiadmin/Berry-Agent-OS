import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, getDb } from './db.js';
import {
  createMessage,
  appendBlock,
  patchBlock,
  replaceBlockText,
  getMessage,
  getMessageBlocks,
  getTimeline,
  searchMessageBlocks,
  rebuildMessageBlocksFts,
} from './message-blocks-repo.js';
import type { Block, ToolBlock, DelegationBlock } from '../contracts/message-blocks.js';
import { isBlockTerminal } from '../contracts/message-blocks.js';

/**
 * message-blocks-repo 单测 —— 钉死对话内联模型存储层的不变量。
 *
 * 覆盖：消息幂等创建、block 追加 + 顺序、tool/delegation 幂等 upsert、redact 单漏斗
 * （block 任意字段明文 secret 落盘前清洗）、patchBlock 状态机推进、timeline 有序回放、
 * message_blocks_fts 全文检索 + 全量重建。
 *
 * 每个用例独立临时 DB（initDb 跑 CORE_SCHEMA + 迁移 + FTS，验证真实 init 路径，非隔离 mock）。
 */
describe('对话内联模型存储层（messages + message_blocks）', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'berry-blocks-'));
    initDb(join(dir, 'test.db'));
  });

  afterEach(() => {
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // ─── 消息创建 ───

  describe('createMessage 幂等', () => {
    it('创建消息返回 id，同 clientMsgId 重复创建去重', () => {
      const a = createMessage({ sessionId: 's1', role: 'user', clientMsgId: 'cm-1' });
      const b = createMessage({ sessionId: 's1', role: 'user', clientMsgId: 'cm-1' });
      expect(a.deduplicated).toBe(false);
      expect(b.deduplicated).toBe(true);
      expect(b.id).toBe(a.id);
    });

    it('无 clientMsgId 不去重（每次新行）', () => {
      const a = createMessage({ sessionId: 's1', role: 'assistant' });
      const b = createMessage({ sessionId: 's1', role: 'assistant' });
      expect(a.id).not.toBe(b.id);
    });
  });

  // ─── block 追加 + 顺序 ───

  describe('appendBlock 顺序与类型', () => {
    it('text/thinking/tool/delegation/review 各能追加，seq 递增', () => {
      const m = createMessage({ sessionId: 's1', role: 'assistant', taskId: 't1' }).id;
      appendBlock(m, { type: 'thinking', text: '让我想想' });
      appendBlock(m, { type: 'text', text: '你好' });
      appendBlock(m, {
        type: 'tool', id: 'c1', name: 'shell', input: { cmd: 'ls' }, state: 'completed',
      });
      appendBlock(m, { type: 'delegation', id: 'd1', targetAgent: 'code', state: 'completed' });
      appendBlock(m, { type: 'review', verdict: 'approve' });

      const blocks = getMessageBlocks(m);
      expect(blocks.map((b) => b.type)).toEqual([
        'thinking', 'text', 'tool', 'delegation', 'review',
      ]);
      // 读取侧 round-trip：tool block 字段保留
      const tool = blocks[2] as ToolBlock;
      expect(tool.name).toBe('shell');
      expect(tool.state).toBe('completed');
    });

    it('tool/delegation 同 id（callId/taskId）重复追加 = 幂等 upsert，不新增行', () => {
      const m = createMessage({ sessionId: 's1', role: 'assistant' }).id;
      appendBlock(m, { type: 'tool', id: 'c1', name: 'shell', input: {}, state: 'pending' });
      // 同 callId 再次追加（状态已推进）—— 应 upsert 同一行而非新增
      appendBlock(m, { type: 'tool', id: 'c1', name: 'shell', input: {}, state: 'completed' });
      const blocks = getMessageBlocks(m);
      expect(blocks).toHaveLength(1);
      expect((blocks[0] as ToolBlock).state).toBe('completed');
    });
  });

  // ─── redact 单漏斗（核心不变量） ───

  describe('redact 单漏斗', () => {
    it('text block 内嵌 anthropic key 落盘前被清洗（payload_json 无明文）', () => {
      const m = createMessage({ sessionId: 's1', role: 'user' }).id;
      const secret = 'sk-ant-' + 'a'.repeat(30); // anthropic_key 模式（20+ 位）
      appendBlock(m, { type: 'text', text: `我的 key 是 ${secret}` });

      // 直接查裸 payload_json，确认无明文 secret
      const row = getDb()
        .prepare(`SELECT payload_json FROM message_blocks WHERE message_id = ?`)
        .get(m) as { payload_json: string };
      expect(row.payload_json).not.toContain(secret);
      expect(row.payload_json).toContain('[REDACTED:anthropic_key]');
    });

    it('tool block 的 input/output 内 secret 同样被清洗', () => {
      const m = createMessage({ sessionId: 's1', role: 'assistant' }).id;
      const secret = 'sk-ant-' + 'b'.repeat(30);
      appendBlock(m, {
        type: 'tool',
        id: 'c1',
        name: 'shell',
        input: { env: `TOKEN=${secret}` },
        state: 'completed',
        output: `leaked: ${secret}`,
      });
      const row = getDb()
        .prepare(`SELECT payload_json FROM message_blocks WHERE id = 'c1'`)
        .get() as { payload_json: string };
      expect(row.payload_json).not.toContain(secret);
    });

    it('patchBlock 回填 output 时同样清洗（patch 路径闭合）', () => {
      const m = createMessage({ sessionId: 's1', role: 'assistant' }).id;
      appendBlock(m, { type: 'tool', id: 'c1', name: 'shell', input: {}, state: 'running' });
      const secret = 'ghp_' + 'c'.repeat(36); // github_pat 模式（36+ 位）
      patchBlock('c1', { state: 'completed', output: `token=${secret}` });
      const row = getDb()
        .prepare(`SELECT payload_json FROM message_blocks WHERE id = 'c1'`)
        .get() as { payload_json: string };
      expect(row.payload_json).not.toContain(secret);
    });
  });

  // ─── patchBlock 状态机 ───

  describe('patchBlock 状态机推进', () => {
    it('tool block pending → running → completed，output 回填', () => {
      const m = createMessage({ sessionId: 's1', role: 'assistant' }).id;
      appendBlock(m, { type: 'tool', id: 'c1', name: 'shell', input: {}, state: 'pending' });
      patchBlock('c1', { state: 'running' });
      patchBlock('c1', { state: 'completed', output: { ok: true }, durationMs: 42 });

      const tool = getMessageBlocks(m)[0] as ToolBlock;
      expect(tool.state).toBe('completed');
      expect(tool.output).toEqual({ ok: true });
      expect(tool.durationMs).toBe(42);
      expect(isBlockTerminal(tool)).toBe(true);
    });

    it('delegation block 推进 + childSessionId 回填', () => {
      const m = createMessage({ sessionId: 's1', role: 'assistant' }).id;
      appendBlock(m, { type: 'delegation', id: 'd1', targetAgent: 'code', state: 'pending' });
      patchBlock('d1', { state: 'running', childSessionId: 'sess-child' });
      patchBlock('d1', { state: 'completed', summary: '重构完成' });

      const del = getMessageBlocks(m)[0] as DelegationBlock;
      expect(del.state).toBe('completed');
      expect(del.childSessionId).toBe('sess-child');
      expect(del.summary).toBe('重构完成');
      expect(isBlockTerminal(del)).toBe(true);
    });

    it('text block 用 replaceBlockText 整体替换内容', () => {
      const m = createMessage({ sessionId: 's1', role: 'assistant' }).id;
      const bid = appendBlock(m, { type: 'text', text: '初稿' });
      replaceBlockText(bid, '还原后的原文');
      expect((getMessageBlocks(m)[0] as { text: string }).text).toBe('还原后的原文');
    });

    it('patch 不存在的 block 抛错', () => {
      expect(() => patchBlock('nope', { state: 'completed' })).toThrow();
    });
  });

  // ─── timeline 有序回放 ───

  describe('getTimeline 有序回放', () => {
    it('多消息按 created_at ASC，每条含有序 blocks', () => {
      const u = createMessage({ sessionId: 's1', role: 'user', clientMsgId: 'u1' }).id;
      appendBlock(u, { type: 'text', text: '帮我看下' });

      const a = createMessage({ sessionId: 's1', role: 'assistant' }).id;
      appendBlock(a, { type: 'thinking', text: '分析中' });
      appendBlock(a, { type: 'tool', id: 'c1', name: 'shell', input: {}, state: 'completed' });
      appendBlock(a, { type: 'text', text: '结果是…' });

      const tl = getTimeline('s1');
      expect(tl).toHaveLength(2);
      expect(tl[0].role).toBe('user');
      expect(tl[0].blocks).toHaveLength(1);
      expect(tl[1].role).toBe('assistant');
      expect(tl[1].blocks.map((b) => b.type)).toEqual(['thinking', 'tool', 'text']);
    });

    it('getMessage 单条含 blocks', () => {
      const m = createMessage({ sessionId: 's1', role: 'assistant' }).id;
      appendBlock(m, { type: 'text', text: 'hi' });
      const got = getMessage(m);
      expect(got?.blocks).toHaveLength(1);
      expect(getMessage('nope')).toBeNull();
    });
  });

  // ─── 全文检索 ───

  describe('message_blocks_fts 全文检索', () => {
    it('命中 text/thinking block 内容，返回高亮片段', () => {
      const m = createMessage({ sessionId: 's1', role: 'assistant' }).id;
      appendBlock(m, { type: 'text', text: '如何配置 React 的 useState 钩子' });
      const hits = searchMessageBlocks('useState');
      expect(hits).toHaveLength(1);
      expect(hits[0].messageId).toBe(m);
      expect(hits[0].snippet).toContain('useState');
    });

    it('session_id 过滤：跨会话只命中指定会话', () => {
      const m1 = createMessage({ sessionId: 's1', role: 'assistant' }).id;
      appendBlock(m1, { type: 'text', text: 'TypeScript 泛型用法' });
      const m2 = createMessage({ sessionId: 's2', role: 'assistant' }).id;
      appendBlock(m2, { type: 'text', text: 'TypeScript 枚举用法' });

      expect(searchMessageBlocks('TypeScript').length).toBe(2);
      expect(searchMessageBlocks('TypeScript', { sessionId: 's1' }).length).toBe(1);
    });

    it('rebuildMessageBlocksFts 从 payload 全量重建（清空后恢复）', () => {
      const m = createMessage({ sessionId: 's1', role: 'assistant' }).id;
      appendBlock(m, { type: 'text', text: '全量重建测试关键词 uniqueMarker' });
      // 清空 FTS 模拟损坏
      getDb().exec(`DELETE FROM message_blocks_fts;`);
      expect(searchMessageBlocks('uniqueMarker')).toHaveLength(0);
      rebuildMessageBlocksFts();
      expect(searchMessageBlocks('uniqueMarker')).toHaveLength(1);
    });
  });

  // ─── block round-trip 类型保真 ───

  describe('读取侧 BlockSchema 校验', () => {
    it('读回的 block 通过 BlockSchema（形状保真）', () => {
      const m = createMessage({ sessionId: 's1', role: 'assistant' }).id;
      const original: Block = {
        type: 'tool', id: 'c1', name: 'mcp__github__search', input: { q: 'x' }, state: 'failed',
        error: 'boom',
      };
      appendBlock(m, original);
      const read = getMessageBlocks(m)[0] as ToolBlock;
      expect(read.name).toBe('mcp__github__search');
      expect(read.state).toBe('failed');
      expect(read.error).toBe('boom');
    });
  });
});

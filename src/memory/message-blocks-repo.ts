/**
 * 对话内联模型存储层（设计文档/22）—— messages + message_blocks 的读写仓库。
 *
 * 这是"工具调用 / MCP / 委派嵌入对话流"在存储侧的唯一落点：一条消息由有序 Block[] 组成，
 * 每个 block 一行（message_blocks.payload_json = BlockSchema 序列化）。
 *
 * 关键不变量（redact 单漏斗）：
 *   block 的全部内容（text / input / output / summary / error）只经 appendBlock / patchBlock
 *   两个入口落库，落盘前统一 redactSecrets 清洗——secret 扫描从历史的 ~10 个写入点坍缩为这一个漏斗，
 *   天然闭合（15.0 耗时 5 轮才机械闭合的痛点在此根治）。
 *
 * 分层关系：本仓库只管 Block 模型层（存储 / 读取），不感知事件流（stream.block 由期3 的 task-flow 产出）、
 * 不感知渲染。LLM 线协议序列化（Block → Anthropic tool_use/tool_result）是单独的适配器关注点。
 *
 * 当前状态（期2）：纯地基，未接入活线写入路径；期3 切换写路径、v25 backfill 回填历史。
 */

import { getDb } from './db.js';
import { genId } from '../utils/id.js';
import { redactSecrets } from '../observability/redaction.js';
import { BlockSchema } from '../contracts/message-blocks.js';
import type { Block, BlockPatch } from '../contracts/message-blocks.js';

// ─── 读取返回类型 ───

/** 消息元数据（不含内容；内容在 blocks 里） */
export interface StoredMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** 关联 agent task（assistant 消息归属；还原初稿 / 委派用） */
  taskId?: string;
  createdAt: number;
}

/** 时间线条目：一条消息 + 其有序 blocks（/timeline 端点 + 前端时间线的返回形态） */
export interface TimelineMessage extends StoredMessage {
  blocks: Block[];
}

/** 全文检索命中项 */
export interface MessageBlockSearchHit {
  messageId: string;
  blockId: string;
  sessionId: string;
  /** 命中片段（<mark> 高亮） */
  snippet: string;
}

// ─── 内部工具 ───

/**
 * 取 block 的幂等主键：tool/delegation 用自身 id（callId / taskId），其余生成 genId('blk')。
 * 这样 stream.block 事件重发同一 callId 时 upsert 命中同一行，天然幂等。
 */
function blockIdOf(block: Block): string {
  if (block.type === 'tool' || block.type === 'delegation') return block.id;
  return genId('blk');
}

/** 是否为可索引（进 FTS）的文本类 block —— text / thinking 的 .text 字段进全文索引 */
function isIndexable(block: Block): block is Extract<Block, { text: string }> {
  return block.type === 'text' || block.type === 'thinking';
}

/**
 * 把 Block 序列化为已 redact 的 payload_json 字符串（redact 单漏斗的核心）。
 * 先 JSON.stringify 再 redactSecrets：对整段 JSON 串做 secret 替换，block 内任何字段
 * （text / input / output / summary）的明文 key 都会被清洗；JSON 结构保持合法
 * （secret 不含未转义引号，替换占位符不破坏 JSON 串——与 v17~v24 对 JSON 列的 redact 同法）。
 */
function serializeBlock(block: Block): string {
  return redactSecrets(JSON.stringify(block));
}

/** 把 patch 的已定义字段浅合并进已解析的 block 对象（undefined 字段不覆盖） */
function applyPatch(parsed: Record<string, unknown>, patch: BlockPatch): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...parsed };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/** DB 行（payload_json 字符串）→ 校验后的 Block（读取侧防御性校验，库内数据可信） */
function parseBlock(row: { payload_json: string }): Block {
  const parsed = JSON.parse(row.payload_json) as unknown;
  return BlockSchema.parse(parsed);
}

// ─── 消息 CRUD ───

/**
 * 创建一条消息（一轮对话的 user / assistant / system / tool 行）。返回消息 id。
 * 幂等：同一 (session_id, clientMsgId) 重复创建返回已存在行（deduplicated=true），不破坏对话顺序。
 *
 * @param opts.role 消息角色
 * @param opts.clientMsgId 客户端消息幂等键（user 消息入口去重）
 * @param opts.taskId 关联 agent task（assistant 消息归属）
 * @param opts.id 指定消息 id（BlockCollector 用 stream.block 已广播的 messageId 落库，保证前后端一致）
 */
export function createMessage(opts: {
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  clientMsgId?: string;
  taskId?: string;
  id?: string;
}): { id: string; deduplicated: boolean } {
  const db = getDb();

  // clientMsgId 精确去重（UNIQUE 部分索引保证）：同一会话同 clientMsgId 的重试只保留一行
  if (opts.clientMsgId) {
    const existing = db
      .prepare(
        `SELECT id FROM messages WHERE session_id = ? AND client_msg_id = ? LIMIT 1`,
      )
      .get(opts.sessionId, opts.clientMsgId) as { id: string } | undefined;
    if (existing) return { id: existing.id, deduplicated: true };
  }

  const id = opts.id ?? genId('msg');
  try {
    db.prepare(`
      INSERT INTO messages (id, session_id, role, client_msg_id, task_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, opts.sessionId, opts.role, opts.clientMsgId ?? null, opts.taskId ?? null, Date.now());
  } catch (err) {
    // UNIQUE 并发冲突（另一路径已插入同 clientMsgId）→ 复用其 id
    if (opts.clientMsgId && (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const existing = db
        .prepare(`SELECT id FROM messages WHERE session_id = ? AND client_msg_id = ? LIMIT 1`)
        .get(opts.sessionId, opts.clientMsgId) as { id: string } | undefined;
      if (existing) return { id: existing.id, deduplicated: true };
    }
    throw err;
  }
  return { id, deduplicated: false };
}

/**
 * 向消息追加一个 block（redact 单漏斗入口）。seq 自动取消息内 MAX(seq)+1。
 * 幂等：同 block id（tool/delegation 的 callId/taskId）重复追加 = upsert（更新 payload，保留原 seq）。
 * 副作用：text/thinking block 同步进 message_blocks_fts。
 * @returns 实际使用的 block id（= block.id 或新生成的 genId('blk')）
 */
export function appendBlock(messageId: string, block: Block): string {
  const db = getDb();
  const id = blockIdOf(block);
  const payloadJson = serializeBlock(block); // redact 单漏斗

  // 幂等 upsert：ON CONFLICT(id) 更新 payload，保留原 seq（避免 UNIQUE(message_id,seq) 冲突）
  db.prepare(`
    INSERT INTO message_blocks (id, message_id, seq, block_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, block_type = excluded.block_type
  `).run(id, messageId, pickNextSeq(messageId), block.type, payloadJson, Date.now());

  // text/thinking block：删旧插新维护 FTS（对新插入与 upsert 都幂等，避免重复索引行）
  if (isIndexable(block)) {
    const d = getDb();
    d.prepare(`DELETE FROM message_blocks_fts WHERE block_id = ?`).run(id);
    indexBlockFts(messageId, id, block);
  }
  return id;
}

/** 计算消息内下一个 seq（MAX(seq)+1，空消息从 1 起）。better-sqlite3 同步单线程，无并发竞争。 */
function pickNextSeq(messageId: string): number {
  const db = getDb();
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM message_blocks WHERE message_id = ?`)
    .get(messageId) as { next: number };
  return row.next;
}

/**
 * 落库一轮 assistant 消息的全部 blocks（task-flow 在 agent.task.result 调用）。
 * 用指定 messageId 建 messages 行（与 stream.block 已广播的 id 一致，保证前后端 id 对齐），
 * 顺序追加各 block。空内容跳过（不建空消息）。单事务保证原子。
 *
 * 这是"写路径切到新表"的落库漏斗（设计文档/22 期3b）；与旧 conversations 写入并行（兼容期双写）。
 */
export function saveAssistantBlocks(opts: {
  messageId: string;
  sessionId: string;
  taskId?: string;
  blocks: Block[];
}): void {
  if (opts.blocks.length === 0) return;
  const db = getDb();
  const tx = db.transaction(() => {
    createMessage({
      id: opts.messageId,
      sessionId: opts.sessionId,
      role: 'assistant',
      taskId: opts.taskId,
    });
    for (const block of opts.blocks) appendBlock(opts.messageId, block);
  });
  tx();
}

/**
 * 把 block 的文本内容索引进 message_blocks_fts（仅 text/thinking 调用）。
 * 需查消息的 session_id 作为 FTS 行的会话过滤列。
 */
function indexBlockFts(messageId: string, blockId: string, block: Extract<Block, { text: string }>): void {
  const db = getDb();
  const msg = db.prepare(`SELECT session_id FROM messages WHERE id = ?`).get(messageId) as
    | { session_id: string }
    | undefined;
  if (!msg) return; // 消息不存在（已被清理）—— 静默跳过
  db.prepare(
    `INSERT INTO message_blocks_fts (session_id, message_id, block_id, content) VALUES (?, ?, ?, ?)`,
  ).run(msg.session_id, messageId, blockId, block.text);
}

/**
 * 局部 patch 一个 block（状态机推进 / 结果回填 / 文本替换）。redact 单漏斗（重新清洗整段 payload）。
 * 合并后重新 BlockSchema 校验，保证 type-specific 字段（如 state 枚举）始终合法。
 * 副作用：text/thinking block 若 patch.text 提供则同步刷新 FTS。
 * @throws block 不存在时抛错（调用方编程错误）
 */
export function patchBlock(blockId: string, patch: BlockPatch): void {
  const db = getDb();
  const row = db
    .prepare(`SELECT message_id, payload_json FROM message_blocks WHERE id = ?`)
    .get(blockId) as { message_id: string; payload_json: string } | undefined;
  if (!row) {
    throw new Error(`patchBlock: block 不存在 id=${blockId}`);
  }

  const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
  const merged = applyPatch(parsed, patch);
  const validated = BlockSchema.parse(merged); // 校验合并结果形状
  const payloadJson = serializeBlock(validated); // redact 单漏斗

  db.prepare(`UPDATE message_blocks SET payload_json = ? WHERE id = ?`).run(payloadJson, blockId);

  // text/thinking block 的 .text 被替换 → 刷新 FTS（删旧插新）
  if ((validated.type === 'text' || validated.type === 'thinking') && patch.text !== undefined) {
    const db2 = getDb();
    db2.prepare(`DELETE FROM message_blocks_fts WHERE block_id = ?`).run(blockId);
    indexBlockFts(row.message_id, blockId, validated as Extract<Block, { text: string }>);
  }
}

/**
 * 还原初稿便捷方法：用一段新文本整体替换某个 text/thinking block 的内容（"还原 Brain 修改"用）。
 * 本质是 patchBlock(blockId, { text }) 的语义化封装。
 */
export function replaceBlockText(blockId: string, text: string): void {
  patchBlock(blockId, { text });
}

// ─── 读取 API ───

/** 取单条消息（含其有序 blocks）；不存在返回 null */
export function getMessage(messageId: string): TimelineMessage | null {
  const db = getDb();
  const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId) as
    | Record<string, unknown>
    | undefined;
  if (!msg) return null;
  return { ...rowToStoredMessage(msg), blocks: getMessageBlocks(messageId) };
}

/** 取消息的有序 blocks（按 seq ASC） */
export function getMessageBlocks(messageId: string): Block[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT payload_json FROM message_blocks WHERE message_id = ? ORDER BY seq ASC`)
    .all(messageId) as { payload_json: string }[];
  return rows.map(parseBlock);
}

/**
 * 取会话的完整时间线：有序消息（created_at ASC），每条含其有序 blocks。
 * 两段查询：先取消息（带 limit），再批量取这些消息的 blocks，JS 内分组——避免 JOIN LIMIT 误限 block 行。
 * @param opts.limit 最多返回的消息条数（默认 100）
 */
export function getTimeline(sessionId: string, opts: { limit?: number } = {}): TimelineMessage[] {
  const db = getDb();
  const limit = opts.limit ?? 100;
  const msgs = db
    .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`)
    .all(sessionId, limit) as Record<string, unknown>[];
  if (msgs.length === 0) return [];

  const ids = msgs.map((m) => m.id as string);
  const placeholders = ids.map(() => '?').join(',');
  const blockRows = db
    .prepare(
      `SELECT message_id, payload_json FROM message_blocks
       WHERE message_id IN (${placeholders}) ORDER BY message_id, seq ASC`,
    )
    .all(...ids) as { message_id: string; payload_json: string }[];

  // 按 message_id 分组 blocks
  const blocksByMsg = new Map<string, Block[]>();
  for (const br of blockRows) {
    const list = blocksByMsg.get(br.message_id) ?? [];
    list.push(parseBlock(br));
    blocksByMsg.set(br.message_id, list);
  }

  return msgs.map((m) => ({
    ...rowToStoredMessage(m),
    blocks: blocksByMsg.get(m.id as string) ?? [],
  }));
}

/** DB 行 → StoredMessage（剥离内容列，内容在 blocks 里） */
function rowToStoredMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    role: row.role as StoredMessage['role'],
    taskId: (row.task_id as string) || undefined,
    createdAt: row.created_at as number,
  };
}

// ─── 全文检索 ───

/**
 * 跨会话（或单会话）搜索 text/thinking block 内容。返回命中片段。
 * session_id 是 UNINDEXED 列，用普通 WHERE 过滤（不参与 MATCH 分词）。
 * snippet 第 3 列 = content（0=session_id 1=message_id 2=block_id 3=content）。
 */
export function searchMessageBlocks(
  query: string,
  opts: { sessionId?: string; limit?: number } = {},
): MessageBlockSearchHit[] {
  const db = getDb();
  const limit = opts.limit ?? 20;
  const sql = opts.sessionId
    ? `SELECT message_id, block_id, session_id,
              snippet(message_blocks_fts, 3, '<mark>', '</mark>', '...', 24) AS snippet
       FROM message_blocks_fts
       WHERE message_blocks_fts MATCH ? AND session_id = ?
       ORDER BY rank LIMIT ?`
    : `SELECT message_id, block_id, session_id,
              snippet(message_blocks_fts, 3, '<mark>', '</mark>', '...', 24) AS snippet
       FROM message_blocks_fts
       WHERE message_blocks_fts MATCH ?
       ORDER BY rank LIMIT ?`;
  const rows = (opts.sessionId
    ? db.prepare(sql).all(query, opts.sessionId, limit)
    : db.prepare(sql).all(query, limit)) as Array<{
    message_id: string;
    block_id: string;
    session_id: string;
    snippet: string;
  }>;
  return rows.map((r) => ({
    messageId: r.message_id,
    blockId: r.block_id,
    sessionId: r.session_id,
    snippet: r.snippet,
  }));
}

// ─── 运维 ───

/**
 * 从 message_blocks 全量重建 message_blocks_fts（运维 / 历史 backfill 后调用）。
 * 从 payload_json 的 $.text 抽取 text/thinking block 的内容重新索引。
 */
export function rebuildMessageBlocksFts(): void {
  const db = getDb();
  db.exec(`DELETE FROM message_blocks_fts;`);
  db.exec(`
    INSERT INTO message_blocks_fts (session_id, message_id, block_id, content)
    SELECT m.session_id, b.message_id, b.id, json_extract(b.payload_json, '$.text')
    FROM message_blocks b
    JOIN messages m ON m.id = b.message_id
    WHERE b.block_type IN ('text', 'thinking')
      AND json_extract(b.payload_json, '$.text') IS NOT NULL;
  `);
}

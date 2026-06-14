/**
 * 任务板仓库（架构升级 16.0 P2）—— BoardMessage 发言流 + 板元数据的 CRUD。
 *
 * 设计文档/23 §5.1：task = board。每块板有：
 *   - 发言 thread（task_thread 表，每条 = 一个 BoardMessage 信封）
 *   - 成员花名册（task_members 表）
 *   - 板元数据（agent_tasks 的 board_* 列）
 *
 * 本模块是板存储的唯一入口——所有 16.0 协作路径（delegate/report/tell/ask/tool/command）
 * 的发言经此落库，brain 看板 / 审计追溯经此读取。
 *
 * 与 doc 22 message-blocks-repo 的关系：板发言（BoardMessage）是「谁在板上说了什么」的序列，
 * 每条发言的内容可以引用 message_blocks（该 agent 那轮的 Block[]）。两层正交（§13）。
 */

import { getDb } from '../memory/db.js';
import { genId } from '../utils/id.js';
import { redactSecrets } from '../observability/redaction.js';
import { BoardMessageSchema, nextBoardStatus } from '../contracts/board-message.js';
import type { BoardMessage, BoardStatus, BoardMessageType, BoardStatusEvent } from '../contracts/board-message.js';

// ─── BoardMessage 发言流 CRUD ───

/**
 * 向板的发言 thread 追加一条 BoardMessage（16.0 协作的核心写操作）。
 *
 * 信封经 BoardMessageSchema 校验 → redactSecrets 清洗 payload_json → 落 task_thread。
 * seq 自动取板内 MAX(seq)+1。返回插入的信封 id。
 *
 * @param taskId  所属 task board
 * @param msg     BoardMessage（经 Zod 校验）
 * @returns 信封 id
 */
export function postBoardMessage(taskId: string, msg: BoardMessage): string {
  const db = getDb();
  // Zod 校验：确保 type 判别联合合法（防运行时构造非法信封）
  const validated = BoardMessageSchema.parse(msg);
  const id = validated.id ?? genId('bmsg');
  const payloadJson = redactSecrets(JSON.stringify(validated));

  // seq = 板内 MAX(seq)+1（better-sqlite3 同步单线程，无并发竞争）
  const seqRow = db
    .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM task_thread WHERE task_id = ?')
    .get(taskId) as { next: number };

  db.prepare(
    `INSERT INTO task_thread (id, task_id, seq, message_type, from_agent, to_target, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, taskId, seqRow.next, validated.type, validated.from, String(validated.to), payloadJson);

  // 板 turn 计数 +1（预算 maxTurns 用，§10.6）
  db.prepare('UPDATE agent_tasks SET turn_count = turn_count + 1 WHERE id = ?').run(taskId);

  return id;
}

/** 取板的完整发言 thread（按 seq ASC），每条含完整 BoardMessage（反序列化 payload_json） */
export function getBoardThread(taskId: string, opts: { limit?: number; offset?: number } = {}): BoardMessage[] {
  const db = getDb();
  const limit = opts.limit ?? 200;
  const offset = opts.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT payload_json FROM task_thread WHERE task_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?`,
    )
    .all(taskId, limit, offset) as { payload_json: string }[];
  return rows.map((r) => JSON.parse(r.payload_json) as BoardMessage);
}

/** 取板最近 N 条发言（brain 看板轻扫用，§10.1） */
export function getRecentBoardMessages(taskId: string, count: number): BoardMessage[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT payload_json FROM task_thread WHERE task_id = ? ORDER BY seq DESC LIMIT ?`,
    )
    .all(taskId, count) as { payload_json: string }[];
  return rows.reverse().map((r) => JSON.parse(r.payload_json) as BoardMessage);
}

/** 取板发言总数（预算/审计用） */
export function getBoardThreadCount(taskId: string): number {
  const db = getDb();
  return (db.prepare('SELECT COUNT(*) AS c FROM task_thread WHERE task_id = ?').get(taskId) as { c: number }).c;
}

// ─── 板元数据 CRUD（agent_tasks.board_* 列）───

/** 板元数据读取结果 */
export interface BoardMetaRow {
  taskId: string;
  goal: string | null;
  boardStatus: BoardStatus;
  leader: string | null;
  parentTaskId: string | null;
  spawnDepth: number;
  turnCount: number;
  maxTurns: number;
  maxSpawnDepth: number;
  activeScope: string | null;
}

/**
 * 取板元数据（从 agent_tasks 的 board_* 列读）。
 * 非 board 的普通 task（board_status='created' 且 board_leader=NULL）也安全返回。
 */
export function getBoardMeta(taskId: string): BoardMetaRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, board_goal, board_status, board_leader, parent_task_id,
              spawn_depth, turn_count, max_turns, max_spawn_depth, active_scope
       FROM agent_tasks WHERE id = ?`,
    )
    .get(taskId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    taskId: row.id as string,
    goal: (row.board_goal as string) ?? null,
    boardStatus: (row.board_status as BoardStatus) ?? 'created',
    leader: (row.board_leader as string) ?? null,
    parentTaskId: (row.parent_task_id as string) ?? null,
    spawnDepth: (row.spawn_depth as number) ?? 0,
    turnCount: (row.turn_count as number) ?? 0,
    maxTurns: (row.max_turns as number) ?? 50,
    maxSpawnDepth: (row.max_spawn_depth as number) ?? 3,
    activeScope: (row.active_scope as string) ?? null,
  };
}

/**
 * 按事件推导并更新板状态（§6.5.1 单一事实源）。
 *
 * 读当前 board_status → 调纯函数 {@link nextBoardStatus} 推导 + 校验合法流转 → updateBoardMeta。
 * 旧库未跑 v28 迁移（board 列不存在）时静默降级 no-op（不阻塞信封落板）。
 *
 * @returns 新状态（已 UPDATE）；null=无变化/终态/旧库降级（调用方不必关心）
 */
export function applyBoardStatus(taskId: string, event: BoardStatusEvent): BoardStatus | null {
  try {
    const meta = getBoardMeta(taskId);
    if (!meta) return null;
    const next = nextBoardStatus(meta.boardStatus, event);
    if (next) updateBoardMeta(taskId, { boardStatus: next });
    return next;
  } catch {
    // board 列不存在（旧库未跑 v28 迁移）→ 静默降级，板状态推导 no-op 不阻塞信封落板
    return null;
  }
}

/**
 * 更新板元数据（部分更新，只传需要改的字段）。
 * 常用于：创建板时设 goal/leader → 发言推进时改 board_status → 预算超限时抬 max_turns。
 */
export function updateBoardMeta(
  taskId: string,
  patch: Partial<Pick<BoardMetaRow, 'goal' | 'boardStatus' | 'leader' | 'spawnDepth' | 'maxTurns' | 'maxSpawnDepth' | 'activeScope'>>,
): void {
  const db = getDb();
  const sets: string[] = [];
  const params: unknown[] = [];
  const colMap: Record<string, string> = {
    goal: 'board_goal',
    boardStatus: 'board_status',
    leader: 'board_leader',
    spawnDepth: 'spawn_depth',
    maxTurns: 'max_turns',
    maxSpawnDepth: 'max_spawn_depth',
    activeScope: 'active_scope',
  };
  for (const [key, col] of Object.entries(colMap)) {
    if (key in patch) {
      sets.push(`${col} = ?`);
      params.push(patch[key as keyof typeof patch]);
    }
  }
  if (sets.length === 0) return;
  params.push(taskId);
  db.prepare(`UPDATE agent_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

// ─── 板成员花名册 CRUD（§6 scope）───

/** 向板花名册添加成员（delegate 拉人时调） */
export function addBoardMember(taskId: string, agentId: string, role: 'leader' | 'member' | 'governance' = 'member'): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO task_members (task_id, agent_id, role) VALUES (?, ?, ?)`,
  ).run(taskId, agentId, role);
}

/** 取板花名册（成员列表） */
export function getBoardMembers(taskId: string): Array<{ agentId: string; role: string }> {
  const db = getDb();
  const rows = db
    .prepare('SELECT agent_id, role FROM task_members WHERE task_id = ?')
    .all(taskId) as Array<{ agent_id: string; role: string }>;
  return rows.map((r) => ({ agentId: r.agent_id, role: r.role }));
}

/** 检查 agent 是否是板成员（可见性过滤用，§6） */
export function isBoardMember(taskId: string, agentId: string): boolean {
  const db = getDb();
  const row = db
    .prepare('SELECT 1 FROM task_members WHERE task_id = ? AND agent_id = ?')
    .get(taskId, agentId);
  return !!row;
}

// ─── 板创建（task 升级为 board 的入口）───

/**
 * 把一个 agent_task 升级为 board（§5.1）。
 * 设 board 元数据 + leader 进花名册。
 * 幂等：重复调安全（UPDATE + INSERT OR IGNORE）。
 */
export function initBoard(taskId: string, opts: {
  goal: string;
  leader: string;
  parentTaskId?: string;
  spawnDepth?: number;
  activeScope?: string;
}): void {
  updateBoardMeta(taskId, {
    goal: opts.goal,
    boardStatus: 'created',
    leader: opts.leader,
    spawnDepth: opts.spawnDepth ?? 0,
    activeScope: opts.activeScope ? JSON.stringify(opts.activeScope) : undefined,
  });
  // parent_task_id 单独设（updateBoardMeta 不含它，因为它不是 board_meta 接口字段）
  if (opts.parentTaskId) {
    const db = getDb();
    db.prepare('UPDATE agent_tasks SET parent_task_id = ? WHERE id = ?').run(opts.parentTaskId, taskId);
  }
  // leader 进花名册
  addBoardMember(taskId, opts.leader, 'leader');
}

// ─── brain 看板上下文组装（§10.5，P3 brain 看板用）───

/** brain 看板上下文：近 N 条发言 + 板元数据 + 花名册，供 board-observer / board-ask-handler 拼 prompt */
export interface BoardContext {
  meta: BoardMetaRow;
  members: Array<{ agentId: string; role: string }>;
  recentMessages: BoardMessage[];
  /** 板发言总数（预算用） */
  totalMessages: number;
}

/**
 * 取 brain 看板上下文（§10.5）。
 *
 * 不是整块板全文，而是「当前活跃窗口（近 N 条）+ 板元数据 + 花名册」。
 * 冻结快照模式（15.0 设计原则 2）—— 组装一次保护 prompt cache。
 * 大成果附件（diff/长文档）存文件，板上只存引用 + 摘要（§10.5）。
 *
 * @param taskId  板 id
 * @param windowSize 近 N 条发言（默认 20）
 */
export function getBoardContext(taskId: string, windowSize: number = 20): BoardContext | null {
  const meta = getBoardMeta(taskId);
  if (!meta) return null;
  return {
    meta,
    members: getBoardMembers(taskId),
    recentMessages: getRecentBoardMessages(taskId, windowSize),
    totalMessages: getBoardThreadCount(taskId),
  };
}

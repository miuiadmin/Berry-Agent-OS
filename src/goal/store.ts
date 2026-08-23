/**
 * L3 goal — goals 表 DAO（骨架篇 §6.8）。
 *
 * 经 persist 连接面自行 prepared statement（纪律同 memory Store——语义在 goal、
 * 连接治理在 persist）。写入方是 tools（goal_set/goal_update）、命令（resume/stop）、
 * 预算刹车（addUsage 刹停）与 boot 降级（demoteActive）——转移合法性由调用侧
 * 先经 machine.ts 判定，本层不做二次裁决（单一执法点纪律）。
 */

import type { DatabaseConnection } from '../persist/index.js';
import type { GoalRecord, GoalStatus } from './machine.js';

/** 物理行（snake_case 直映 goals 表列） */
interface GoalRow {
  session_id: string;
  objective: string;
  token_budget: number;
  tokens_used: number;
  status: string;
  stop_reason: string | null;
  evidence: string | null;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}

/** 行 → 语义记录（status 列由写入方保证五值词汇，读侧不再校验） */
function toRecord(row: GoalRow): GoalRecord {
  return {
    sessionId: row.session_id,
    objective: row.objective,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    status: row.status as GoalStatus,
    stopReason: row.stop_reason as GoalRecord['stopReason'],
    evidence: row.evidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  };
}

/** goals 表语义层（goal 插件闭包持有；全部同步——better-sqlite3 同步面） */
export class GoalStore {
  private readonly connection: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.connection = connection;
  }

  /** 读当前会话的 goal 行（无行返回 undefined） */
  get(sessionId: string): GoalRecord | undefined {
    const row = this.connection.prepare('SELECT * FROM goals WHERE session_id = ?').get(sessionId) as
      GoalRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * goal_set 落库（insert-or-replace 语义）：无行插入；既有行（调用侧已保证
   * 非 active）整体重设——objective/预算换新、tokens_used 归零、回到 active。
   */
  setActive(sessionId: string, objective: string, tokenBudget: number, now: number): void {
    this.connection
      .prepare(
        `INSERT INTO goals (session_id, objective, token_budget, tokens_used, status, stop_reason, evidence, created_at, updated_at, settled_at)
         VALUES (?, ?, ?, 0, 'active', NULL, NULL, ?, ?, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
           objective = excluded.objective,
           token_budget = excluded.token_budget,
           tokens_used = 0,
           status = 'active',
           stop_reason = NULL,
           evidence = NULL,
           updated_at = excluded.updated_at,
           settled_at = NULL`,
      )
      .run(sessionId, objective, tokenBudget, now, now);
  }

  /** /goal resume：needs-resume ⇒ active（时间戳与状态复位） */
  reactivate(sessionId: string, now: number): void {
    this.connection
      .prepare(`UPDATE goals SET status = 'active', updated_at = ? WHERE session_id = ?`)
      .run(now, sessionId);
  }

  /** boot 降级：active ⇒ needs-resume（激活权不跨进程——§6.7 拍板落码形态） */
  demoteToNeedsResume(sessionId: string, now: number): void {
    this.connection
      .prepare(`UPDATE goals SET status = 'needs-resume', updated_at = ? WHERE session_id = ? AND status = 'active'`)
      .run(now, sessionId);
  }

  /**
   * 模型申报终态（goal_update）：completed/blocked 落 evidence、终态时间戳。
   * 调用侧已保证当前 active（machine.canUpdateGoal）。
   */
  settleDeclared(sessionId: string, status: 'completed' | 'blocked', evidence: string, now: number): void {
    this.connection
      .prepare(`UPDATE goals SET status = ?, evidence = ?, updated_at = ?, settled_at = ? WHERE session_id = ?`)
      .run(status, evidence, now, now, sessionId);
  }

  /** /goal stop：⇒ stopped（reason user；预算刹车走 settleByBudget） */
  stopByUser(sessionId: string, now: number): void {
    this.connection
      .prepare(
        `UPDATE goals SET status = 'stopped', stop_reason = 'user', updated_at = ?, settled_at = ? WHERE session_id = ?`,
      )
      .run(now, now, sessionId);
  }

  /** 预算刹车：⇒ stopped（reason budget）+ tokens_used 记到当前累计值 */
  stopByBudget(sessionId: string, tokensUsed: number, now: number): void {
    this.connection
      .prepare(
        `UPDATE goals SET status = 'stopped', stop_reason = 'budget', tokens_used = ?, updated_at = ?, settled_at = ?
         WHERE session_id = ? AND status = 'active'`,
      )
      .run(tokensUsed, now, now, sessionId);
  }

  /**
   * 记账（预算刹车的累加面）：tokens_used += delta 并返回累加后的 goal 行
   * （返回值供调用方做 ≥ 预算判定——读改写同语句，无并发窗口）。无行/no-op。
   */
  addUsage(sessionId: string, delta: number, now: number): GoalRecord | undefined {
    this.connection
      .prepare(`UPDATE goals SET tokens_used = tokens_used + ?, updated_at = ? WHERE session_id = ?`)
      .run(delta, now, sessionId);
    return this.get(sessionId);
  }
}

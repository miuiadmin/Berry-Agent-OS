/**
 * L3 goal — goals 表 DAO（骨架篇 §6.8；第三十九批 T1-B goal id 一等改造）。
 *
 * 经 persist 连接面自行 prepared statement（纪律同 memory Store——语义在 goal、
 * 连接治理在 persist）。写入方是 tools（goal_set/goal_update）、命令（resume/stop）、
 * 预算刹车（addUsage 刹停）与 boot 降级（demoteActive）——转移合法性由调用侧
 * 先经 machine.ts 判定，本层不做二次裁决（单一执法点纪律）。
 *
 * v13 后行语义：goal_id 主键一行一目标，session_id 只是「当前会话引用」——
 * 同会话目标史可多行并存（终态行留史），「每会话至多一条激活目标」由
 * idx_goals_session_active partial unique index 硬执法（绕过调用侧判定直接
 * INSERT 第二条 active 行会吃 SQLITE_CONSTRAINT）。读 API 三分：
 *   getByGoalId(id)            —— 身份直取（账本/命令 [goalId] 形态）
 *   getActiveBySession(sid)    —— 激活行直取（续跑/投递/记账的法定对象）
 *   getBySession(sid)          —— 当前行（active 优先，其次 needs-resume，
 *                                  再次最新行——渲染与命令判据用）
 */

import { randomBytes } from 'node:crypto';
import type { DatabaseConnection } from '../persist/index.js';
import type { GoalRecord, GoalStatus } from './machine.js';

/** 物理行（snake_case 直映 goals 表 v13 列） */
interface GoalRow {
  goal_id: string;
  session_id: string | null;
  objective: string;
  token_budget: number;
  tokens_used: number;
  status: string;
  stop_reason: string | null;
  evidence: string | null;
  needs_write: number;
  wake_schedule: string | null;
  activated_seq: number | null;
  summary: string | null;
  summary_seq: number | null;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}

/** Crockford base32 字母表（ULID 形短标识编码用——去 I/L/O/U 防抄写混淆） */
const CROCKFORD32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 生成新 goal 身份（ULID 形 26 字符：10 字符时间序 + 16 字符随机）。
 *
 * 为什么件内自带而不 import memory/id.ts：拓扑白名单 goal 不可依赖 memory
 * （goal → contracts/context/persist），20 行生成器不值得为它开一条边。
 * 时间序段给「按 id 排序 ≈ 按创建排序」的弱保证（同毫秒内随机段无序——
 * goalId 的硬要求只有唯一性，80 位随机已把碰撞概率压到工程零）。
 */
export function newGoalId(): string {
  // 时间序段：48 位 Unix 毫秒 → 10 字符（每位 5 bit，50 bit 容量 ≥ 48）
  let ms = Date.now();
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD32[ms % 32] + timePart;
    ms = Math.floor(ms / 32);
  }
  // 随机段：80 位 CSPRNG → 16 字符（逐字节入位桶，攒够 5 bit 吐一字符）
  const bytes = randomBytes(10);
  let randPart = '';
  let acc = 0; // 位桶（≤ 12 bit，安全移位窗口内）
  let bits = 0; // 桶内现存位数
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      randPart += CROCKFORD32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return timePart + randPart;
}

/** 行 → 语义记录（status 列由写入方保证五值词汇，读侧不再校验） */
function toRecord(row: GoalRow): GoalRecord {
  return {
    goalId: row.goal_id,
    sessionId: row.session_id,
    objective: row.objective,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    status: row.status as GoalStatus,
    stopReason: row.stop_reason as GoalRecord['stopReason'],
    evidence: row.evidence,
    needsWrite: row.needs_write === 1,
    wakeSchedule: row.wake_schedule,
    activatedSeq: row.activated_seq,
    summary: row.summary,
    summarySeq: row.summary_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  };
}

/** goals 表语义层（goal 应用闭包持有；全部同步——better-sqlite3 同步面） */
export class GoalStore {
  private readonly connection: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.connection = connection;
  }

  /** 身份直取：goalId → 行（命令 [goalId] 形态 / 账本回读） */
  getByGoalId(goalId: string): GoalRecord | undefined {
    const row = this.connection.prepare('SELECT * FROM goals WHERE goal_id = ?').get(goalId) as GoalRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * 当前行读取：active 优先 → needs-resume → 最新行（updated_at 倒序）。
   * 渲染与命令判据用；续跑/投递/记账请走 getActiveBySession（法定激活行）。
   */
  getBySession(sessionId: string): GoalRecord | undefined {
    const row = this.connection
      .prepare(
        `SELECT * FROM goals WHERE session_id = ?
         ORDER BY (status = 'active') DESC, (status = 'needs-resume') DESC, updated_at DESC
         LIMIT 1`,
      )
      .get(sessionId) as GoalRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /** 激活行直取（无 active 行返回 undefined——续跑/投递/记账的法定对象） */
  getActiveBySession(sessionId: string): GoalRecord | undefined {
    const row = this.connection
      .prepare(`SELECT * FROM goals WHERE session_id = ? AND status = 'active'`)
      .get(sessionId) as GoalRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * goal_set 落库（v13 重设 = 纯 INSERT 新行）：调用侧已保证当前无 active 行
   * （machine.canSetGoal）；既有终态/降级行留史不动，新行拿新 goalId、
   * tokens_used 归零、状态 active。activatedSeq = goal-scoped fold 激活锚
   * （宿主日志长度——sessions 服务 logLength 单源，防数组下标冒充全日志位置；
   * 无路由落点时 null = 锚缺席，fold 诚实降级 run-scoped）。
   */
  setActive(
    sessionId: string,
    objective: string,
    tokenBudget: number,
    needsWrite: boolean,
    now: number,
    activatedSeq: number | null = null,
  ): GoalRecord {
    const goalId = newGoalId();
    this.connection
      .prepare(
        `INSERT INTO goals (goal_id, session_id, objective, token_budget, tokens_used, status, stop_reason,
                            evidence, needs_write, wake_schedule, activated_seq, summary, summary_seq,
                            created_at, updated_at, settled_at)
         VALUES (?, ?, ?, ?, 0, 'active', NULL, NULL, ?, NULL, ?, NULL, NULL, ?, ?, NULL)`,
      )
      .run(goalId, sessionId, objective, tokenBudget, needsWrite ? 1 : 0, activatedSeq, now, now);
    return this.getByGoalId(goalId)!;
  }

  /**
   * /goal resume [goalId]：needs-resume ⇒ active，并把行重绑到发起会话
   * （跨会话领养——旧行 sessionId 换新，历史会话不再持有该行）。
   * 调用侧已保证 needs-resume 态（machine.canResumeGoal）。activatedSeq =
   * 激活锚同步刷新（刀二：重绑到新会话即新锚——新会话日志长度，计划态从
   * 重新授权点重新折叠；调用侧传宿主单源长度面取值）。
   */
  reactivate(goalId: string, sessionId: string, now: number, activatedSeq: number | null = null): void {
    this.connection
      .prepare(
        `UPDATE goals SET status = 'active', session_id = ?, activated_seq = ?, updated_at = ? WHERE goal_id = ?`,
      )
      .run(sessionId, activatedSeq, now, goalId);
  }

  /** boot 降级：active ⇒ needs-resume（激活权不跨进程——§6.7 拍板落码形态；按会话扫激活行） */
  demoteToNeedsResume(sessionId: string, now: number): void {
    this.connection
      .prepare(`UPDATE goals SET status = 'needs-resume', updated_at = ? WHERE session_id = ? AND status = 'active'`)
      .run(now, sessionId);
  }

  /**
   * 模型申报终态（goal_update）：completed/blocked 落 evidence、终态时间戳。
   * 调用侧已保证行 active（machine.canUpdateGoal）；按 goalId 定点结算。
   */
  settleDeclared(goalId: string, status: 'completed' | 'blocked', evidence: string, now: number): void {
    this.connection
      .prepare(`UPDATE goals SET status = ?, evidence = ?, updated_at = ?, settled_at = ? WHERE goal_id = ?`)
      .run(status, evidence, now, now, goalId);
  }

  /** /goal stop：⇒ stopped（reason user；预算刹车走 stopByBudget、反空转走 stopByStalls） */
  stopByUser(goalId: string, now: number): void {
    this.connection
      .prepare(
        `UPDATE goals SET status = 'stopped', stop_reason = 'user', updated_at = ?, settled_at = ? WHERE goal_id = ?`,
      )
      .run(now, now, goalId);
  }

  /** 预算刹车：⇒ stopped（reason budget）+ tokens_used 记到当前累计值（按会话找激活行——事件信封面只有 sessionId） */
  stopByBudget(sessionId: string, tokensUsed: number, now: number): void {
    this.connection
      .prepare(
        `UPDATE goals SET status = 'stopped', stop_reason = 'budget', tokens_used = ?, updated_at = ?, settled_at = ?
         WHERE session_id = ? AND status = 'active'`,
      )
      .run(tokensUsed, now, now, sessionId);
  }

  /**
   * 记账（预算刹车的累加面）：激活行 tokens_used += delta 并返回累加后的行
   * （返回值供调用方做 ≥ 预算判定——读改写同语句，无并发窗口）。
   * 无激活行 no-op 返回 undefined；按会话定位（事件信封面只有 sessionId）。
   */
  addUsage(sessionId: string, delta: number, now: number): GoalRecord | undefined {
    this.connection
      .prepare(
        `UPDATE goals SET tokens_used = tokens_used + ?, updated_at = ? WHERE session_id = ? AND status = 'active'`,
      )
      .run(delta, now, sessionId);
    return this.getActiveBySession(sessionId);
  }

  /**
   * 挂钟节奏写面（第四刀 /goal wake 与 scheduler 迟到注入的消费位——列形状
   * 先行落本刀）：schedule 词法复用 scheduler 三形状（once@/every@/daily@），
   * null = 摘除挂钟。合法性由调用侧（命令面词法校验）保证。
   */
  updateWakeSchedule(goalId: string, schedule: string | null, now: number): void {
    this.connection
      .prepare(`UPDATE goals SET wake_schedule = ?, updated_at = ? WHERE goal_id = ?`)
      .run(schedule, now, goalId);
  }

  /**
   * 沉淀产物缓存写面（第四刀沉淀④步消费位——列形状先行落本刀）：
   * summary 全量替换、summary_seq 记水位（事实源是 goal/summary durable
   * 事件——本列只是缓存，丢列可从事件回放重建）。
   */
  recordSummary(goalId: string, summary: string, summarySeq: number, now: number): void {
    this.connection
      .prepare(`UPDATE goals SET summary = ?, summary_seq = ?, updated_at = ? WHERE goal_id = ?`)
      .run(summary, summarySeq, now, goalId);
  }
}

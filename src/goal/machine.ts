/**
 * L3 goal — 状态机纯函数（骨架篇 §6.8）。
 *
 * 五值状态：active（激活续跑中）| needs-resume（进程重启降级——激活权不跨进程，
 * 待人类 /goal resume 重新授权）| completed（完成——必须附证据）| blocked（阻塞——
 * 附原因）| stopped（停——reason 列 budget 预算尽 / user 人工停）。
 *
 * 本文件只做转移合法性判定与续跑裁决（纯函数零 IO）——落库走 store、执法
 * （响亮拒绝）在 tools/命令调用侧按判定结果抛码。转移表：
 *
 *   无行 / 终态行(completed|blocked|stopped) / needs-resume --goal_set--> active（重设）
 *   active --goal_update--> completed|blocked（模型申报终态）
 *   active --boot resume 降级--> needs-resume（激活权不持久化，§6.7 拍板）
 *   needs-resume --/goal resume--> active（人类重新授权）
 *   active|needs-resume|blocked --/goal stop--> stopped(user)
 *   active --预算尽--> stopped(budget)（预算刹车自动结算）
 */

/** goal 行（store 读出的语义形态——驼峰列） */
export interface GoalRecord {
  readonly sessionId: string;
  readonly objective: string;
  readonly tokenBudget: number;
  readonly tokensUsed: number;
  readonly status: GoalStatus;
  /** stopped 专用：budget（预算尽）| user（人工停）；其余状态为 null */
  readonly stopReason: 'budget' | 'user' | null;
  /** completed 申报证据 / blocked 阻塞原因；其余状态为 null */
  readonly evidence: string | null;
  /** 续跑轮工具面开洞申请（第二十四批题3a）：true = goal_set 申报需要写/执行，续跑轮不收窄工具面 */
  readonly needsWrite: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 终态落点时间戳；进行态（active/needs-resume）为 null */
  readonly settledAt: number | null;
}

/** 状态五值（§6.8 状态机词汇——与 goals.status 列同源） */
export type GoalStatus = 'active' | 'needs-resume' | 'completed' | 'blocked' | 'stopped';

/** 终态三值（可被 goal_set 覆盖重设的行） */
const SETTLED_STATUSES: readonly GoalStatus[] = ['completed', 'blocked', 'stopped'];

/** goal_set 准入：无行 / 终态行 / needs-resume 可设（active 行占位即拒——GOAL_ACTIVE_EXISTS） */
export function canSetGoal(current: GoalRecord | undefined): boolean {
  if (current === undefined) return true;
  return current.status !== 'active';
}

/** /goal resume 准入：仅 needs-resume（激活权在人类——唯一重新授权路） */
export function canResumeGoal(current: GoalRecord | undefined): boolean {
  return current?.status === 'needs-resume';
}

/** /goal stop 准入：进行中三态可停（completed/stopped 已是终态，停无意义） */
export function canStopGoal(current: GoalRecord | undefined): boolean {
  if (current === undefined) return false;
  return current.status === 'active' || current.status === 'needs-resume' || current.status === 'blocked';
}

/** goal_update（模型申报终态）准入：仅 active（降级/停/已完成态申报无意义） */
export function canUpdateGoal(current: GoalRecord | undefined): boolean {
  return current?.status === 'active';
}

/**
 * 续跑裁决（§6.8 续跑触发）：run 以 completed 结算 + goal 激活 + 预算未尽
 * 三条件同时成立才续跑。failed/aborted 不续跑（防续跑死循环）；预算尽由
 * 预算刹车先行结算 stopped，此处判 active 即天然不续（双保险）。
 */
export function shouldContinueGoal(
  goal: GoalRecord | undefined,
  settledStatus: 'completed' | 'aborted' | 'failed',
): boolean {
  if (goal === undefined || goal.status !== 'active') return false;
  if (settledStatus !== 'completed') return false;
  return goal.tokensUsed < goal.tokenBudget;
}

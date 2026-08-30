/**
 * L3 goal — 状态机纯函数（骨架篇 §6.8；第三十九批 goal 循环批扩形）。
 *
 * 五值状态：active（激活续跑中）| needs-resume（进程重启降级——激活权不跨进程，
 * 待人类 /goal resume 重新授权）| completed（完成——必须附证据）| blocked（阻塞——
 * 附原因）| stopped（停——reason 列 budget 预算尽 / stalls 反空转燃尽 / user 人工停）。
 *
 * 本文件只做转移合法性判定与续跑裁决（纯函数零 IO）——落库走 store、执法
 * （响亮拒绝）在 tools/命令调用侧按判定结果抛码。转移表（v13 goal id 一等后
 * 重设 = 新 goalId 新行，终态行留史不覆盖）：
 *
 *   无 active 行 / 终态行(completed|blocked|stopped) / needs-resume --goal_set--> active（新行重设）
 *   active --goal_update--> completed|blocked（模型申报终态）
 *   active --boot resume 降级--> needs-resume（激活权不持久化，§6.7 拍板）
 *   needs-resume --/goal resume [goalId]--> active（人类重新授权；可跨会话领养重绑）
 *   active|needs-resume|blocked --/goal stop--> stopped(user)
 *   active --预算尽--> stopped(budget)（预算刹车自动结算）
 *   active --反空转燃尽--> stopped(stalls)（第四批刀接线，词面先行扩入）
 */

/** goal 行（store 读出的语义形态——驼峰列） */
export interface GoalRecord {
  /** 一等身份（件内 ULID 形短标识；v13 前存量行 = 32 位十六进制迁移回填） */
  readonly goalId: string;
  /** 当前会话引用（可空可重绑：NULL = 未绑定活载体——仅历史/领养前降级行，不参与续跑、投递、记账） */
  readonly sessionId: string | null;
  readonly objective: string;
  readonly tokenBudget: number;
  readonly tokensUsed: number;
  readonly status: GoalStatus;
  /** stopped 专用：budget（预算尽）| stalls（反空转燃尽）| user（人工停）；其余状态为 null */
  readonly stopReason: 'budget' | 'stalls' | 'user' | null;
  /** completed 申报证据 / blocked 阻塞原因；其余状态为 null */
  readonly evidence: string | null;
  /** 续跑轮工具面开洞申请（第二十四批题3a）：true = goal_set 申报需要写/执行，续跑轮不收窄工具面 */
  readonly needsWrite: boolean;
  /** 挂钟节奏（once@/every@/daily@ 词法复用 scheduler 三形状；NULL = 无挂钟——第四批刀接线） */
  readonly wakeSchedule: string | null;
  /** goal-scoped fold 激活锚（宿主单源日志长度；NULL = 不可考，fold 诚实降级 run-scoped） */
  readonly activatedSeq: number | null;
  /** 轮间沉淀产物缓存（事实源 = goal/summary durable 事件；列只是缓存，丢可回填） */
  readonly summary: string | null;
  /** 沉淀水位（上次沉淀覆盖到的 durable seq 锚；未沉淀为 null） */
  readonly summarySeq: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 终态落点时间戳；进行态（active/needs-resume）为 null */
  readonly settledAt: number | null;
}

/** 状态五值（§6.8 状态机词汇——与 goals.status 列同源） */
export type GoalStatus = 'active' | 'needs-resume' | 'completed' | 'blocked' | 'stopped';

/** 终态三值（释放 active 位——同会话新 goal_set 可入） */
const SETTLED_STATUSES: readonly GoalStatus[] = ['completed', 'blocked', 'stopped'];

/**
 * 轮结算申报四值（第三十九批 T4-A——goal_update 轮结算分支的 outcome 词汇）：
 * - surface_only：只完成了表面动作（改了展示面/打印了信息），离目标无实质推进；
 * - outcome_gap：尝试了对结果的修改但没生效（测试仍红/构建仍败）；
 * - outcome_progress：对结果有实质推进（测试转绿/文件落地），但目标未完成；
 * - primary_goal_outcome：目标本身的结果已交付（唯一可在 completed 申报时缺席
 *   open 项检查的通道——机器可验判据 gates 只认此值）。
 */
export type DeliveryOutcome = 'surface_only' | 'outcome_gap' | 'outcome_progress' | 'primary_goal_outcome';

/** 轮结算四值词面（工具参数枚举执法 + 测试真值表共用） */
export const DELIVERY_OUTCOMES: readonly DeliveryOutcome[] = [
  'surface_only',
  'outcome_gap',
  'outcome_progress',
  'primary_goal_outcome',
];

/** unknown 值是否轮结算四值词面（typebox 枚举之外的守卫——事件回读/测试造值用） */
export function isDeliveryOutcome(value: unknown): value is DeliveryOutcome {
  return typeof value === 'string' && (DELIVERY_OUTCOMES as readonly string[]).includes(value);
}

/** goal_set 准入：无 active 行 / 终态行 / needs-resume 可设（active 行占位即拒——GOAL_ACTIVE_EXISTS） */
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

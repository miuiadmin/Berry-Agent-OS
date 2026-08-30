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
 *   active --反空转燃尽--> stopped(stalls)（刀三接线——stallsDecision 判据）
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

/* ---------------- 刀三：唤醒帽（wakeGate 双帽）+ 停滞判定 + 到窗复评 ---------------- */

/**
 * 自激连续帽（§6.8 刀三 T5-A）：goal 尾部连续 self 唤醒轮达此数即拒发——
 * 与驱动帽 MAX_CONSECUTIVE_WAKES 各司其职互不裁决（冷读 CR-21：驱动帽管
 * 「一条会话被连续叫醒多少次」，本帽管「这个 goal 自激了多少轮」）。可调不可关。
 */
export const MAX_CONSECUTIVE_SELF_WAKES = 3;

/** 唤醒窗口宽（24h）——窗口帽的时间范围（可调不可关） */
export const WAKE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 窗口唤醒帽（§6.8 刀三）：单 goal 24h 窗口内唤醒总数达此数即拒发（不分
 * wakePath 按 goalId 合流——tick 路 self 路同账）。可调不可关。
 */
export const MAX_WINDOW_WAKES = 12;

/**
 * 唤醒帽扫描事件（user/message durable 事件的结构子集——GoalSessionsFace
 * .eventsOfType 读出形；纯函数只消费 time + data.attribution）。
 */
export interface WakeScanEvent {
  /**
   * 毫秒时间戳（事件信封 time）。GoalSessionsFace 读出形可选——合成事件
   * （测试/降级路）无信封时间戳时缺席 = 视为窗外不计（诚实降级不抛错）。
   */
  readonly time?: number;
  /** user/message 载荷（归因键值对在其 attribution 键） */
  readonly data?: unknown;
}

/** user/message 载荷的归因读取（结构守卫——载荷形状不对视为无归因） */
function attributionOf(data: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const attribution = (data as { attribution?: unknown }).attribution;
  if (typeof attribution !== 'object' || attribution === null) return undefined;
  return attribution as Readonly<Record<string, string>>;
}

/** 唤醒帽裁决：allow 或拒因（consecutive = 连续自激帽 / window = 窗口帽） */
export type WakeGateDecision =
  { readonly allow: true } | { readonly allow: false; readonly reason: 'consecutive' | 'window' };

/**
 * 唤醒帽单源执法（§6.8 刀三 T5-A「执法点 = wakeGate(goalId) 单源函数」）。
 *
 * 双帽判据（自激路投递前调用；正在发送的唤醒尚未入日志，不计入）：
 * - **连续帽**：从日志尾倒扫连续满足「source='app:goal' 且 attribution.goalId
 *   命中且 wakePath='self'」的 user/message——首条不满足即断；计数 ≥
 *   MAX_CONSECUTIVE_SELF_WAKES 拒发（reason 'consecutive'）。只计 self 段：
 *   tick 路唤醒不在其列（挂钟轮到点不属自激失控面）。
 * - **窗口帽**：全日志扫 attribution.goalId 命中（任何 wakePath）且 time 落在
 *   (now - WAKE_WINDOW_MS, now] 窗内的 user/message——计数 ≥ MAX_WINDOW_WAKES
 *   拒发（reason 'window'）。不分路径按 goalId 合流——tick 与 self 同账，
 *   「白天挂钟叫了 12 次」后自激路同样拒发。
 *
 * 超帽动作 = 暂停投递非终态停（调用方落 goal/evidence reason='capped'
 * willRetry=true——goal 仍 active，下一 run 结算或到窗后再试）。
 */
export function wakeGate(input: {
  readonly goalId: string;
  readonly now: number;
  readonly events: readonly WakeScanEvent[];
}): WakeGateDecision {
  // 连续帽：尾倒扫 self 段
  let consecutive = 0;
  for (let i = input.events.length - 1; i >= 0; i--) {
    const event = input.events[i]!;
    const data = event.data;
    if (typeof data !== 'object' || data === null) break;
    const carrier = data as { source?: unknown; attribution?: unknown };
    if (carrier.source !== 'app:goal') break;
    const attribution = attributionOf(data);
    if (attribution?.goalId !== input.goalId || attribution.wakePath !== 'self') break;
    consecutive++;
    if (consecutive >= MAX_CONSECUTIVE_SELF_WAKES) return { allow: false, reason: 'consecutive' };
  }
  // 窗口帽：goalId 合流（不分 wakePath），只数窗内（time 缺席 = 窗外不计）
  const windowStart = input.now - WAKE_WINDOW_MS;
  let windowCount = 0;
  for (const event of input.events) {
    if (event.time === undefined || event.time <= windowStart) continue;
    if (attributionOf(event.data)?.goalId !== input.goalId) continue;
    windowCount++;
    if (windowCount >= MAX_WINDOW_WAKES) return { allow: false, reason: 'window' };
  }
  return { allow: true };
}

/**
 * 停滞判定扫描事件（goal/evidence durable 事件的结构子集——轮结算 outcome
 * 申报与停因事件共用一个日志词汇，纯函数按载荷形状分拣）。
 */
export interface EvidenceScanEvent {
  /** 载荷（outcome 申报形 { goalId, outcome, ... } 或停因形 { goalId, reason, ... }） */
  readonly data?: unknown;
}

/** 停滞判定产物（§6.8 刀三停滞三信号——续跑指令分支与硬停判据） */
export interface StallsDecision {
  /** 当前 era（自上次实质推进起）连续 surface_only 轮数 */
  readonly surfaceOnlyStreak: number;
  /** 当前 era 连续 outcome_gap 轮数 */
  readonly gapStreak: number;
  /** 当前 era 内 gap 幕数（≥2 连续 gap 记一幕） */
  readonly gapEpisodes: number;
  /** replan 义务：gapStreak ≥ 2（改了没生效两轮——该换打法而非再试同路） */
  readonly needsReplan: boolean;
  /** 产出地板恢复义务：surfaceOnlyStreak ≥ 2（表面动作两轮——重估 needsWrite） */
  readonly needsFloorRecovery: boolean;
  /** 硬停：surfaceOnlyStreak ≥ 3 或 gapEpisodes ≥ 2（反空转燃尽 stopped stalls） */
  readonly hardStop: boolean;
}

/**
 * 停滞判定（§6.8 刀三 T5-A 反空转燃尽判据）——goal/evidence 事件流的纯函数。
 *
 * era 切分：自**最后一条** outcome_progress / primary_goal_outcome 起的后缀
 * （实质推进开新纪元）；停因事件（reason 在场的 budget/capped/stalls 载荷）
 * 断一切 streak——预算帽拒发轮不折算成模型停滞（帽与停滞各归各账）。
 * gap 幕 = era 内连续 outcome_gap 的极大段长 ≥ 2（单次 gap 是正常迭代）。
 */
export function stallsDecision(goalId: string, events: readonly EvidenceScanEvent[]): StallsDecision {
  // era 起点：尾倒扫找最后一条实质推进或停因事件（两者都开新段）；全程无界
  //（目标从未实质推进过）= 全日志即本 era（初值 0——空段会让「3 轮全
  // surface_only 从未推进」的极端形态漏判 hardStop）
  let eraStart = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = (events[i]!.data ?? {}) as Record<string, unknown>;
    if (payload.goalId !== goalId) continue;
    if (payload.reason !== undefined) {
      eraStart = i + 1; // 停因事件开新段（其后是下一段的轮结算）
      break;
    }
    if (payload.outcome === 'outcome_progress' || payload.outcome === 'primary_goal_outcome') {
      eraStart = i + 1;
      break;
    }
  }
  let surfaceOnlyStreak = 0;
  let gapStreak = 0;
  let gapEpisodes = 0;
  for (let i = eraStart; i < events.length; i++) {
    const payload = (events[i]!.data ?? {}) as Record<string, unknown>;
    if (payload.goalId !== goalId || payload.outcome === undefined) continue;
    if (payload.outcome === 'surface_only') {
      // 表面轮断 gap 段（先结算段再累计自家 streak）
      if (gapStreak >= 2) gapEpisodes++;
      gapStreak = 0;
      surfaceOnlyStreak++;
    } else if (payload.outcome === 'outcome_gap') {
      if (surfaceOnlyStreak > 0) surfaceOnlyStreak = 0;
      gapStreak++;
    } else {
      // 实质推进（era 内罕见的后续推进——重开段计数，保持 era 语义简单）
      if (gapStreak >= 2) gapEpisodes++;
      gapStreak = 0;
      surfaceOnlyStreak = 0;
    }
  }
  // 段尾结算（尾段仍在 era 内未闭合）
  if (gapStreak >= 2) gapEpisodes++;
  return {
    surfaceOnlyStreak,
    gapStreak,
    gapEpisodes,
    needsReplan: gapStreak >= 2,
    needsFloorRecovery: surfaceOnlyStreak >= 2,
    hardStop: surfaceOnlyStreak >= 3 || gapEpisodes >= 2,
  };
}

/**
 * 复活条件词法解析（§6.8 刀三到窗复评——v1 严格两形，解析失败 undefined：
 * 缺席/坏形状 = 不点亮，诚实降级不抛错）：
 * - `after@<ISO>`：绝对时刻（Date.parse 可解析的 ISO 串）；
 * - `after@+<n>[mhd]`：相对此刻偏移（n 正整数；m 分 / h 时 / d 天）。
 * @returns 到窗毫秒时刻；不可解析返回 undefined
 */
export function parseResumeWhen(spec: string, now: number): number | undefined {
  if (!spec.startsWith('after@')) return undefined;
  const body = spec.slice('after@'.length);
  // 相对形：+<n><unit>
  if (body.startsWith('+')) {
    const match = /^([1-9][0-9]*)([mhd])$/.exec(body.slice(1));
    if (match === null) return undefined;
    const amount = Number(match[1]);
    const unitMs = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000;
    return now + amount * unitMs;
  }
  // 绝对形：ISO 时刻（NaN / Invalid Date 均拒）
  const parsed = Date.parse(body);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * 到窗 deferred 项盘点（§6.8 刀三——续跑 prompt 点名「到窗该复评了」的数据面）：
 * status='deferred' 且 resumeWhen 可解析且已到窗（≤ now）的项的 resumeWhen 原文清单。
 * 返回原文而非时刻——prompt 点名的是模型自己写下的复活条件（原文即约定）。
 *
 * **判窗锚 = 条目写入时刻**（fold 投影字段 writtenAt，§6.8 T2-A 判窗锚条款）：
 * 相对形 `+<n>[mhd]` 自写入时刻起算——按复评时刻起算则任意复评点恒在未来 =
 * 永不触窗死路；绝对形 ISO 是固有点不受锚影响。锚缺席（非 fold 造物/降级路）=
 * 相对形不可判诚实不点亮（降级锚 = 复评时刻，相对形天然落窗外）。
 */
export function dueDeferredItems(
  items: readonly { readonly status: string; readonly resumeWhen?: string; readonly writtenAt?: number }[],
  now: number,
): string[] {
  const due: string[] = [];
  for (const item of items) {
    if (item.status !== 'deferred' || item.resumeWhen === undefined) continue;
    // 相对锚 = 条目写入时刻；缺席降级 = 复评时刻（相对形自此恒在未来 → 不点亮）
    const at = parseResumeWhen(item.resumeWhen, item.writtenAt ?? now);
    if (at !== undefined && at <= now) due.push(item.resumeWhen);
  }
  return due;
}

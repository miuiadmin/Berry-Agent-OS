/**
 * L3 scheduler — schedule 声明词法与 due 判定纯函数（内核边界篇 §4.1 席 13
 * 第二刀 K2-b：三形状 parse + 补拍/迟到语义）。
 *
 * 三形状词法（我定——第二十四批拍板④范围；cron 全语法挂账不预付）：
 * - `once@<ISO>`   一次性：ISO 8601 时刻（无时区后缀 = 本地时区——与 daily
 *   同语义）；跑过即生命周期终；
 * - `every@<n>[mhd]` 间隔：n 分钟/小时/天（n 正整数）——错过多窗只补一次
 *   （due 是布尔判定，跑后基点推进到触发时刻，不追跑历史窗）；
 * - `daily@HH:MM`  每日：本地时区 HH:MM（DST 变天由 JS Date 本地构造天然
 *   跟随——春季不存在时刻按平台偏移解释，已知边界不特判）。
 *
 * 全函数无 I/O、时钟全参数注入（parse 的 once 过去时刻校验与 due 判定的
 * now 都由调用方传入——命令面接 deps.now，测试冻结）。
 */

/** every@ 间隔下限（毫秒）——防自旋的声明层执法（词法最小单位已是 m，本闸
 *  主要挡手编库与未来词法扩展；60s = 词法最小 every@1m 恰好重合） */
export const MIN_REFIRE_GAP_MS = 60_000;

/** once@ 迟到容忍窗（毫秒）——过窗未触发记 missed 不跑（迟到的一次性任务
 *  多半已无意义，跑反而烧钱；TICK_TIMEOUT_MS 同数级） */
export const ONCE_GRACE_MS = 10 * 60_000;

/** 三形状结构化产物（parse 成功形——kind 判别） */
export type Schedule =
  | { readonly kind: 'once'; readonly at: number }
  | { readonly kind: 'every'; readonly intervalMs: number }
  | { readonly kind: 'daily'; readonly hour: number; readonly minute: number };

/** parse 结果：成功携结构化形状 / 失败携人读错误（命令面回执直用） */
export type ScheduleParse =
  { readonly ok: true; readonly schedule: Schedule } | { readonly ok: false; readonly error: string };

/** schedule 词法前缀（命令面嗅探「第二词是不是 schedule 声明」用） */
const SCHEDULE_PREFIX = /^(once|every|daily)@/;

/** 嗅探：声明串是否形如 schedule（三前缀任一——add 命令面的可选参数分界） */
export function looksLikeSchedule(text: string): boolean {
  return SCHEDULE_PREFIX.test(text);
}

/** every@ 数量与单位（n 正整数 + m/h/d 单字母单位） */
const EVERY_RE = /^every@([1-9][0-9]*)([mhd])$/;

/** daily@ 时刻（HH:MM 两位冒号制——00:00 至 23:59） */
const DAILY_RE = /^daily@([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** 单字母单位 → 毫秒 */
const UNIT_MS: Record<'m' | 'h' | 'd', number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * 解析 schedule 声明串（存库原样串的执法面——add 当场校验，坏串拒入库）。
 * @param text 声明串（如 `daily@08:30` / `every@2h` / `once@2026-09-01T09:00`）
 * @param now 判定「现在」（once@ 过去时刻 = 配置错误当场拒）
 * @param options.allowPast true = 容忍 once@ 过去时刻（K2-c：tick 到点编排
 *   重解析存量行时时刻已过是正常态——done/missed 判定的前提；过去与否的
 *   时机裁决交还 evaluateDue，词法层只管串形。缺省 false = add 面严格拒）
 */
export function parseSchedule(
  text: string,
  now: number,
  options: { readonly allowPast?: boolean } = {},
): ScheduleParse {
  const matchEvery = EVERY_RE.exec(text);
  if (matchEvery !== null) {
    const n = Number(matchEvery[1]);
    const unit = matchEvery[2] as 'm' | 'h' | 'd';
    const intervalMs = n * UNIT_MS[unit];
    // 下限闸：词法最小 every@1m 恰好等于 MIN_REFIRE_GAP——正常路径不触，
    // 手编库/未来词法扩展的防线（n×单位小于下限即拒）
    if (intervalMs < MIN_REFIRE_GAP_MS) {
      return { ok: false, error: `间隔过短（${text}）：最小 ${MIN_REFIRE_GAP_MS / 60_000} 分钟——防自旋` };
    }
    return { ok: true, schedule: { kind: 'every', intervalMs } };
  }
  const matchDaily = DAILY_RE.exec(text);
  if (matchDaily !== null) {
    return {
      ok: true,
      schedule: { kind: 'daily', hour: Number(matchDaily[1]), minute: Number(matchDaily[2]) },
    };
  }
  if (text.startsWith('once@')) {
    const iso = text.slice('once@'.length);
    // Date.parse：合法 ISO 8601 才有值；无时区后缀按本地时区解释（与 daily 同语义）
    const at = Date.parse(iso);
    if (Number.isNaN(at)) {
      return { ok: false, error: `once@ 时刻不合法：${iso}（ISO 8601，如 once@2026-09-01T09:00）` };
    }
    // 过去时刻拒是 add 面策略（配置错误当场拒）非词法——tick 重解析路
    // allowPast 放行，让 evaluateDue 裁 done/missed/fire-in-grace
    if (at <= now && options.allowPast !== true) {
      return { ok: false, error: `once@ 时刻已过（${iso}）——一次性任务须指向未来` };
    }
    return { ok: true, schedule: { kind: 'once', at } };
  }
  return {
    ok: false,
    error: `无法识别的 schedule：${text}（三形状：once@<ISO> / every@<n>[mhd] / daily@HH:MM）`,
  };
}

/**
 * due 判定（三形状统一出口——K2-c `run --tick` 编排读行后先问这里）。
 *
 * @param schedule 结构化形状（parseSchedule 产物）
 * @param lastRunAt 最近触发时刻（从未跑 = null）
 * @param createdAt 建行时刻（首 fire 的基点——lastRunAt 为空时从建行起算）
 * @param now 判定「现在」
 * @returns fire=该跑 / wait=未到（携下次时刻）/ done=once 已跑（生命周期终）/
 *   missed=once 迟到超窗从未跑（记因不跑）
 */
export function evaluateDue(schedule: Schedule, lastRunAt: number | null, createdAt: number, now: number): DueDecision {
  // 基点：上次触发时刻，从未跑则从建行起算（once 已跑 = 生命周期终，先判）
  const anchor = lastRunAt ?? createdAt;
  switch (schedule.kind) {
    case 'every': {
      // 补拍只补一次：due 是布尔（now >= 基点+间隔），跑后 lastRunAt 推进，
      // 错过 N 窗与错过 1 窗同判——不追跑历史（烧钱护栏）
      const nextAt = anchor + schedule.intervalMs;
      return now >= nextAt ? { action: 'fire' } : { action: 'wait', nextAt };
    }
    case 'daily': {
      // 基点之后的下一个本地 HH:MM（当日已过即次日）——已跑当日该时刻后
      // 自然推到明日，天然「每日至多一跑」
      const nextAt = nextDailyAt(schedule, anchor);
      return now >= nextAt ? { action: 'fire' } : { action: 'wait', nextAt };
    }
    case 'once': {
      if (lastRunAt !== null) return { action: 'done' };
      if (now < schedule.at) return { action: 'wait', nextAt: schedule.at };
      // 迟到判定在「已到点」分支内做：窗内 = 迟到但可跑，过窗 = missed
      if (now > schedule.at + ONCE_GRACE_MS) return { action: 'missed' };
      return { action: 'fire' };
    }
  }
}

/** due 判定结果（action 判别联合） */
export type DueDecision =
  | { readonly action: 'fire' }
  | { readonly action: 'wait'; readonly nextAt: number }
  | { readonly action: 'done' }
  | { readonly action: 'missed' };

/**
 * 基点之后的下一个本地时区 HH:MM 时刻（daily 形状的 nextAt 计算件）。
 * 当日 HH:MM 严格晚于基点则当日，否则次日（跨月/跨年由 Date 构造天然进位）。
 */
function nextDailyAt(schedule: { hour: number; minute: number }, anchor: number): number {
  const base = new Date(anchor);
  // 先试当日 HH:MM；不晚于基点（<= anchor）则推次日——严格晚于才有效，
  // 恰好等于基点时推次日（基点时刻本身已「消费」过）
  const today = new Date(base.getFullYear(), base.getMonth(), base.getDate(), schedule.hour, schedule.minute);
  return today.getTime() > anchor ? today.getTime() : today.getTime() + 86_400_000;
}

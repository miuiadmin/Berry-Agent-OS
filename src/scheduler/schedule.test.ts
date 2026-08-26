/**
 * L3 scheduler — schedule 词法与 due 判定纯函数单测（席 13 第二刀 K2-b）。
 *
 * 三形状 parse 正负例 + due 四态（fire/wait/done/missed）+ 补拍只补一次
 * + 每日至多一跑 + once 迟到 grace 窗边界。全注入无 I/O——时钟冻结逐点断言。
 */

import { describe, expect, it } from 'vitest';
import { parseSchedule, looksLikeSchedule, evaluateDue, MIN_REFIRE_GAP_MS, ONCE_GRACE_MS } from './schedule.js';

/* ---------------- parse：三形状正负例 ---------------- */

describe('parseSchedule：every@<n>[mhd]', () => {
  it('三单位各自成数（m/h/d → 毫秒换算）', () => {
    const now = 1_000_000;
    expect(parseSchedule('every@1m', now)).toEqual({ ok: true, schedule: { kind: 'every', intervalMs: 60_000 } });
    expect(parseSchedule('every@90m', now)).toEqual({ ok: true, schedule: { kind: 'every', intervalMs: 5_400_000 } });
    expect(parseSchedule('every@2h', now)).toEqual({ ok: true, schedule: { kind: 'every', intervalMs: 7_200_000 } });
    expect(parseSchedule('every@1d', now)).toEqual({ ok: true, schedule: { kind: 'every', intervalMs: 86_400_000 } });
  });

  it('负例：零/前导零/负数/小数/坏单位/秒单位/低于下限', () => {
    const now = 1_000_000;
    for (const bad of [
      'every@0m',
      'every@01m',
      'every@-5m',
      'every@1.5h',
      'every@30s',
      'every@5x',
      'every@',
      'every@m',
    ]) {
      expect(parseSchedule(bad, now).ok).toBe(false);
    }
    // 下限闸：词法最小 every@1m 恰好等于 MIN_REFIRE_GAP——正常过闸
    expect(parseSchedule('every@1m', now).ok).toBe(true);
    expect(MIN_REFIRE_GAP_MS).toBe(60_000);
  });
});

describe('parseSchedule：daily@HH:MM', () => {
  it('边界时刻合法（00:00 / 23:59 / 08:30）', () => {
    const now = 1_000_000;
    expect(parseSchedule('daily@00:00', now)).toEqual({ ok: true, schedule: { kind: 'daily', hour: 0, minute: 0 } });
    expect(parseSchedule('daily@23:59', now)).toEqual({ ok: true, schedule: { kind: 'daily', hour: 23, minute: 59 } });
    expect(parseSchedule('daily@08:30', now)).toEqual({ ok: true, schedule: { kind: 'daily', hour: 8, minute: 30 } });
  });

  it('负例：24 时 / 60 分 / 一位数 / 坏分隔', () => {
    const now = 1_000_000;
    for (const bad of ['daily@24:00', 'daily@08:60', 'daily@8:30', 'daily@0830', 'daily@08:30:00', 'daily@']) {
      expect(parseSchedule(bad, now).ok).toBe(false);
    }
  });
});

describe('parseSchedule：once@<ISO>', () => {
  it('未来时刻合法（本地无后缀与显式 Z 各自成数）', () => {
    const now = Date.parse('2026-08-26T12:00:00'); // 本地
    const futureLocal = parseSchedule('once@2026-08-27T09:00', now);
    expect(futureLocal.ok).toBe(true);
    if (futureLocal.ok) {
      expect(futureLocal.schedule.kind).toBe('once');
      expect((futureLocal.schedule as { at: number }).at).toBe(Date.parse('2026-08-27T09:00'));
    }
    const futureZ = parseSchedule('once@2026-08-27T09:00:00Z', now);
    expect(futureZ.ok).toBe(true);
  });

  it('负例：过去时刻（配置错误当场拒）/ 坏 ISO / 裸 once@', () => {
    const now = Date.parse('2026-08-26T12:00:00');
    expect(parseSchedule('once@2026-08-25T09:00', now).ok).toBe(false); // 已过
    const past = parseSchedule('once@2026-08-25T09:00', now);
    if (!past.ok) expect(past.error).toContain('已过');
    expect(parseSchedule('once@not-a-date', now).ok).toBe(false);
    expect(parseSchedule('once@', now).ok).toBe(false);
  });

  it('未知前缀 → 人读错误（三形状提示）', () => {
    const result = parseSchedule('weekly@mon', 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('once@');
  });
});

describe('looksLikeSchedule：前缀嗅探', () => {
  it('三前缀真 / 非声明词假（add 命令面的可选参数分界）', () => {
    expect(looksLikeSchedule('daily@08:30')).toBe(true);
    expect(looksLikeSchedule('every@2h')).toBe(true);
    expect(looksLikeSchedule('once@2026-09-01T09:00')).toBe(true);
    expect(looksLikeSchedule('daily')).toBe(false); // 无 @ 不是声明——是普通 prompt 词
    expect(looksLikeSchedule('巡检')).toBe(false);
    expect(looksLikeSchedule('')).toBe(false);
  });
});

/* ---------------- evaluateDue：四态判定 ---------------- */

describe('evaluateDue：every（补拍只补一次）', () => {
  const schedule = { kind: 'every', intervalMs: 3_600_000 } as const;

  it('未到 wait（携下次时刻）/ 到点 fire', () => {
    const createdAt = 1_000_000;
    expect(evaluateDue(schedule, null, createdAt, createdAt + 3_599_999)).toEqual({
      action: 'wait',
      nextAt: createdAt + 3_600_000,
    });
    expect(evaluateDue(schedule, null, createdAt, createdAt + 3_600_000)).toEqual({ action: 'fire' });
  });

  it('错过 5 窗与错过 1 窗同判 fire——不追跑历史（跑后基点推进即合并）', () => {
    const createdAt = 1_000_000;
    const late = createdAt + 5 * 3_600_000;
    const decision = evaluateDue(schedule, null, createdAt, late);
    expect(decision).toEqual({ action: 'fire' }); // 布尔判定——不携带「欠 5 次」
    // 跑后 lastRunAt=跑时 → 下窗从跑时重算（补拍只补一次的兑现）
    const after = evaluateDue(schedule, late, createdAt, late);
    expect(after).toEqual({ action: 'wait', nextAt: late + 3_600_000 });
  });
});

describe('evaluateDue：daily（每日至多一跑）', () => {
  // 固定本地日做锚：2026-08-26 当地 08:30 due
  const dayStart = new Date(2026, 7, 26, 0, 0).getTime();
  const dueAt = new Date(2026, 7, 26, 8, 30).getTime();
  const schedule = { kind: 'daily', hour: 8, minute: 30 } as const;

  it('当日时刻未到 wait / 到点 fire / 建行晚于当日时刻则顺延次日', () => {
    expect(evaluateDue(schedule, null, dayStart, dueAt - 1)).toEqual({ action: 'wait', nextAt: dueAt });
    expect(evaluateDue(schedule, null, dayStart, dueAt)).toEqual({ action: 'fire' });
    // 建行时刻已是当日 10:00（晚于 08:30）→ 首窗 = 次日 08:30
    const lateCreate = new Date(2026, 7, 26, 10, 0).getTime();
    const tomorrowDue = new Date(2026, 7, 27, 8, 30).getTime();
    expect(evaluateDue(schedule, null, lateCreate, lateCreate)).toEqual({ action: 'wait', nextAt: tomorrowDue });
  });

  it('当日已跑 → 下一窗顺延次日（每日至多一跑）', () => {
    const ranAt = new Date(2026, 7, 26, 8, 30).getTime();
    const laterSameDay = new Date(2026, 7, 26, 20, 0).getTime();
    const tomorrowDue = new Date(2026, 7, 27, 8, 30).getTime();
    expect(evaluateDue(schedule, ranAt, dayStart, laterSameDay)).toEqual({ action: 'wait', nextAt: tomorrowDue });
  });

  it('跨月进位：8 月 31 日 23:50 跑后 → 9 月 1 日窗（Date 构造天然进位）', () => {
    const aug31Late = new Date(2026, 7, 31, 23, 50).getTime();
    const sep1Due = new Date(2026, 8, 1, 8, 30).getTime();
    expect(evaluateDue(schedule, aug31Late, aug31Late, aug31Late)).toEqual({ action: 'wait', nextAt: sep1Due });
  });
});

describe('evaluateDue：once（fire / wait / done / missed 四态）', () => {
  const at = 5_000_000;
  const schedule = { kind: 'once', at } as const;

  it('未到 wait / 到点（含迟到窗内）fire', () => {
    expect(evaluateDue(schedule, null, 1, at - 1)).toEqual({ action: 'wait', nextAt: at });
    expect(evaluateDue(schedule, null, 1, at)).toEqual({ action: 'fire' });
    // 迟到窗内（grace 尾前 1ms）仍可跑——迟到一次性任务补拍
    expect(evaluateDue(schedule, null, 1, at + ONCE_GRACE_MS - 1)).toEqual({ action: 'fire' });
  });

  it('grace 边界：窗整点仍 fire，过窗即 missed（记因不跑）', () => {
    expect(evaluateDue(schedule, null, 1, at + ONCE_GRACE_MS)).toEqual({ action: 'fire' });
    expect(evaluateDue(schedule, null, 1, at + ONCE_GRACE_MS + 1)).toEqual({ action: 'missed' });
  });

  it('已跑 → done（生命周期终——不再触发）', () => {
    expect(evaluateDue(schedule, at, 1, at + 86_400_000)).toEqual({ action: 'done' });
  });
});

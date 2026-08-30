/**
 * L3 goal — 状态机纯函数测试（machine.ts 全转移表覆盖，零 IO 纯逻辑）。
 *
 * 五值 × 四判定函数（canSet/canResume/canStop/canUpdate）+ 续跑裁决三条件
 * （completed 结算 / active / 预算未尽）——真值表逐格锁死，落库侧（store）与
 * 执法侧（tools/命令）各自另有集成测试。
 */

import { describe, expect, it } from 'vitest';
import type { GoalRecord, GoalStatus } from './machine.js';
import {
  canResumeGoal,
  canSetGoal,
  canStopGoal,
  canUpdateGoal,
  shouldContinueGoal,
  isDeliveryOutcome,
  DELIVERY_OUTCOMES,
} from './machine.js';

/** 造一行 goal（status 可覆写——其余字段任意合法值；v13 起新字段全覆盖缺省态） */
function row(status: GoalStatus): GoalRecord {
  return {
    goalId: '01JD5ZZZZZZZZZZZZZZZZZZZZZ',
    sessionId: 's1',
    objective: '把 goal 纵切落完',
    tokenBudget: 5000,
    tokensUsed: 100,
    status,
    stopReason: status === 'stopped' ? 'budget' : null,
    evidence: status === 'completed' || status === 'blocked' ? '证据' : null,
    needsWrite: false,
    wakeSchedule: null,
    activatedSeq: null,
    summary: null,
    summarySeq: null,
    createdAt: 1,
    updatedAt: 2,
    settledAt: status === 'completed' || status === 'blocked' || status === 'stopped' ? 3 : null,
  };
}

describe('isDeliveryOutcome / DELIVERY_OUTCOMES（轮结算四值词面——T4-A）', () => {
  it('四值全收；近形词与非字符串全拒（守卫不放宽）', () => {
    for (const v of DELIVERY_OUTCOMES) {
      expect(isDeliveryOutcome(v)).toBe(true);
    }
    expect(isDeliveryOutcome('surface')).toBe(false); // 截词近形
    expect(isDeliveryOutcome('OUTCOME_PROGRESS')).toBe(false); // 大写近形
    expect(isDeliveryOutcome('')).toBe(false);
    expect(isDeliveryOutcome(undefined)).toBe(false);
    expect(isDeliveryOutcome(42)).toBe(false);
    expect(isDeliveryOutcome({ outcome: 'surface_only' })).toBe(false);
  });

  it('词面恰四值（顺序即申报语义梯度——表面→缺口→推进→交付）', () => {
    expect(DELIVERY_OUTCOMES).toEqual(['surface_only', 'outcome_gap', 'outcome_progress', 'primary_goal_outcome']);
  });
});

describe('canSetGoal（goal_set 准入：active 占位即拒）', () => {
  it('无行 / 终态三值 / needs-resume 均可设', () => {
    expect(canSetGoal(undefined)).toBe(true);
    expect(canSetGoal(row('completed'))).toBe(true);
    expect(canSetGoal(row('blocked'))).toBe(true);
    expect(canSetGoal(row('stopped'))).toBe(true);
    expect(canSetGoal(row('needs-resume'))).toBe(true);
  });

  it('active 唯一被拒（一目标一占位——先申报终态或 /goal stop）', () => {
    expect(canSetGoal(row('active'))).toBe(false);
  });
});

describe('canResumeGoal（/goal resume 准入：唯一重新授权路）', () => {
  it('仅 needs-resume 放行；无行与其余四态全拒', () => {
    expect(canResumeGoal(row('needs-resume'))).toBe(true);
    expect(canResumeGoal(undefined)).toBe(false);
    expect(canResumeGoal(row('active'))).toBe(false);
    expect(canResumeGoal(row('completed'))).toBe(false);
    expect(canResumeGoal(row('blocked'))).toBe(false);
    expect(canResumeGoal(row('stopped'))).toBe(false);
  });
});

describe('canStopGoal（/goal stop 准入：进行中三态可停）', () => {
  it('active / needs-resume / blocked 放行；无行与终态（completed/stopped）拒', () => {
    expect(canStopGoal(row('active'))).toBe(true);
    expect(canStopGoal(row('needs-resume'))).toBe(true);
    expect(canStopGoal(row('blocked'))).toBe(true);
    expect(canStopGoal(row('completed'))).toBe(false); // 已完成——停无意义
    expect(canStopGoal(row('stopped'))).toBe(false); // 已停——幂等语义在命令面提示
    expect(canStopGoal(undefined)).toBe(false); // 无目标可停
  });
});

describe('canUpdateGoal（goal_update 模型申报准入：仅 active）', () => {
  it('active 放行；无行与降级/终态全拒（needs-resume 先 /goal resume）', () => {
    expect(canUpdateGoal(row('active'))).toBe(true);
    expect(canUpdateGoal(undefined)).toBe(false);
    expect(canUpdateGoal(row('needs-resume'))).toBe(false);
    expect(canUpdateGoal(row('completed'))).toBe(false);
    expect(canUpdateGoal(row('blocked'))).toBe(false);
    expect(canUpdateGoal(row('stopped'))).toBe(false);
  });
});

describe('shouldContinueGoal（续跑裁决：completed 结算 + active + 预算未尽三条件）', () => {
  it('三条件齐备才续跑', () => {
    expect(shouldContinueGoal(row('active'), 'completed')).toBe(true);
  });

  it('failed / aborted 结算不续（防续跑死循环）', () => {
    expect(shouldContinueGoal(row('active'), 'failed')).toBe(false);
    expect(shouldContinueGoal(row('active'), 'aborted')).toBe(false);
  });

  it('非 active 不续（boot 降级 / 人工停 / 已申报终态均停跑）', () => {
    expect(shouldContinueGoal(row('needs-resume'), 'completed')).toBe(false);
    expect(shouldContinueGoal(row('stopped'), 'completed')).toBe(false);
    expect(shouldContinueGoal(row('completed'), 'completed')).toBe(false);
    expect(shouldContinueGoal(undefined, 'completed')).toBe(false);
  });

  it('预算尽不续（tokensUsed ≥ tokenBudget——预算刹车的双保险半边）', () => {
    const exhausted = { ...row('active'), tokensUsed: 5000 };
    expect(shouldContinueGoal(exhausted, 'completed')).toBe(false);
    // 恰好等线也停（剩余 0 无可推进）
    const exact = { ...row('active'), tokensUsed: 4999, tokenBudget: 4999 };
    expect(shouldContinueGoal(exact, 'completed')).toBe(false);
  });
});

/* ---------------- 刀三：唤醒帽（wakeGate）+ 停滞判定（stallsDecision）+ 到窗复评 ---------------- */

import {
  wakeGate,
  stallsDecision,
  parseResumeWhen,
  dueDeferredItems,
  MAX_CONSECUTIVE_SELF_WAKES,
  MAX_WINDOW_WAKES,
  WAKE_WINDOW_MS,
} from './machine.js';
import type { WakeScanEvent, EvidenceScanEvent } from './machine.js';

/** 造一条 user/message 扫描事件（wakeGate 输入形——source/attribution/time 三要素） */
function wakeEvent(at: { source?: string; goalId?: string; wakePath?: string; time?: number }): WakeScanEvent {
  return {
    ...(at.time !== undefined ? { time: at.time } : {}),
    ...(at.source === undefined && at.goalId === undefined
      ? { data: {} }
      : {
          data: {
            ...(at.source !== undefined ? { source: at.source } : {}),
            ...(at.goalId !== undefined || at.wakePath !== undefined
              ? {
                  attribution: {
                    ...(at.goalId !== undefined ? { goalId: at.goalId } : {}),
                    ...(at.wakePath !== undefined ? { wakePath: at.wakePath } : {}),
                  },
                }
              : {}),
          },
        }),
  };
}

const NOW = 1_700_000_000_000;

describe('wakeGate（唤醒帽双帽——刀三 T5-A 执法单源）', () => {
  it('帽值钉死：连续自激帽 3 / 窗口帽 12 / 窗口 24h（可调不可关——改值须过本测）', () => {
    expect(MAX_CONSECUTIVE_SELF_WAKES).toBe(3);
    expect(MAX_WINDOW_WAKES).toBe(12);
    expect(WAKE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('连续帽：尾部连续 self 唤醒达 3 即拒（reason consecutive）', () => {
    const self = () => wakeEvent({ source: 'app:goal', goalId: 'G1', wakePath: 'self', time: NOW });
    const decision = wakeGate({
      goalId: 'G1',
      now: NOW,
      events: [self(), self(), self()],
    });
    expect(decision).toEqual({ allow: false, reason: 'consecutive' });
  });

  it('连续帽恰在线下放行（2 条 self——第 3 条才是本投递）', () => {
    const self = () => wakeEvent({ source: 'app:goal', goalId: 'G1', wakePath: 'self', time: NOW });
    expect(wakeGate({ goalId: 'G1', now: NOW, events: [self(), self()] })).toEqual({ allow: true });
  });

  it('用户手写消息断段（source 非 app:goal）——尾部倒扫首条不满足即断，历史段不计', () => {
    const events = [
      wakeEvent({ source: 'app:goal', goalId: 'G1', wakePath: 'self', time: NOW - 5000 }),
      wakeEvent({ source: 'user', time: NOW - 4000 }), // 用户手写恢复预算
      wakeEvent({ source: 'app:goal', goalId: 'G1', wakePath: 'self', time: NOW - 3000 }),
    ];
    expect(wakeGate({ goalId: 'G1', now: NOW, events })).toEqual({ allow: true });
  });

  it('他 goal 的唤醒同样断段（attribution.goalId 不命中即断）', () => {
    const events = [
      wakeEvent({ source: 'app:goal', goalId: 'G1', wakePath: 'self', time: NOW - 3000 }),
      wakeEvent({ source: 'app:goal', goalId: 'G2', wakePath: 'self', time: NOW - 2000 }),
      wakeEvent({ source: 'app:goal', goalId: 'G1', wakePath: 'self', time: NOW - 1000 }),
    ];
    // G1 尾段只有 1 条（G2 夹断）——放行
    expect(wakeGate({ goalId: 'G1', now: NOW, events })).toEqual({ allow: true });
  });

  it('tick 路唤醒不计连续帽（挂钟轮到点不属自激失控面——只进窗口帽的账）', () => {
    const events = [
      wakeEvent({ source: 'app:goal', goalId: 'G1', wakePath: 'tick', time: NOW - 3000 }),
      wakeEvent({ source: 'app:goal', goalId: 'G1', wakePath: 'tick', time: NOW - 2000 }),
      wakeEvent({ source: 'app:goal', goalId: 'G1', wakePath: 'tick', time: NOW - 1000 }),
    ];
    expect(wakeGate({ goalId: 'G1', now: NOW, events })).toEqual({ allow: true });
  });

  it('窗口帽：24h 窗内同 goal 唤醒（不分 wakePath）达 12 即拒（reason window）', () => {
    const events: WakeScanEvent[] = [];
    for (let i = 0; i < MAX_WINDOW_WAKES; i++) {
      events.push(wakeEvent({ source: 'app:goal', goalId: 'G1', wakePath: 'tick', time: NOW - i * 1000 }));
    }
    expect(wakeGate({ goalId: 'G1', now: NOW, events })).toEqual({ allow: false, reason: 'window' });
  });

  it('窗外老唤醒不计（恰在窗口起点 = 窗外，开区间）；他 goal 窗内不计', () => {
    const events = [
      // 恰在 windowStart（= now - 24h）——不进窗
      wakeEvent({ source: 'app:goal', goalId: 'G1', wakePath: 'self', time: NOW - WAKE_WINDOW_MS }),
      // 他 goal 的窗内唤醒
      wakeEvent({ source: 'app:goal', goalId: 'G2', wakePath: 'self', time: NOW - 1000 }),
    ];
    expect(wakeGate({ goalId: 'G1', now: NOW, events })).toEqual({ allow: true });
  });

  it('time 缺席的合成事件不进窗口账（诚实降级——GoalSessionsFace 读出形可选）', () => {
    const events: WakeScanEvent[] = [wakeEvent({ source: 'app:goal', goalId: 'G1', wakePath: 'self' })];
    expect(wakeGate({ goalId: 'G1', now: NOW, events })).toEqual({ allow: true });
  });

  it('双帽同时超时连续帽先裁（consecutive 优先——更陡的失速信号）', () => {
    const events: WakeScanEvent[] = [];
    for (let i = 0; i < MAX_WINDOW_WAKES; i++) {
      events.push(wakeEvent({ source: 'app:goal', goalId: 'G1', wakePath: 'tick', time: NOW - i * 1000 }));
    }
    events.push(wakeEvent({ source: 'app:goal', goalId: 'G1', wakePath: 'self', time: NOW }));
    events.push(wakeEvent({ source: 'app:goal', goalId: 'G1', wakePath: 'self', time: NOW }));
    events.push(wakeEvent({ source: 'app:goal', goalId: 'G1', wakePath: 'self', time: NOW }));
    expect(wakeGate({ goalId: 'G1', now: NOW, events })).toEqual({ allow: false, reason: 'consecutive' });
  });
});

/** 造一条 goal/evidence 扫描事件（轮结算形或停因形——data 载荷即分拣面） */
function evidenceEvent(goalId: string, payload: Record<string, unknown>): EvidenceScanEvent {
  return { data: { goalId, ...payload } };
}

describe('stallsDecision（停滞三信号——era 切分纯函数）', () => {
  it('空账本零信号（首轮结算前不误判）', () => {
    expect(stallsDecision('G1', [])).toEqual({
      surfaceOnlyStreak: 0,
      gapStreak: 0,
      gapEpisodes: 0,
      needsReplan: false,
      needsFloorRecovery: false,
      hardStop: false,
    });
  });

  it('era 无边界 = 全日志即本 era：3 轮 surface_only 从未推进 → hardStop（eraStart 初值 0 的存在理由）', () => {
    const events = [
      evidenceEvent('G1', { outcome: 'surface_only' }),
      evidenceEvent('G1', { outcome: 'surface_only' }),
      evidenceEvent('G1', { outcome: 'surface_only' }),
    ];
    const decision = stallsDecision('G1', events);
    expect(decision.surfaceOnlyStreak).toBe(3);
    expect(decision.hardStop).toBe(true);
  });

  it('surface 2 轮 = needsFloorRecovery 义务但未到硬停线', () => {
    const events = [evidenceEvent('G1', { outcome: 'surface_only' }), evidenceEvent('G1', { outcome: 'surface_only' })];
    const decision = stallsDecision('G1', events);
    expect(decision.needsFloorRecovery).toBe(true);
    expect(decision.hardStop).toBe(false);
  });

  it('实质推进开新 era：推进前的停滞段清零不累计', () => {
    const events = [
      evidenceEvent('G1', { outcome: 'surface_only' }),
      evidenceEvent('G1', { outcome: 'surface_only' }),
      evidenceEvent('G1', { outcome: 'outcome_progress' }),
      evidenceEvent('G1', { outcome: 'surface_only' }),
    ];
    const decision = stallsDecision('G1', events);
    expect(decision.surfaceOnlyStreak).toBe(1);
    expect(decision.hardStop).toBe(false);
  });

  it('gap 2 轮 = needsReplan 义务（单幕未到硬停线）', () => {
    const events = [evidenceEvent('G1', { outcome: 'outcome_gap' }), evidenceEvent('G1', { outcome: 'outcome_gap' })];
    const decision = stallsDecision('G1', events);
    expect(decision.gapStreak).toBe(2);
    expect(decision.gapEpisodes).toBe(1);
    expect(decision.needsReplan).toBe(true);
    expect(decision.hardStop).toBe(false);
  });

  it('幕间推进开新 era：第一幕被切走（era 内只见第二幕——幕数 era 内累计不跨纪元）', () => {
    const events = [
      evidenceEvent('G1', { outcome: 'outcome_gap' }),
      evidenceEvent('G1', { outcome: 'outcome_gap' }),
      evidenceEvent('G1', { outcome: 'outcome_progress' }), // 推进 = era 边界
      evidenceEvent('G1', { outcome: 'outcome_gap' }),
      evidenceEvent('G1', { outcome: 'outcome_gap' }),
    ];
    const decision = stallsDecision('G1', events);
    expect(decision.gapEpisodes).toBe(1); // 只有新 era 的第二幕在账
    expect(decision.hardStop).toBe(false);
  });

  it('gap 幕 ≥ 2 → hardStop：同 era 内 surface 隔开的两幕（surface 断 gap 段但不开 era）', () => {
    const events = [
      evidenceEvent('G1', { outcome: 'outcome_gap' }),
      evidenceEvent('G1', { outcome: 'outcome_gap' }),
      evidenceEvent('G1', { outcome: 'surface_only' }), // 断 gap 段结算第一幕
      evidenceEvent('G1', { outcome: 'outcome_gap' }),
      evidenceEvent('G1', { outcome: 'outcome_gap' }),
    ];
    const decision = stallsDecision('G1', events);
    expect(decision.gapEpisodes).toBe(2);
    expect(decision.hardStop).toBe(true);
  });

  it('单次 gap 是正常迭代（幕长 ≥ 2 才记幕）', () => {
    const events = [
      evidenceEvent('G1', { outcome: 'surface_only' }),
      evidenceEvent('G1', { outcome: 'outcome_gap' }),
      evidenceEvent('G1', { outcome: 'surface_only' }),
    ];
    const decision = stallsDecision('G1', events);
    expect(decision.gapEpisodes).toBe(0);
    expect(decision.surfaceOnlyStreak).toBe(1); // gap 断 surface 段
    expect(decision.hardStop).toBe(false);
  });

  it('停因事件断一切 streak 并开新 era（预算帽拒发轮不折算成模型停滞）', () => {
    const events = [
      evidenceEvent('G1', { outcome: 'surface_only' }),
      evidenceEvent('G1', { outcome: 'surface_only' }),
      evidenceEvent('G1', { reason: 'capped', willRetry: true }), // 唤醒帽拒发
      evidenceEvent('G1', { outcome: 'surface_only' }),
    ];
    const decision = stallsDecision('G1', events);
    expect(decision.surfaceOnlyStreak).toBe(1); // 停因前 2 轮被切走
    expect(decision.hardStop).toBe(false);
  });

  it('他 goal 的账目事件不可见（goalId 过滤——多目标并行不串账）', () => {
    const events = [
      evidenceEvent('G2', { outcome: 'surface_only' }),
      evidenceEvent('G2', { outcome: 'surface_only' }),
      evidenceEvent('G2', { outcome: 'surface_only' }),
    ];
    expect(stallsDecision('G1', events).hardStop).toBe(false);
  });
});

describe('parseResumeWhen（复活条件词法——v1 严格两形）', () => {
  it('相对形 +<n>[mhd]：n 正整数，单位 m/h/d', () => {
    expect(parseResumeWhen('after@+30m', NOW)).toBe(NOW + 30 * 60_000);
    expect(parseResumeWhen('after@+2h', NOW)).toBe(NOW + 2 * 3_600_000);
    expect(parseResumeWhen('after@+1d', NOW)).toBe(NOW + 86_400_000);
  });

  it('绝对形 after@<ISO>：Date.parse 可解析即收', () => {
    expect(parseResumeWhen('after@2027-01-01T00:00:00Z', NOW)).toBe(Date.parse('2027-01-01T00:00:00Z'));
  });

  it('坏形状全拒（undefined 诚实降级不抛错）', () => {
    expect(parseResumeWhen('after@+0m', NOW)).toBeUndefined(); // 0 非正整数
    expect(parseResumeWhen('after@+1.5h', NOW)).toBeUndefined(); // 小数
    expect(parseResumeWhen('after@+1w', NOW)).toBeUndefined(); // 未知单位
    expect(parseResumeWhen('after@+2', NOW)).toBeUndefined(); // 无单位
    expect(parseResumeWhen('after+', NOW)).toBeUndefined(); // 空体
    expect(parseResumeWhen('after@', NOW)).toBeUndefined();
    expect(parseResumeWhen('after@not-a-date', NOW)).toBeUndefined(); // 坏 ISO
    expect(parseResumeWhen('before@+1h', NOW)).toBeUndefined(); // 非法前缀
    expect(parseResumeWhen('+1h', NOW)).toBeUndefined(); // 无前缀
  });
});

describe('dueDeferredItems（到窗 deferred 盘点——续跑 prompt 点名面）', () => {
  /** fold 条目最小形（status + resumeWhen + 判窗锚 writtenAt 三消费键） */
  const item = (status: string, resumeWhen?: string, writtenAt?: number) => ({
    status,
    ...(resumeWhen !== undefined ? { resumeWhen } : {}),
    ...(writtenAt !== undefined ? { writtenAt } : {}),
  });

  it('deferred 且到窗 → resumeWhen 原文进清单（锚 = 写入时刻：+30m/+1h 自 NOW 起算，扫时过 2h 双到）', () => {
    const due = dueDeferredItems(
      [item('deferred', 'after@+30m', NOW), item('deferred', 'after@+1h', NOW)],
      NOW + 2 * 3_600_000,
    );
    expect(due).toEqual(['after@+30m', 'after@+1h']);
  });

  it('未到窗 / 非 deferred / 无条件 / 坏词法 / 锚缺席相对形 → 不进清单', () => {
    const due = dueDeferredItems(
      [
        item('deferred', 'after@+2h', NOW), // 未到窗（写入后只过 1h）
        item('pending', 'after@+1m', NOW), // 非 deferred
        item('deferred', undefined, NOW), // 无 resumeWhen
        item('deferred', 'when-ready', NOW), // 坏词法不可解析
        item('deferred', 'after@+1h'), // writtenAt 缺席 = 相对形不可判（诚实不点亮）
      ],
      NOW + 3_600_000,
    );
    expect(due).toEqual([]);
  });

  it('恰在窗上 = 到窗（≤ now 闭区间；锚 NOW + 1h 偏移扫时恰达）', () => {
    const at = parseResumeWhen('after@+1h', NOW)!;
    expect(dueDeferredItems([item('deferred', 'after@+1h', NOW)], at)).toEqual(['after@+1h']);
  });

  it('同清单不同写入时刻分别判窗（重写即重申——rewrite 后 +1h 自新写入时刻滑窗）', () => {
    // 同字面 '+1h'：老条目写入于 NOW（已过窗）；新条目重写于 NOW+30m（还差半时）
    const due = dueDeferredItems(
      [item('deferred', 'after@+1h', NOW), item('deferred', 'after@+1h', NOW + 1_800_000)],
      NOW + 3_600_000,
    );
    expect(due).toEqual(['after@+1h']);
  });

  it('绝对形不受锚影响（ISO 固有点——锚缺席同样到窗）', () => {
    const past = 'after@2020-01-01T00:00:00Z';
    expect(dueDeferredItems([item('deferred', past), item('deferred', past, NOW)], NOW)).toEqual([past, past]);
  });
});

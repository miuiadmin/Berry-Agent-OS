/**
 * L3 goal — 状态机纯函数测试（machine.ts 全转移表覆盖，零 IO 纯逻辑）。
 *
 * 五值 × 四判定函数（canSet/canResume/canStop/canUpdate）+ 续跑裁决三条件
 * （completed 结算 / active / 预算未尽）——真值表逐格锁死，落库侧（store）与
 * 执法侧（tools/命令）各自另有集成测试。
 */

import { describe, expect, it } from 'vitest';
import type { GoalRecord, GoalStatus } from './machine.js';
import { canResumeGoal, canSetGoal, canStopGoal, canUpdateGoal, shouldContinueGoal } from './machine.js';

/** 造一行 goal（status 可覆写——其余字段任意合法值） */
function row(status: GoalStatus): GoalRecord {
  return {
    sessionId: 's1',
    objective: '把 goal 纵切落完',
    tokenBudget: 5000,
    tokensUsed: 100,
    status,
    stopReason: status === 'stopped' ? 'budget' : null,
    evidence: status === 'completed' || status === 'blocked' ? '证据' : null,
    createdAt: 1,
    updatedAt: 2,
    settledAt: status === 'completed' || status === 'blocked' || status === 'stopped' ? 3 : null,
  };
}

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

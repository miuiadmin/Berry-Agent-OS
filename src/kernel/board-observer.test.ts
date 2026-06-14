/**
 * board-observer 风险检测单测（16.0 §4.2 + §10.1）。
 * 钉死 detectRisks 的三类风险判定（drift/stuck/spawn_explosion）+ 两个 helper，
 * 这是 brain 看板 loop（BoardObserver→checkpoint→brain看板→纠偏）的风险触发逻辑基础。
 */
import { describe, it, expect } from 'vitest';
import { detectRisks, countTrailingBlocked, maxConsecutiveDelegateBySameAgent } from './board-observer.js';
import { BoardMessageSchema, type BoardMessage } from '../contracts/board-message.js';

function mkMsg(partial: { type: BoardMessage['type'] } & Record<string, unknown>): BoardMessage {
  return BoardMessageSchema.parse({ id: 'm', from: 'code', taskId: 't', ts: 1, ...partial }) as BoardMessage;
}

const HEALTHY_META = { turnCount: 5, maxTurns: 50, maxSpawnDepth: 3 };

describe('board-observer detectRisks（§4.2 + §10.1 风险检测）', () => {
  it('drift：turnCount ≥ maxTurns*0.8 → 发散风险', () => {
    expect(detectRisks({ turnCount: 42, maxTurns: 50, maxSpawnDepth: 3 }, [])).toContain('drift');
    expect(detectRisks({ turnCount: 40, maxTurns: 50, maxSpawnDepth: 3 }, [])).toContain('drift'); // 恰好 0.8
    expect(detectRisks(HEALTHY_META, [])).not.toContain('drift'); // 5/50 远未发散
  });

  it('stuck：末尾连续 ≥2 条 report(blocked) → 卡住风险', () => {
    const msgs = [
      mkMsg({ type: 'report', to: 'brain', summary: 'ok1', status: 'done' }),
      mkMsg({ type: 'report', to: 'brain', summary: 'blocked1', status: 'blocked' }),
      mkMsg({ type: 'report', to: 'brain', summary: 'blocked2', status: 'blocked' }),
    ];
    expect(detectRisks(HEALTHY_META, msgs)).toContain('stuck');
    // 只 1 条 blocked 不足触发
    expect(detectRisks(HEALTHY_META, [mkMsg({ type: 'report', to: 'brain', summary: 'b', status: 'blocked' })])).not.toContain('stuck');
  });

  it('spawn_explosion：同一 agent 连续 delegate > maxSpawnDepth → 递归爆炸风险', () => {
    const msgs = [
      mkMsg({ type: 'delegate', to: 'a', subTaskGoal: 'g1' }),
      mkMsg({ type: 'delegate', to: 'b', subTaskGoal: 'g2' }),
      mkMsg({ type: 'delegate', to: 'c', subTaskGoal: 'g3' }),
      mkMsg({ type: 'delegate', to: 'd', subTaskGoal: 'g4' }),
    ];
    // 4 连续 delegate > maxSpawnDepth(3) → spawn_explosion
    expect(detectRisks(HEALTHY_META, msgs)).toContain('spawn_explosion');
  });

  it('健康板：无风险 → 空数组', () => {
    const msgs = [
      mkMsg({ type: 'delegate', to: 'code', subTaskGoal: '干活' }),
      mkMsg({ type: 'report', to: 'brain', summary: 'done', status: 'done' }),
      mkMsg({ type: 'tell', to: 'all', text: '讨论' }),
    ];
    expect(detectRisks(HEALTHY_META, msgs)).toEqual([]);
  });

  it('多风险可叠加（drift + stuck 同时）', () => {
    const msgs = [
      mkMsg({ type: 'report', to: 'brain', summary: 'b1', status: 'blocked' }),
      mkMsg({ type: 'report', to: 'brain', summary: 'b2', status: 'blocked' }),
    ];
    const risks = detectRisks({ turnCount: 45, maxTurns: 50, maxSpawnDepth: 3 }, msgs);
    expect(risks).toContain('drift');
    expect(risks).toContain('stuck');
  });
});

describe('board-observer helpers', () => {
  it('countTrailingBlocked：从末尾数连续 blocked report', () => {
    expect(countTrailingBlocked([
      mkMsg({ type: 'report', to: 'b', summary: 'done', status: 'done' }),
      mkMsg({ type: 'report', to: 'b', summary: 'b1', status: 'blocked' }),
      mkMsg({ type: 'report', to: 'b', summary: 'b2', status: 'blocked' }),
    ])).toBe(2);
    // 非 blocked 打断
    expect(countTrailingBlocked([
      mkMsg({ type: 'report', to: 'b', summary: 'b', status: 'blocked' }),
      mkMsg({ type: 'tell', to: 'all', text: 'x' }),
    ])).toBe(0);
  });

  it('maxConsecutiveDelegateBySameAgent：同一 agent 连续 delegate 最大条数', () => {
    expect(maxConsecutiveDelegateBySameAgent([
      mkMsg({ type: 'delegate', to: 'a', subTaskGoal: 'g1' }),
      mkMsg({ type: 'delegate', to: 'b', subTaskGoal: 'g2' }),
      mkMsg({ type: 'tell', to: 'all', text: '打断' }),
      mkMsg({ type: 'delegate', to: 'c', subTaskGoal: 'g3' }),
    ])).toBe(2); // 前两连续，打断后重置
  });
});

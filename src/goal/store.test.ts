/**
 * L3 goal — goals 表 DAO 集成测试（GoalStore，经 persist 迁移框架建表后真库
 * :memory: SQLite，无 mock）。逐方法语义 + 转移护栏（幂等 WHERE 守卫）+
 * 重设复位（insert-or-replace 语义半边）+ 会话隔离。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../persist/index.js';
import { GOAL_MIGRATION, GoalStore } from './index.js';

/** 当前测试库（每用例新建 :memory:——迁移一次到位后交 DAO） */
let store: Store;
let db: GoalStore;

beforeEach(() => {
  store = openStore({ path: ':memory:', migrations: [GOAL_MIGRATION] });
  db = new GoalStore(store.connection);
});

describe('setActive / get：设定与读回', () => {
  it('新插：全字段落库（active / 记账 0 / 证据与终态时间戳空）', () => {
    db.setActive('s1', '完成 goal 纵切', 5000, 100);
    const goal = db.get('s1')!;
    expect(goal).toBeDefined();
    expect(goal.sessionId).toBe('s1');
    expect(goal.objective).toBe('完成 goal 纵切');
    expect(goal.tokenBudget).toBe(5000);
    expect(goal.tokensUsed).toBe(0);
    expect(goal.status).toBe('active');
    expect(goal.stopReason).toBeNull();
    expect(goal.evidence).toBeNull();
    expect(goal.createdAt).toBe(100);
    expect(goal.updatedAt).toBe(100);
    expect(goal.settledAt).toBeNull();
  });

  it('无行 get 返回 undefined；每会话单行互不串（session_id 主键）', () => {
    expect(db.get('sX')).toBeUndefined();
    db.setActive('s1', '目标甲', 1000, 100);
    db.setActive('s2', '目标乙', 2000, 200);
    expect(db.get('s1')!.objective).toBe('目标甲');
    expect(db.get('s2')!.objective).toBe('目标乙');
  });

  it('重设复位：completed 行再 setActive → 状态/记账/证据/终态时间戳全复位换新', () => {
    db.setActive('s1', '旧目标', 1000, 100);
    db.settleDeclared('s1', 'completed', '旧证据', 200);
    db.addUsage('s1', 300, 250);
    // 终态行重设（调用侧已过 canSetGoal——completed 可设）
    db.setActive('s1', '新目标', 9000, 300);
    const goal = db.get('s1')!;
    expect(goal.objective).toBe('新目标');
    expect(goal.tokenBudget).toBe(9000);
    expect(goal.tokensUsed).toBe(0); // 记账归零——新预算新账本
    expect(goal.status).toBe('active');
    expect(goal.evidence).toBeNull(); // 旧证据不残留
    expect(goal.stopReason).toBeNull();
    expect(goal.settledAt).toBeNull(); // 终态时间戳清空（回到进行态）
  });
});

describe('addUsage：预算记账', () => {
  it('累加并返回更新后的行（读改写同语句——无并发窗口）', () => {
    db.setActive('s1', '目标', 5000, 100);
    const first = db.addUsage('s1', 100, 200)!;
    expect(first.tokensUsed).toBe(100);
    const second = db.addUsage('s1', 250, 300)!;
    expect(second.tokensUsed).toBe(350);
    expect(second.updatedAt).toBe(300);
  });

  it('无行 no-op 返回 undefined（预算刹车过滤无 goal 会话的半边依赖此语义）', () => {
    expect(db.addUsage('ghost', 100, 100)).toBeUndefined();
  });
});

describe('转移方法：状态机落库半边', () => {
  it('demoteToNeedsResume：active 降级；非 active 行不动（WHERE 护栏）', () => {
    db.setActive('s1', '目标', 1000, 100);
    db.demoteToNeedsResume('s1', 200);
    expect(db.get('s1')!.status).toBe('needs-resume');
    // needs-resume 再降：no-op（不产生非法双降级形态）
    db.demoteToNeedsResume('s1', 300);
    expect(db.get('s1')!.status).toBe('needs-resume');
    // completed 行降级：WHERE 守卫拦下
    db.setActive('s2', '另一目标', 1000, 100);
    db.settleDeclared('s2', 'completed', '证据', 200);
    db.demoteToNeedsResume('s2', 300);
    expect(db.get('s2')!.status).toBe('completed');
  });

  it('reactivate：needs-resume ⇒ active（人类重新授权）', () => {
    db.setActive('s1', '目标', 1000, 100);
    db.demoteToNeedsResume('s1', 200);
    db.reactivate('s1', 300);
    const goal = db.get('s1')!;
    expect(goal.status).toBe('active');
    expect(goal.updatedAt).toBe(300);
  });

  it('settleDeclared：completed/blocked 落 evidence 与终态时间戳', () => {
    db.setActive('s1', '目标', 1000, 100);
    db.settleDeclared('s1', 'completed', '逐需求证据齐备', 200);
    let goal = db.get('s1')!;
    expect(goal.status).toBe('completed');
    expect(goal.evidence).toBe('逐需求证据齐备');
    expect(goal.settledAt).toBe(200);
    // blocked 同面（重设后再试另一半）
    db.setActive('s1', '目标二', 1000, 300);
    db.settleDeclared('s1', 'blocked', '依赖服务连续三轮不可用', 400);
    goal = db.get('s1')!;
    expect(goal.status).toBe('blocked');
    expect(goal.evidence).toBe('依赖服务连续三轮不可用');
  });

  it('stopByUser：⇒ stopped/user', () => {
    db.setActive('s1', '目标', 1000, 100);
    db.stopByUser('s1', 200);
    const goal = db.get('s1')!;
    expect(goal.status).toBe('stopped');
    expect(goal.stopReason).toBe('user');
    expect(goal.settledAt).toBe(200);
  });

  it('stopByBudget：⇒ stopped/budget + 记账定格；已停行幂等 no-op（WHERE 守卫）', () => {
    db.setActive('s1', '目标', 1000, 100);
    db.addUsage('s1', 1200, 150);
    db.stopByBudget('s1', 1200, 200);
    const stopped = db.get('s1')!;
    expect(stopped.status).toBe('stopped');
    expect(stopped.stopReason).toBe('budget');
    expect(stopped.tokensUsed).toBe(1200); // 刹停时记账定格
    // 二次刹停（竞态双触发形态）：已非 active → no-op，行纹丝不动
    db.stopByBudget('s1', 9999, 300);
    const again = db.get('s1')!;
    expect(again.tokensUsed).toBe(1200);
    expect(again.updatedAt).toBe(200); // 连时间戳都没动
  });
});

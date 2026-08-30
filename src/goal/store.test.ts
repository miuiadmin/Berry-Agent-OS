/**
 * L3 goal — goals 表 DAO 集成测试（GoalStore，经 persist 迁移框架建表后真库
 * :memory: SQLite，无 mock）。v13 goal id 一等后（第三十九批 T1-B）：逐方法
 * 语义 + partial unique index 不变式执法 + 重设新行留史 + 领养重绑 + 跨版本
 * 升级路径（v5 旧库一路升 v13）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../persist/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  migrations as goalMigrations,
  GOAL_MIGRATION,
  GOAL_NEEDS_WRITE_MIGRATION,
  GoalStore,
  newGoalId,
} from './index.js';

/** 当前测试库（每用例新建 :memory:——迁移一次到位后交 DAO） */
let store: Store;
let db: GoalStore;

beforeEach(() => {
  store = openStore({ path: ':memory:', migrations: goalMigrations });
  db = new GoalStore(store.connection);
});

describe('newGoalId：身份生成器', () => {
  it('ULID 形 26 字符 Crockford base32；批量唯一；同库可并存', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = newGoalId();
      expect(id).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it('时间序段（前 10 字符）随时钟单调不减——同毫秒内随机段兜唯一', () => {
    let prevTime = '';
    for (let i = 0; i < 20; i++) {
      const time = newGoalId().slice(0, 10);
      expect(time >= prevTime).toBe(true);
      prevTime = time;
    }
  });
});

describe('setActive / 读 API 三分：设定与读回', () => {
  it('新插：全字段落库（active / 记账 0 / 证据与终态空 / v13 四新列 NULL）', () => {
    const inserted = db.setActive('s1', '完成 goal 纵切', 5000, false, 100);
    expect(inserted.goalId).toMatch(/^[0-9A-Z]{26}$/);
    const goal = db.getBySession('s1')!;
    expect(goal).toBeDefined();
    expect(goal.goalId).toBe(inserted.goalId);
    expect(goal.sessionId).toBe('s1');
    expect(goal.objective).toBe('完成 goal 纵切');
    expect(goal.tokenBudget).toBe(5000);
    expect(goal.tokensUsed).toBe(0);
    expect(goal.status).toBe('active');
    expect(goal.stopReason).toBeNull();
    expect(goal.evidence).toBeNull();
    // v13 四新列：刀一阶段全部 NULL（挂钟/折叠锚/沉淀缓存随二四刀接线填值）
    expect(goal.wakeSchedule).toBeNull();
    expect(goal.activatedSeq).toBeNull();
    expect(goal.summary).toBeNull();
    expect(goal.summarySeq).toBeNull();
    expect(goal.createdAt).toBe(100);
    expect(goal.updatedAt).toBe(100);
    expect(goal.settledAt).toBeNull();
  });

  it('activatedSeq 显式传值落库（刀二接线面——列形状先行验证）', () => {
    db.setActive('s1', '目标', 1000, false, 100, 42);
    expect(db.getBySession('s1')!.activatedSeq).toBe(42);
  });

  it('getByGoalId 直取；getActiveBySession 只认激活行；无行 undefined', () => {
    expect(db.getBySession('sX')).toBeUndefined();
    expect(db.getActiveBySession('sX')).toBeUndefined();
    const a = db.setActive('s1', '目标甲', 1000, false, 100);
    const b = db.setActive('s2', '目标乙', 2000, false, 200);
    expect(a.goalId).not.toBe(b.goalId); // 身份唯一
    expect(db.getByGoalId(a.goalId)!.objective).toBe('目标甲');
    expect(db.getByGoalId(b.goalId)!.objective).toBe('目标乙');
    expect(db.getActiveBySession('s1')!.goalId).toBe(a.goalId);
    // 终态后：getActiveBySession 空，getBySession 仍取得到（当前行语义）
    db.settleDeclared(a.goalId, 'completed', '证据', 300);
    expect(db.getActiveBySession('s1')).toBeUndefined();
    expect(db.getBySession('s1')!.goalId).toBe(a.goalId);
  });

  it('getBySession 排序：active 优先 → needs-resume → 最新行', () => {
    // s1 建两行历史（completed 旧行 + active 新行）——active 优先命中
    const old = db.setActive('s1', '旧目标', 1000, false, 100);
    db.settleDeclared(old.goalId, 'completed', '完成', 150);
    const cur = db.setActive('s1', '新目标', 2000, false, 200);
    expect(db.getBySession('s1')!.goalId).toBe(cur.goalId);
    // active 降级后 needs-resume 命中（而非更新的 completed 历史行）
    db.demoteToNeedsResume('s1', 300);
    expect(db.getBySession('s1')!.goalId).toBe(cur.goalId);
    expect(db.getBySession('s1')!.status).toBe('needs-resume');
  });

  it('partial unique index 执法：同会话第二条 active 行直接吃约束（绕过调用侧判定）', () => {
    db.setActive('s1', '目标甲', 1000, false, 100);
    expect(() => db.setActive('s1', '目标乙', 2000, false, 200)).toThrowError(/UNIQUE/);
  });

  it('重设新行留史：completed 后 setActive → 新 goalId 新行，旧行原样在库', () => {
    const first = db.setActive('s1', '旧目标', 1000, false, 100);
    db.addUsage('s1', 300, 150);
    db.settleDeclared(first.goalId, 'completed', '旧证据', 200);
    const second = db.setActive('s1', '新目标', 9000, false, 300);
    expect(second.goalId).not.toBe(first.goalId);
    expect(db.getByGoalId(first.goalId)!.status).toBe('completed'); // 留史不动
    expect(db.getByGoalId(first.goalId)!.tokensUsed).toBe(300); // 记账定格在旧行
    const goal = db.getBySession('s1')!;
    expect(goal.goalId).toBe(second.goalId);
    expect(goal.objective).toBe('新目标');
    expect(goal.tokenBudget).toBe(9000);
    expect(goal.tokensUsed).toBe(0); // 记账归零——新预算新账本
    expect(goal.status).toBe('active');
    expect(goal.evidence).toBeNull();
    expect(goal.settledAt).toBeNull();
  });

  it('addUsage 只记激活行：历史终态行不吃别会话/后续轮的花销', () => {
    const first = db.setActive('s1', '旧目标', 1000, false, 100);
    db.settleDeclared(first.goalId, 'completed', '证据', 200);
    db.setActive('s1', '新目标', 5000, false, 300);
    db.addUsage('s1', 100, 400);
    expect(db.getByGoalId(first.goalId)!.tokensUsed).toBe(0); // 旧行纹丝不动
    expect(db.getBySession('s1')!.tokensUsed).toBe(100);
  });
});

describe('addUsage：预算记账', () => {
  it('累加并返回更新后的激活行（读改写同语句——无并发窗口）', () => {
    db.setActive('s1', '目标', 5000, false, 100);
    const first = db.addUsage('s1', 100, 200)!;
    expect(first.tokensUsed).toBe(100);
    const second = db.addUsage('s1', 250, 300)!;
    expect(second.tokensUsed).toBe(350);
    expect(second.updatedAt).toBe(300);
  });

  it('无激活行 no-op 返回 undefined（预算刹车过滤无 goal 会话的半边依赖此语义）', () => {
    expect(db.addUsage('ghost', 100, 100)).toBeUndefined();
  });
});

describe('转移方法：状态机落库半边', () => {
  it('demoteToNeedsResume：active 降级；非 active 行不动（WHERE 护栏）；按会话扫不误伤他行', () => {
    const a = db.setActive('s1', '目标', 1000, false, 100);
    db.demoteToNeedsResume('s1', 200);
    expect(db.getByGoalId(a.goalId)!.status).toBe('needs-resume');
    // needs-resume 再降：no-op（不产生非法双降级形态）
    db.demoteToNeedsResume('s1', 300);
    expect(db.getByGoalId(a.goalId)!.status).toBe('needs-resume');
    // completed 行降级：WHERE 守卫拦下
    const b = db.setActive('s2', '另一目标', 1000, false, 100);
    db.settleDeclared(b.goalId, 'completed', '证据', 200);
    db.demoteToNeedsResume('s2', 300);
    expect(db.getByGoalId(b.goalId)!.status).toBe('completed');
  });

  it('reactivate(goalId, sessionId)：needs-resume ⇒ active + 领养重绑（行换会话）', () => {
    const a = db.setActive('s1', '目标', 1000, false, 100);
    db.demoteToNeedsResume('s1', 200);
    // 跨会话领养：s2 发起 /goal resume <goalId>——行 sessionId 换 s2
    db.reactivate(a.goalId, 's2', 300);
    const goal = db.getByGoalId(a.goalId)!;
    expect(goal.status).toBe('active');
    expect(goal.sessionId).toBe('s2');
    expect(goal.updatedAt).toBe(300);
    // 原会话不再持有该行（读 API 两分全空）
    expect(db.getActiveBySession('s1')).toBeUndefined();
    expect(db.getBySession('s1')).toBeUndefined();
  });

  it('settleDeclared(goalId)：completed/blocked 落 evidence 与终态时间戳；他行不受累', () => {
    const a = db.setActive('s1', '目标', 1000, false, 100);
    db.settleDeclared(a.goalId, 'completed', '逐需求证据齐备', 200);
    let goal = db.getByGoalId(a.goalId)!;
    expect(goal.status).toBe('completed');
    expect(goal.evidence).toBe('逐需求证据齐备');
    expect(goal.settledAt).toBe(200);
    // blocked 同面（新行后再试另一半）
    const b = db.setActive('s1', '目标二', 1000, false, 300);
    db.settleDeclared(b.goalId, 'blocked', '依赖服务连续三轮不可用', 400);
    goal = db.getByGoalId(b.goalId)!;
    expect(goal.status).toBe('blocked');
    expect(goal.evidence).toBe('依赖服务连续三轮不可用');
    // 旧行原样（goalId 定点结算不误伤）
    expect(db.getByGoalId(a.goalId)!.status).toBe('completed');
  });

  it('stopByUser(goalId)：⇒ stopped/user', () => {
    const a = db.setActive('s1', '目标', 1000, false, 100);
    db.stopByUser(a.goalId, 200);
    const goal = db.getByGoalId(a.goalId)!;
    expect(goal.status).toBe('stopped');
    expect(goal.stopReason).toBe('user');
    expect(goal.settledAt).toBe(200);
  });

  it('stopByBudget：⇒ stopped/budget + 记账定格；已停行幂等 no-op（WHERE 守卫）', () => {
    db.setActive('s1', '目标', 1000, false, 100);
    db.addUsage('s1', 1200, 150);
    db.stopByBudget('s1', 1200, 200);
    const stopped = db.getBySession('s1')!;
    expect(stopped.status).toBe('stopped');
    expect(stopped.stopReason).toBe('budget');
    expect(stopped.tokensUsed).toBe(1200); // 刹停时记账定格
    // 二次刹停（竞态双触发形态）：已非 active → no-op，行纹丝不动
    db.stopByBudget('s1', 9999, 300);
    const again = db.getBySession('s1')!;
    expect(again.tokensUsed).toBe(1200);
    expect(again.updatedAt).toBe(200); // 连时间戳都没动
  });
});

describe('needsWrite（第二十四批题3a——续跑轮工具面开洞申请位）', () => {
  it('缺省 false；申报 true 落库读回；重设复位换新值', () => {
    db.setActive('s1', '只读目标', 1000, false, 100);
    expect(db.getBySession('s1')!.needsWrite).toBe(false);
    db.settleDeclared(db.getBySession('s1')!.goalId, 'completed', '证据', 200);
    db.setActive('s1', '写面目标', 2000, true, 300);
    const goal = db.getBySession('s1')!;
    expect(goal.needsWrite).toBe(true);
    expect(goal.objective).toBe('写面目标');
    expect(goal.status).toBe('active');
  });
});

describe('刀四预留写面（列形状先行——updateWakeSchedule / recordSummary）', () => {
  it('updateWakeSchedule：写入与摘除（NULL）', () => {
    const a = db.setActive('s1', '目标', 1000, false, 100);
    db.updateWakeSchedule(a.goalId, 'every@30m', 200);
    expect(db.getByGoalId(a.goalId)!.wakeSchedule).toBe('every@30m');
    db.updateWakeSchedule(a.goalId, null, 300);
    expect(db.getByGoalId(a.goalId)!.wakeSchedule).toBeNull();
  });

  it('recordSummary：summary 全量替换 + 水位随行', () => {
    const a = db.setActive('s1', '目标', 1000, false, 100);
    db.recordSummary(a.goalId, '第一版摘要', 10, 200);
    let goal = db.getByGoalId(a.goalId)!;
    expect(goal.summary).toBe('第一版摘要');
    expect(goal.summarySeq).toBe(10);
    db.recordSummary(a.goalId, '第二版摘要（覆盖）', 25, 300);
    goal = db.getByGoalId(a.goalId)!;
    expect(goal.summary).toBe('第二版摘要（覆盖）');
    expect(goal.summarySeq).toBe(25);
  });
});

describe('跨版本升级路径（v13 整表重构）', () => {
  it('v5 旧库升 v8 升 v13：既有行承接 + goalId 回填非空 + 新列 NULL 诚实降级', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-v13-'));
    const path = join(dir, 'g.db');
    // 只带 v5 建旧库 + 原生 SQL 落一行（旧形态 session_id 主键）。注意：开库
    // 自带内核链（v6/v10），先经活连接退回 v5 旧形态（撤内核列 + 回拨 uv）——
    // 否则 uv 已越过 v13，全链重开不补跑 v8/v13（指纹断言拒绝）
    const old = openStore({ path, migrations: [GOAL_MIGRATION] });
    old.connection
      .prepare(
        `INSERT INTO goals (session_id, objective, token_budget, tokens_used, status, created_at, updated_at)
         VALUES ('s1', '旧目标', 1000, 0, 'active', 1, 1)`,
      )
      .run();
    old.connection.exec('ALTER TABLE sessions DROP COLUMN importer');
    old.connection.exec('ALTER TABLE sessions DROP COLUMN app');
    old.connection.pragma('user_version = 5');
    old.close();
    // 重开带全迁移链 → 内核缺口（v6/v10）与业务缺口（v8/v13）同补
    const upgraded = openStore({ path, migrations: goalMigrations });
    const goal = new GoalStore(upgraded.connection).getBySession('s1')!;
    expect(goal.objective).toBe('旧目标');
    expect(goal.sessionId).toBe('s1');
    expect(goal.goalId).toMatch(/^[0-9a-f]{32}$/); // 存量行回填 = randomblob 十六进制
    expect(goal.status).toBe('active');
    expect(goal.needsWrite).toBe(false);
    // 四新列不搬即 NULL：activatedSeq 不可考 = fold 诚实降级 run-scoped（拍板形态）
    expect(goal.activatedSeq).toBeNull();
    expect(goal.wakeSchedule).toBeNull();
    expect(goal.summary).toBeNull();
    // partial unique index 在升级库上照常执法
    const upgraded2 = new GoalStore(upgraded.connection);
    expect(() => upgraded2.setActive('s1', '撞位目标', 1000, false, 2)).toThrowError(/UNIQUE/);
    upgraded.close();
  });

  it('v8 中间站升 v13：needs_write 既有值承接不丢', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-v8-'));
    const path = join(dir, 'g.db');
    // 建在 v8 站（v5+v8 链）——内核列退回（v6 app ≤8 保留；v10 importer 撤除）
    // 后回拨 uv=8：重开时 v10 补回 importer、goal v13 整表重构，v6 不重跑
    const mid = openStore({ path, migrations: [GOAL_MIGRATION, GOAL_NEEDS_WRITE_MIGRATION] });
    mid.connection
      .prepare(
        `INSERT INTO goals (session_id, objective, token_budget, tokens_used, status, needs_write, created_at, updated_at)
         VALUES ('s1', '写面目标', 1000, 0, 'active', 1, 1, 1)`,
      )
      .run();
    mid.connection.exec('ALTER TABLE sessions DROP COLUMN importer');
    mid.connection.pragma('user_version = 8');
    mid.close();
    const upgraded = openStore({ path, migrations: goalMigrations });
    const goal = new GoalStore(upgraded.connection).getBySession('s1')!;
    expect(goal.needsWrite).toBe(true); // v8 列值穿越 v13 重构不丢
    upgraded.close();
  });
});

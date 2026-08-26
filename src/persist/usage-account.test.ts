/**
 * L1 persist — llm/usage 计量聚合查询测试（canAfford 读侧，会话篇 §1.1 / §3.3）。
 *
 * 覆盖 durable 底账三题中属查询侧的两题：重启不清零（时间窗过滤——日界换算后
 * 昨天花销自然出窗）+ 双开各记半边（跨会话聚合——events 单库全局过滤）。
 * hermetic：临时目录建库，用后即清。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEvent } from '../contracts/events.js';
import { openStore, localDayStartMs, spentBackgroundTokensSince, openTurnDepth } from './index.js';
import type { Store } from './store.js';

/** 临时库目录（全文件共享，结束后整体清除） */
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'persist-usage-test-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 构造 llm/usage 裸事件（物理层单测直接喂 appendCore，不经 Session 逻辑层） */
function usageEvent(seq: number, time: number, data: object): SessionEvent {
  return Object.freeze({ type: 'llm/usage', seq, time, data: Object.freeze(data) });
}

/** llm/usage 事件载荷工厂（与 session/event-types.ts LlmUsageData 同形） */
function usageData(input: number, output: number, priority: 'background' | 'foreground'): object {
  return { callId: `call-${input}-${output}-${priority}`, model: 'faux/m1', priority, usage: { input, output } };
}

/** 标准登记素材 */
const reg = (id: string) => ({
  sessionId: id,
  origin: 'user' as const,
  seedLength: 0,
  delegationDepth: 0,
});

describe('spentBackgroundTokensSince 聚合投影', () => {
  it('只计 background、只计时间窗内、跨会话合计（双开各记半边经 WAL 同库可见）', () => {
    const store = openStore({ path: join(dir, 'aggregate.db') }) as Store;
    // 会话 A：窗内 background 100+50；窗内 foreground 999（不计）；窗外（昨日）background 7（不计）
    store.appendCore(
      reg('sess-a'),
      [
        usageEvent(0, 1_000, usageData(100, 50, 'background')),
        usageEvent(1, 1_100, usageData(900, 99, 'foreground')),
        usageEvent(2, 900, usageData(7, 0, 'background')), // time < 窗口起点
      ],
      'inc-a',
    );
    // 会话 B（另一进程/另一次会话的半边账）：窗内 background 30
    store.appendCore(reg('sess-b'), [usageEvent(0, 1_200, usageData(30, 0, 'background'))], 'inc-b');

    expect(spentBackgroundTokensSince(store, 1_000)).toBe(180); // (100+50) + 30
    // 窗口前移到 1_150：会话 A 全部出窗，只剩 B 的 30
    expect(spentBackgroundTokensSince(store, 1_150)).toBe(30);
    // 窗口起点晚于一切事件：零
    expect(spentBackgroundTokensSince(store, 9_999)).toBe(0);
  });

  it('空库/无 llm/usage 事件的库 → 0（缺省态不是错）', () => {
    const store = openStore({ path: join(dir, 'empty.db') }) as Store;
    store.appendCore(reg('s'), [{ type: 'user/message', seq: 0, time: 1, data: { content: 'hi' } }], 'inc');
    expect(spentBackgroundTokensSince(store, 0)).toBe(0);
  });
});

describe('localDayStartMs 日界', () => {
  it('给定时刻 → 本地时区当日零点（跨天后窗口起点自然前移——昨日花销出窗即「重置」）', () => {
    const day = localDayStartMs(new Date(2026, 7, 24, 23, 50)); // 2026-08-24 23:50 本地
    expect(day).toBe(new Date(2026, 7, 24, 0, 0, 0, 0).getTime());
    const next = localDayStartMs(new Date(2026, 7, 25, 0, 10)); // 跨天十分钟后
    expect(next).toBe(day + 24 * 60 * 60 * 1000); // 日界前移一天
  });
});

/** 构造 turn 边界裸事件（busy 判据数据面——直接喂 appendCore，不经 Session 逻辑层） */
function turnEvent(seq: number, time: number, kind: 'turn/start' | 'turn/end'): SessionEvent {
  return Object.freeze({ type: kind, seq, time, data: Object.freeze({}) });
}

describe('openTurnDepth 配对深度投影（调度闸门 busy 判据）', () => {
  it('start 计 +1、end 计 -1、全库跨会话合计——敞开 > 0、闭合归零', () => {
    const store = openStore({ path: join(dir, 'turn-depth.db') }) as Store;
    // 会话 A：一轮完整闭合 + 一轮敞开在跑
    store.appendCore(
      reg('sess-a'),
      [
        turnEvent(0, 1_000, 'turn/start'),
        turnEvent(1, 1_100, 'turn/end'),
        turnEvent(2, 1_200, 'turn/start'), // 第二轮未闭合
      ],
      'inc-a',
    );
    // 会话 B（另一进程双开的敞开轮——跨进程可见恰是本判据的存在理由）
    store.appendCore(reg('sess-b'), [turnEvent(0, 1_300, 'turn/start')], 'inc-b');
    expect(openTurnDepth(store)).toBe(2);

    // 两轮各补 end：全部闭合 → 归零
    store.appendCore(reg('sess-a'), [turnEvent(3, 1_400, 'turn/end')], 'inc-a');
    store.appendCore(reg('sess-b'), [turnEvent(1, 1_500, 'turn/end')], 'inc-b');
    expect(openTurnDepth(store)).toBe(0);
  });

  it('空库 / 无 turn 事件的库 → 0；孤儿 start 永久计敞开（崩溃边界——拍板已知）', () => {
    const empty = openStore({ path: join(dir, 'turn-empty.db') }) as Store;
    expect(openTurnDepth(empty)).toBe(0);

    // 崩溃孤儿：turn/start 落盘后进程消亡，无 turn/end 兜底——投影永久读忙
    //（已知边界非 bug：重开的会话由恢复合成 turn/end 闭合，无人再打开的会话让路）
    const orphan = openStore({ path: join(dir, 'turn-orphan.db') }) as Store;
    orphan.appendCore(reg('s'), [turnEvent(0, 1, 'turn/start')], 'inc');
    expect(openTurnDepth(orphan)).toBe(1);
  });
});

describe('origin=import 会话级排除（会话篇 §5.1——预算底账排除、查询面不排除）', () => {
  it('导入会话的 llm/usage 花销不计入预算底账；同账活体会话照计', () => {
    const store = openStore({ path: join(dir, 'import-exclude.db') }) as Store;
    // 活体会话（origin='user'）：窗内 background 40
    store.appendCore(reg('sess-live'), [usageEvent(0, 1_000, usageData(40, 0, 'background'))], 'inc-1');
    // 导入会话（origin='import'，importer 归因在场）：窗内 background 500——历史花销非本机真实消耗
    store.appendCore(
      { sessionId: 'sess-imported', origin: 'import', seedLength: 0, delegationDepth: 0, importer: 'fx-importer' },
      [usageEvent(0, 1_100, usageData(500, 0, 'background'))],
      'inc-2',
    );

    expect(spentBackgroundTokensSince(store, 1_000)).toBe(40); // 只计活体会话
    // 查询面不排除：同表直查（events_query 面）两笔都在——底账排除只影响预算闸门口径
    const rows = store.connection.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'llm/usage'`).get() as {
      n: number;
    };
    expect(rows.n).toBe(2);
    store.close();
  });
});

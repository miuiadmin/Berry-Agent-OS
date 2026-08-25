/**
 * /usage 面板投影测试（src/app/usage.ts）。
 *
 * 走真库（Persistence.open ':memory:'）+ 直插事件行——投影是只读 SQL 聚合，
 * 测的就是「底账行 → 面板文本」的完整映射：时间窗切分（今日零点/近 7 日）、
 * cache 字段缺失的 COALESCE 兜底、会话 top 排序与 origin 联表、模型分布、
 * goals 表缺失（goal 件可卸）与在场两态。
 */

import { describe, expect, it } from 'vitest';
import { Persistence } from '../persist/index.js';
import { GOAL_MIGRATION } from '../goal/index.js';
import { formatUsagePanel } from './usage.js';
import type { DatabaseConnection } from '../persist/index.js';

/** 固定时钟：2026-08-25 12:00 本地时区（今日零点窗口可精确推算） */
const NOW = new Date(2026, 7, 25, 12, 0, 0).getTime();
/** 今日零点（本地时区） */
const MIDNIGHT = new Date(2026, 7, 25).getTime();

/** 直插一条 llm/usage 事件（data 原样 JSON 字符串化——与 appendCore 物理形态同） */
function insertUsage(db: DatabaseConnection, sid: string, seq: number, time: number, data: object): void {
  db.prepare('INSERT INTO events (session_id, seq, type, time, data) VALUES (?, ?, ?, ?, ?)').run(
    sid,
    seq,
    'llm/usage',
    time,
    JSON.stringify(data),
  );
}

/** 直插会话行（血缘最小列集——schema_version/created_at/origin/incarnation NOT NULL） */
function insertSession(db: DatabaseConnection, id: string, origin: string): void {
  db.prepare('INSERT INTO sessions (id, schema_version, created_at, origin, incarnation) VALUES (?, 1, ?, ?, ?)').run(
    id,
    MIDNIGHT,
    origin,
    'inc-test',
  );
}

describe('formatUsagePanel', () => {
  it('空库：四段全降级行，不抛错', () => {
    const p = Persistence.open({ path: ':memory:' });
    try {
      const text = formatUsagePanel(p.store.connection, { now: NOW });
      expect(text).toContain('今日：0 t（0 次调用）');
      expect(text).toContain('近 7 日：0 t（0 次调用）');
      expect(text).toContain('会话 top：（尚无用量记录）');
      expect(text).not.toContain('模型分布'); // 无模型行整段省略
      expect(text).toContain('goals 表未建'); // 无迁移库缺 goals 表——降级说明行
    } finally {
      p.close();
    }
  });

  it('时间窗聚合：今日零点切分 + cache 字段缺失兜底 + top 排序 + 模型分布', () => {
    const p = Persistence.open({ path: ':memory:' });
    const db = p.store.connection;
    try {
      insertSession(db, 'main-session-id', 'user');
      insertSession(db, 'child-session-id', 'delegation');
      insertSession(db, 'old-session-id', 'user');

      // 主会话两条：turn 汇总（四字段全）+ complete 侧账（只 input/output——cache NULL 兜底）
      insertUsage(db, 'main-session-id', 1, MIDNIGHT + 1000, {
        callId: 'turn:main',
        model: 'anthropic-proxy/glm-5.3',
        usage: { input: 1000, output: 100, cacheRead: 50, cacheWrite: 0 },
      });
      insertUsage(db, 'main-session-id', 2, NOW - 1, {
        callId: 'review-1',
        model: 'anthropic-proxy/glm-5.3',
        usage: { input: 200, output: 50 },
      });
      // 委派子会话一条（后台结算折叠——priority 标记不影响聚合）
      insertUsage(db, 'child-session-id', 1, MIDNIGHT + 2000, {
        callId: 'child-1',
        model: 'anthropic-proxy/glm-5.3',
        usage: { input: 300, output: 40 },
      });
      // 8 天前旧事件：不进今日/近 7 日，但进 top 与模型分布（缺 model 字段 → 未记模型列）
      insertUsage(db, 'old-session-id', 1, NOW - 8 * 86_400_000, {
        callId: 'old-1',
        usage: { input: 999, output: 0 },
      });

      const text = formatUsagePanel(db, { now: NOW });
      // 今日 = 1150 + 250 + 340 = 1740（旧事件在窗口外）
      expect(text).toContain('今日：1,740 t（3 次调用）');
      expect(text).toContain('近 7 日：1,740 t（3 次调用）');
      // top 排序：main 1400 > old 999 > child 340；origin 联表（delegation 血缘可见）
      expect(text.indexOf('main-ses')).toBeLessThan(text.indexOf('old-ses'));
      expect(text.indexOf('old-ses')).toBeLessThan(text.indexOf('child-se'));
      expect(text).toContain('1. main-ses…  1,400 t（2 次，user）');
      expect(text).toContain('3. child-se…  340 t（1 次，delegation）');
      // 模型分布：具名模型聚合 + 缺 model 字段降级列
      expect(text).toContain('anthropic-proxy/glm-5.3  1,740 t（3 次）');
      expect(text).toContain('(未记模型)  999 t（1 次）');
    } finally {
      p.close();
    }
  });

  it('goal 联表：goals 表在场时列自报口径行（status/stop_reason/预算）', () => {
    const p = Persistence.open({ path: ':memory:', migrations: [GOAL_MIGRATION] });
    const db = p.store.connection;
    try {
      db.prepare(
        `INSERT INTO goals (session_id, objective, token_budget, tokens_used, status, stop_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('goal-session-id', '目标', 50_000, 53_433, 'stopped', 'budget', MIDNIGHT, MIDNIGHT + 1);

      const text = formatUsagePanel(db, { now: NOW });
      expect(text).toContain('goal（自报口径 = assistant/message usage 累计）');
      expect(text).toContain('goal-ses…  stopped/budget  53,433 / 50,000 t');
      expect(text).not.toContain('goals 表未建');
    } finally {
      p.close();
    }
  });
});

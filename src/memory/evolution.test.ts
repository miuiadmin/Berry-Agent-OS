import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backgroundBudgetAllows } from './evolution.js';
import { TokenBudgetController } from '../llm/token-budget.js';
import { initDb, closeDb, getDb } from './db.js';

/**
 * evolution 后台每日预算软闸门测试（设计文档/03-参考/mercury-v1.2.0-吸纳建议.md §D）。
 *
 * backgroundBudgetAllows 读全局 getDb() 的 token_usage 表当日聚合用量，与阈值 0.8 比较。
 * 用 TokenBudgetController.recordUsage（官方播种 API）写入用量，避免裸 SQL 列名漂移。
 * DEFAULT dailyLimit = 2_000_000，0.8 阈值 = 1_600_000 token。
 */

describe('backgroundBudgetAllows（后台每日预算软闸门）', () => {
  let dir: string;

  afterEach(() => {
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function fresh() {
    dir = mkdtempSync(join(tmpdir(), 'berry-evo-'));
    initDb(join(dir, 'test.db'));
  }

  /** 用官方 API 播种一笔当日用量（agentName 用合法值，规避 contracts 约束） */
  const seedUsage = (inputTokens: number, outputTokens: number) => {
    new TokenBudgetController(getDb(), null, {}).recordUsage({
      sessionId: 's1',
      agentName: 'evolution',
      inputTokens,
      outputTokens,
      model: 'test-model',
    });
  };

  it('当日无用量 → 放行', () => {
    fresh();
    expect(backgroundBudgetAllows()).toBe(true);
  });

  it('当日用量 < 80% 软上限 → 放行', () => {
    fresh();
    seedUsage(1_400_000, 100_000); // 1.5M < 1.6M 阈值
    expect(backgroundBudgetAllows()).toBe(true);
  });

  it('当日用量 ≥ 80% 软上限 → 拦截（跳过后台活，让位用户请求）', () => {
    fresh();
    seedUsage(1_500_000, 300_000); // 1.8M ≥ 1.6M 阈值
    expect(backgroundBudgetAllows()).toBe(false);
  });

  it('跨日不累计：只算当日 created_at 的用量', () => {
    fresh();
    // 直接插一笔昨天的大用量（created_at 早于今日 0 点）
    const yesterday = new Date();
    yesterday.setHours(0, 0, 0, 0);
    const yesterdayStart = yesterday.getTime() - 1; // 略早于今日 0 点
    getDb().prepare(
      `INSERT INTO token_usage (session_id, agent_name, input_tokens, output_tokens, model, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).run('s1', 'evolution', 1_900_000, 100_000, 'test-model', yesterdayStart);
    // 昨日的量不计入今日 → 仍放行
    expect(backgroundBudgetAllows()).toBe(true);
  });
});

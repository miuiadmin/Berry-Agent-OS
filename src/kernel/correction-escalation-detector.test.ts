/**
 * CorrectionEscalationDetector 边界条件单测（§3.7）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAppHome, getAppHome } from '../utils/paths.js';
import { initDb, getDb } from '../memory/index.js';
import { CorrectionEscalationDetector } from './correction-escalation-detector.js';

let originalHome: string;
let testDir: string;

beforeEach(() => {
  originalHome = getAppHome();
  testDir = mkdtempSync(join(tmpdir(), 'escalation-test-'));
  setAppHome(testDir);
  initDb();
  // brain_corrections 表
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS brain_corrections (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      task_id TEXT,
      agent_name TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high')),
      action TEXT NOT NULL CHECK(action IN ('continue', 'adjust', 'stop', 'restart')),
      instruction TEXT NOT NULL,
      block_tools_json TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);
});

afterEach(() => {
  setAppHome(originalHome);
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function insertCorrection(agent: string, severity: 'low' | 'medium' | 'high', taskId: string, ageMs: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO brain_corrections (id, session_id, task_id, agent_name, severity, action, instruction, created_at)
    VALUES (?, 's', ?, ?, ?, 'adjust', ?, ?)
  `).run(`corr-${Math.random()}`, taskId, agent, severity, `instr-${agent}-${severity}`, Date.now() - ageMs);
}

describe('CorrectionEscalationDetector.evaluate 边界条件（§3.7）', () => {
  let detector: CorrectionEscalationDetector;

  beforeEach(() => {
    detector = new CorrectionEscalationDetector();
  });

  it('无历史纠偏 → baseSeverity 不变', () => {
    const result = detector.evaluate('code', 'task-A', 'low');
    expect(result.suggestedSeverity).toBe('low');
    expect(result.upgradeReason).toBeNull();
    expect(result.stats).toEqual({ low: 0, medium: 0, high: 0, total: 0 });
  });

  it('同 agent + 同 task，窗口内 low ≥ 2 → 升级 medium', () => {
    insertCorrection('code', 'low', 'task-A', 60_000);
    insertCorrection('code', 'low', 'task-A', 30_000);
    const result = detector.evaluate('code', 'task-A', 'low');
    expect(result.suggestedSeverity).toBe('medium');
    expect(result.upgradeReason).toContain('low_count_2');
  });

  it('同 agent + 同 task，窗口内 medium ≥ 2 → 升级 high + 触发冷却', () => {
    insertCorrection('code', 'medium', 'task-A', 60_000);
    insertCorrection('code', 'medium', 'task-A', 30_000);
    const result = detector.evaluate('code', 'task-A', 'medium');
    expect(result.suggestedSeverity).toBe('high');
    expect(result.upgradeReason).toContain('medium_count_2');
  });

  it('不同 task 的纠偏不互相升级（taskId 隔离）', () => {
    insertCorrection('code', 'low', 'task-A', 60_000);
    insertCorrection('code', 'low', 'task-A', 30_000);
    // task-B 没有历史
    const result = detector.evaluate('code', 'task-B', 'low');
    expect(result.suggestedSeverity).toBe('low');
    expect(result.upgradeReason).toBeNull();
  });

  it('不同 agent 的纠偏不互相升级（agentName 隔离）', () => {
    insertCorrection('code', 'low', 'task-A', 60_000);
    insertCorrection('code', 'low', 'task-A', 30_000);
    // learning 没有历史
    const result = detector.evaluate('learning', 'task-A', 'low');
    expect(result.suggestedSeverity).toBe('low');
    expect(result.upgradeReason).toBeNull();
  });

  it('窗口外（>5min）的老纠偏不计入', () => {
    insertCorrection('code', 'low', 'task-A', 6 * 60_000);  // 6 分钟前
    insertCorrection('code', 'low', 'task-A', 7 * 60_000);  // 7 分钟前
    const result = detector.evaluate('code', 'task-A', 'low');
    // 窗口外的不计入 → 不升级
    expect(result.suggestedSeverity).toBe('low');
  });

  it('已有 high → 强制 high（无论 baseSeverity）', () => {
    insertCorrection('code', 'high', 'task-A', 30_000);
    const result = detector.evaluate('code', 'task-A', 'low');
    expect(result.suggestedSeverity).toBe('high');
    expect(result.upgradeReason).toContain('has_prior_high');
  });

  it('升级后冷却期内持续高严重度（has_prior_high 路径）', () => {
    // 真实 high 历史（而不是 medium≥2 的诱导升级）
    insertCorrection('code', 'high', 'task-A', 60_000);
    insertCorrection('code', 'high', 'task-A', 30_000);
    // 第一次 evaluate baseSeverity='low' → has_prior_high → high
    const first = detector.evaluate('code', 'task-A', 'low');
    expect(first.suggestedSeverity).toBe('high');
    expect(first.upgradeReason).toContain('has_prior_high');

    // 第二次 evaluate（仍在冷却中）→ 仍 high，reason='high_cooldown'
    const second = detector.evaluate('code', 'task-A', 'low');
    expect(second.suggestedSeverity).toBe('high');
    expect(second.upgradeReason).toBe('high_cooldown');
  });

  it('taskId 未提供时不崩溃（兼容无 task 关联的纠偏）', () => {
    expect(() => detector.evaluate('code', undefined, 'low')).not.toThrow();
    const result = detector.evaluate('code', undefined, 'low');
    expect(result.suggestedSeverity).toBe('low');
  });

  it('resetCooldown 后立即可重新升级', () => {
    insertCorrection('code', 'medium', 'task-A', 60_000);
    insertCorrection('code', 'medium', 'task-A', 30_000);
    detector.evaluate('code', 'task-A', 'medium'); // 触发升级 + 冷却
    detector.resetCooldown('code', 'task-A');
    // 重置后 → 不在冷却中，可用 medium 再次升级
    const result = detector.evaluate('code', 'task-A', 'medium');
    expect(result.suggestedSeverity).toBe('high');
  });
});
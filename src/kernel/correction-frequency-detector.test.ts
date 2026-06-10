/**
 * CorrectionFrequencyDetector 单测（§13.20 / B.8）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAppHome, getAppHome } from '../utils/paths.js';
import { initDb, getDb } from '../memory/index.js';
import { initEventBus, getEventBus } from './event-bus.js';
import { CorrectionFrequencyDetector } from './correction-frequency-detector.js';

let originalHome: string;
let testDir: string;

beforeEach(() => {
  originalHome = getAppHome();
  testDir = mkdtempSync(join(tmpdir(), 'freq-test-'));
  setAppHome(testDir);
  initDb();
  initEventBus();
  // brain_corrections 表
  getDb().exec(`
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

function insertCorrection(agent: string, severity: 'low' | 'medium' | 'high', ageMs: number): void {
  getDb().prepare(`
    INSERT INTO brain_corrections (id, session_id, task_id, agent_name, severity, action, instruction, created_at)
    VALUES (?, 's', 't', ?, ?, 'adjust', 'instr', ?)
  `).run(`c-${Math.random()}`, agent, severity, Date.now() - ageMs);
}

/** 等待 microtask queue 处理（record 用 queueMicrotask 异步触发 check） */
async function tick(): Promise<void> {
  await new Promise<void>(r => queueMicrotask(() => r()));
}

describe('CorrectionFrequencyDetector.record 持久化（§13.20）', () => {
  it('记录一条纠偏 → brain_corrections 写入一行', () => {
    const detector = new CorrectionFrequencyDetector();
    detector.record({
      sessionId: 'sess-1',
      taskId: 'task-A',
      agentName: 'code',
      severity: 'high',
      action: 'stop',
      instruction: 'fix',
    });
    const rows = getDb().prepare('SELECT * FROM brain_corrections').all() as Array<{ agent_name: string; severity: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_name).toBe('code');
    expect(rows[0].severity).toBe('high');
  });

  it('blockTools JSON 序列化持久化', () => {
    const detector = new CorrectionFrequencyDetector();
    detector.record({
      sessionId: 's',
      taskId: 't',
      agentName: 'code',
      severity: 'medium',
      action: 'adjust',
      instruction: 'fix',
      blockTools: ['run_command', 'write_file'],
    });
    const row = getDb().prepare('SELECT block_tools_json FROM brain_corrections').get() as { block_tools_json: string };
    expect(row.block_tools_json).toBe(JSON.stringify(['run_command', 'write_file']));
  });

  it('无 blockTools 时 block_tools_json 为 null', () => {
    const detector = new CorrectionFrequencyDetector();
    detector.record({
      sessionId: 's', taskId: 't', agentName: 'code',
      severity: 'low', action: 'adjust', instruction: 'fix',
    });
    const row = getDb().prepare('SELECT block_tools_json FROM brain_corrections').get() as { block_tools_json: string | null };
    expect(row.block_tools_json).toBeNull();
  });
});

describe('CorrectionFrequencyDetector 频次阈值触发（§13.20）', () => {
  it('同 agent 30 分钟内 high ≥ 3 → emit capability.evolution.request', async () => {
    const events: Array<{ reason: string; agentName: string }> = [];
    getEventBus().on('capability.evolution.request' as any, (e: { reason: string; agentName: string }) => events.push(e));

    insertCorrection('code', 'high', 60_000);
    insertCorrection('code', 'high', 45_000);
    insertCorrection('code', 'high', 30_000);

    const detector = new CorrectionFrequencyDetector();
    detector.record({
      sessionId: 's', taskId: 't', agentName: 'code',
      severity: 'medium', action: 'adjust', instruction: 'fix',
    });
    await tick();

    expect(events.length).toBe(1);
    expect(events[0].agentName).toBe('code');
    expect(events[0].reason).toContain('high_severity_threshold');
  });

  it('同 agent 60 分钟内 total ≥ 8 → emit evolution（high 不足 3 但总数到）', async () => {
    const events: unknown[] = [];
    getEventBus().on('capability.evolution.request' as any, (e: unknown) => events.push(e));

    // 5 low + 2 medium + 1 high = 8（窗口内）
    for (let i = 0; i < 5; i++) insertCorrection('code', 'low', 60_000 - i * 1000);
    for (let i = 0; i < 2; i++) insertCorrection('code', 'medium', 60_000 - i * 1000);
    insertCorrection('code', 'high', 60_000);

    const detector = new CorrectionFrequencyDetector();
    detector.record({
      sessionId: 's', taskId: 't', agentName: 'code',
      severity: 'low', action: 'adjust', instruction: 'fix',
    });
    await tick();

    expect(events.length).toBe(1);
    const evt = events[0] as { reason: string };
    expect(evt.reason).toContain('total_corrections_threshold');
  });

  it('不同 agent 独立计数（互不影响）', async () => {
    const events: Array<{ agentName: string }> = [];
    getEventBus().on('capability.evolution.request' as any, (e: { agentName: string }) => events.push(e));

    insertCorrection('code', 'high', 60_000);
    insertCorrection('code', 'high', 45_000);
    insertCorrection('code', 'high', 30_000);
    // learning 只有 2 high → 不触发
    insertCorrection('learning', 'high', 60_000);
    insertCorrection('learning', 'high', 45_000);

    const detector = new CorrectionFrequencyDetector();
    // code 已有 3 high → 触发；learning 2 high → 不触发
    detector.record({ sessionId: 's', taskId: 't', agentName: 'code', severity: 'medium', action: 'adjust', instruction: 'fix' });
    await tick();
    detector.record({ sessionId: 's', taskId: 't', agentName: 'learning', severity: 'low', action: 'adjust', instruction: 'fix' });
    await tick();

    // 只 code 触发（learning 只有 2 high，未达 3）
    expect(events.length).toBe(1);
    expect(events[0].agentName).toBe('code');
  });

  it('窗口外（>30min）不计入 high 阈值', async () => {
    const events: unknown[] = [];
    getEventBus().on('capability.evolution.request' as any, (e: unknown) => events.push(e));

    insertCorrection('code', 'high', 35 * 60_000);  // 35 分钟前 — 出 high 窗口
    insertCorrection('code', 'high', 36 * 60_000);
    insertCorrection('code', 'high', 37 * 60_000);
    insertCorrection('code', 'high', 60_000);  // 1 分钟前 — 进 high 窗口（1 个）
    insertCorrection('code', 'high', 90_000);

    const detector = new CorrectionFrequencyDetector();
    detector.record({
      sessionId: 's', taskId: 't', agentName: 'code',
      severity: 'low', action: 'adjust', instruction: 'fix',
    });
    await tick();

    // high 窗口只有 2 个（1m + 1.5m 前）→ 未达 3
    // total 窗口有 6 个 → 未达 8
    expect(events.length).toBe(0);
  });

  it('触发后冷却 10 分钟不重复触发', async () => {
    const events: unknown[] = [];
    getEventBus().on('capability.evolution.request' as any, (e: unknown) => events.push(e));

    insertCorrection('code', 'high', 60_000);
    insertCorrection('code', 'high', 45_000);
    insertCorrection('code', 'high', 30_000);

    const detector = new CorrectionFrequencyDetector();
    // 第一次 record → 触发
    detector.record({ sessionId: 's', taskId: 't', agentName: 'code', severity: 'medium', action: 'adjust', instruction: 'fix' });
    await tick();
    expect(events.length).toBe(1);

    // 第二次 record（冷却期内）→ 不触发
    insertCorrection('code', 'high', 15_000);
    detector.record({ sessionId: 's', taskId: 't', agentName: 'code', severity: 'medium', action: 'adjust', instruction: 'fix' });
    await tick();
    expect(events.length).toBe(1);  // 仍是 1
  });

  it('resetCooldown 后可重新触发', async () => {
    const events: unknown[] = [];
    getEventBus().on('capability.evolution.request' as any, (e: unknown) => events.push(e));

    insertCorrection('code', 'high', 60_000);
    insertCorrection('code', 'high', 45_000);
    insertCorrection('code', 'high', 30_000);

    const detector = new CorrectionFrequencyDetector();
    detector.record({ sessionId: 's', taskId: 't', agentName: 'code', severity: 'medium', action: 'adjust', instruction: 'fix' });
    await tick();
    expect(events.length).toBe(1);

    detector.resetCooldown('code');
    insertCorrection('code', 'high', 15_000);
    detector.record({ sessionId: 's', taskId: 't', agentName: 'code', severity: 'medium', action: 'adjust', instruction: 'fix' });
    await tick();
    expect(events.length).toBe(2);  // 触发第二次
  });
});

describe('CorrectionFrequencyDetector 事件 payload（§13.20）', () => {
  it('evolution.request 事件含 agentName + windowStats + samples', async () => {
    let captured: { agentName: string; windowStats?: unknown; samples?: unknown } | null = null;
    getEventBus().on('capability.evolution.request' as any, (e: typeof captured) => { captured = e; });

    insertCorrection('code', 'high', 60_000);
    insertCorrection('code', 'high', 45_000);
    insertCorrection('code', 'high', 30_000);

    const detector = new CorrectionFrequencyDetector();
    detector.record({ sessionId: 's', taskId: 't', agentName: 'code', severity: 'medium', action: 'adjust', instruction: 'fix' });
    await tick();

    expect(captured).not.toBeNull();
    expect(captured!.agentName).toBe('code');
    expect((captured!.windowStats as { highCount?: number }).highCount).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(captured!.samples)).toBe(true);
  });
});
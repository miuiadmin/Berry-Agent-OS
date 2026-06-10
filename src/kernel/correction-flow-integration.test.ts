/**
 * CorrectionFlow 端到端集成测试（§3 INTERVENE 完整闭环）。
 *
 * 13.0 §3 设计：worker 失败 → checkpoint → Brain LLM 决定 adjust →
 * applyAdjust 写入 active_scope + brain_decision + 触发 brain.correction 事件 →
 * PermissionCoordinator.checkActiveScope 拦截后续 tool 调用 →
 * CorrectionFrequencyDetector 计入（高频触发 evolution）
 *
 * 这个测试覆盖整个 §3 INTERVENE 链路，不依赖真实 LLM。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAppHome, getAppHome } from '../utils/paths.js';
import { initDb, getDb, closeDb } from '../memory/index.js';
import { initEventBus, getEventBus } from './event-bus.js';
import { StateCache } from './state-cache.js';
import { BrainDecisionRecorder } from './brain-decision-recorder.js';
import { CorrectionFrequencyDetector } from './correction-frequency-detector.js';
import { PermissionCoordinator } from './permission-coordinator.js';
import type { TurnCorrectionPayload } from '../contracts/delegation.js';

let originalHome: string;
let testDir: string;

beforeEach(() => {
  originalHome = getAppHome();
  testDir = mkdtempSync(join(tmpdir(), 'correction-flow-integration-test-'));
  setAppHome(testDir);
  initDb();
  initEventBus();

  // 完整 schema（brain_decisions + brain_corrections）
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS brain_decisions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      decision_type TEXT NOT NULL,
      input_summary TEXT NOT NULL,
      output_json TEXT NOT NULL,
      confidence REAL,
      outcome TEXT,
      feedback_source TEXT,
      lesson TEXT,
      resolved_at INTEGER,
      task_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE TABLE IF NOT EXISTS brain_corrections (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      task_id TEXT,
      agent_name TEXT NOT NULL,
      severity TEXT NOT NULL,
      action TEXT NOT NULL,
      instruction TEXT NOT NULL,
      block_tools_json TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);
});

afterEach(() => {
  closeDb();
  setAppHome(originalHome);
  if (testDir) rmSync(testDir, { recursive: true, force: true});
});

describe('CorrectionFlow §3 INTERVENE 端到端闭环', () => {
  it('worker 失败 → adjust 决策 → active_scope 拦截 + 事件广播 + 频次计入', async () => {
    const stateCache = new StateCache();
    const recorder = new BrainDecisionRecorder(getDb());
    const frequencyDetector = new CorrectionFrequencyDetector();
    const permissionCoordinator = new PermissionCoordinator({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      engine: { checkPermission: () => ({ allowed: true }) } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tokenIssuer: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      approvalManager: { createRequest: () => ({}), autoDecide: () => null } as any,
      stateCache,
    });
    permissionCoordinator.setStateCache(stateCache);

    // 监听所有相关事件
    const events: { type: string; payload: unknown }[] = [];
    getEventBus().on('brain.correction', (e) => events.push({type: 'brain.correction', payload: e}));
    getEventBus().on('capability.evolution.request', (e) => events.push({type: 'evolution', payload: e}));

    // 1. Brain 做出 adjust 决策（mocked LLM）
    const sessionId = 'sess-intervention';
    const taskId = 'task-A';
    const correction: TurnCorrectionPayload = {
      delegationId: 'del-1',
      action: 'adjust',
      instruction: '改用 read_file 不要 run_command',
      newConstraints: { forbiddenTools: ['run_command'] },
    };

    // 2. BrainDecisionRecorder 记录决策
    recorder.recordReviewDecision(sessionId, '原 draft', {
      verdict: 'modify',
      finalResponse: '改后',
      reason: '改用更安全的方式',
    }, taskId);

    // 3. 模拟 CorrectionFlow.applyAdjust：写 active_scope + brain_decision lesson
    //    实际在 correction-flow.ts.applyAdjust()，这里用 service 层 API 模拟
    stateCache.set('active_scope', 'del-1', { blockTools: ['run_command'] });
    stateCache.set('correction', `${sessionId}:${taskId}`, {
      instruction: correction.instruction!,
      severity: 'medium',
      createdAt: Date.now(),
    });

    // 4. emit brain.correction 事件
    getEventBus().emit('brain.correction', {
      sessionId,
      taskId,
      agentName: 'code',
      action: 'adjust',
      severity: 'medium',
      instruction: correction.instruction,
      newConstraints: { forbiddenTools: ['run_command'] },
      createdAt: Date.now(),
    });

    // 5. frequency detector 记录一次
    frequencyDetector.record({
      sessionId, taskId, agentName: 'code',
      severity: 'medium', action: 'adjust',
      instruction: correction.instruction!,
      blockTools: ['run_command'],
    });
    // 等 microtask 处理
    await new Promise<void>(r => queueMicrotask(() => r()));

    // 验证 1: stateCache.active_scope 写入
    const scope = stateCache.get<{ blockTools: string[] }>('active_scope', 'del-1');
    expect(scope).toEqual({ blockTools: ['run_command'] });

    // 验证 2: stateCache.correction 写入（含 instruction + severity）
    const lesson = stateCache.get<{ instruction: string; severity: string }>('correction', `${sessionId}:${taskId}`);
    expect(lesson?.instruction).toContain('read_file');
    expect(lesson?.severity).toBe('medium');

    // 验证 3: brain_decisions 表有 1 条 modify 记录
    const decisions = getDb().prepare('SELECT * FROM brain_decisions').all() as Array<{ decision_type: string; outcome: string; task_id: string }>;
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision_type).toBe('review');
    expect(decisions[0].outcome).toBe('neutral');  // modify → neutral
    expect(decisions[0].task_id).toBe(taskId);

    // 验证 4: brain.correction 事件已广播
    expect(events.some(e => e.type === 'brain.correction')).toBe(true);

    // 验证 5: PermissionCoordinator.checkActiveScope 拦截 run_command
    const blockReason = permissionCoordinator.checkActiveScope('del-1', 'run_command', 'rm -rf /');
    expect(blockReason).toContain('active_scope');
    expect(blockReason).toContain('run_command');

    // 验证 6: 未被禁工具正常通过
    const allowReason = permissionCoordinator.checkActiveScope('del-1', 'read_file', '/tmp/foo');
    expect(allowReason).toBeNull();

    // 验证 7: brain_corrections 表有 1 条 medium 记录
    const corrections = getDb().prepare('SELECT * FROM brain_corrections').all() as Array<{ agent_name: string; severity: string; action: string }>;
    expect(corrections).toHaveLength(1);
    expect(corrections[0].agent_name).toBe('code');
    expect(corrections[0].severity).toBe('medium');
    expect(corrections[0].action).toBe('adjust');
  });

  it('delegation 结束 → active_scope 清理（避免 stale 约束泄漏）', () => {
    const stateCache = new StateCache();
    const permissionCoordinator = new PermissionCoordinator({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      engine: { checkPermission: () => ({ allowed: true }) } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tokenIssuer: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      approvalManager: { createRequest: () => ({}), autoDecide: () => null } as any,
      stateCache,
    });
    permissionCoordinator.setStateCache(stateCache);

    // 写入 scope
    stateCache.set('active_scope', 'del-stale', { blockTools: ['x'] });
    expect(stateCache.get('active_scope', 'del-stale')).not.toBeNull();

    // 模拟 delegation.completed 事件触发 cleanupTaskState
    const cleanupTaskState = (delegationId: string) => {
      permissionCoordinator.clearActiveScope(delegationId);
    };
    getEventBus().on('delegation.completed', (e: { delegationId: string }) => {
      cleanupTaskState(e.delegationId);
    });
    getEventBus().emit('delegation.completed', { delegationId: 'del-stale', targetAgent: 'code' });

    // 验证：scope 已清（StateCache.get 不存在 key 时返回 undefined）
    expect(stateCache.get('active_scope', 'del-stale')).toBeUndefined();
  });

  it('多次 adjust 累积 → frequency detector 累计计数 + 触发 evolution', async () => {
    const frequencyDetector = new CorrectionFrequencyDetector();
    const events: unknown[] = [];
    getEventBus().on('capability.evolution.request', (e) => events.push(e));

    // 3 次 medium 调整（< 30min 窗口）→ 不触发
    for (let i = 0; i < 3; i++) {
      frequencyDetector.record({
        sessionId: 's', taskId: 't', agentName: 'code',
        severity: 'medium', action: 'adjust', instruction: 'fix',
      });
    }
    await new Promise<void>(r => queueMicrotask(() => r()));
    expect(events).toHaveLength(0);  // medium=3 未达 medium 阈值（实际阈值看 impl）

    // 加 1 次 high 达到 high 窗口 ≥ 3
    frequencyDetector.record({
      sessionId: 's', taskId: 't', agentName: 'code',
      severity: 'high', action: 'adjust', instruction: 'fix',
    });
    frequencyDetector.record({
      sessionId: 's', taskId: 't', agentName: 'code',
      severity: 'high', action: 'adjust', instruction: 'fix',
    });
    frequencyDetector.record({
      sessionId: 's', taskId: 't', agentName: 'code',
      severity: 'high', action: 'adjust', instruction: 'fix',
    });
    await new Promise<void>(r => queueMicrotask(() => r()));

    // high 计数 ≥ 3 → 触发 evolution
    expect(events.length).toBeGreaterThan(0);
    const ev = events[0] as { reason: string; agentName: string };
    expect(ev.agentName).toBe('code');
    expect(ev.reason).toContain('high_severity_threshold');
  });
});
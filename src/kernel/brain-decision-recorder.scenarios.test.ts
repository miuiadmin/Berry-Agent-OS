/**
 * BrainDecisionRecorder 10 场景 A-J 集成测试（§3.5/§3.6/§8.6）。
 *
 * 覆盖：
 *   A. 简单 approve
 *   B. modify
 *   C. reject
 *   D. reRoute
 *   E. sensitive data 脱敏
 *   F. taskId 聚合
 *   G. lesson 更新（brain.review.feedback IPC 路径）
 *   H. outcome 推导（route/review/permission/correction 四种）
 *   I. recallForDecision 含 lesson 优先
 *   J. recallForTask 按 task 聚合
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { BrainDecisionRecorder } from './brain-decision-recorder.js';

let db: Database.Database;
let recorder: BrainDecisionRecorder;
let testDir: string;

beforeEach(() => {
  // 使用临时文件（避免污染用户 ~/.berry）
  testDir = mkdtempSync(join(tmpdir(), 'brain-decision-test-'));
  db = new Database(join(testDir, 'test.db'));
  db.pragma('journal_mode = WAL');

  // 完整 schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS brain_decisions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      decision_type TEXT NOT NULL
        CHECK(decision_type IN ('route','review','permission','correction','aggregated_insight','will_action')),
      input_summary TEXT NOT NULL,
      output_json TEXT NOT NULL,
      confidence REAL,
      outcome TEXT CHECK(outcome IN ('good','bad','neutral')),
      feedback_source TEXT,
      lesson TEXT,
      resolved_at INTEGER,
      task_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);
  recorder = new BrainDecisionRecorder(db);
});

afterEach(() => {
  db.close();
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true});
  }
});

describe('BrainDecisionRecorder 10 场景 A-J（§3.5/§3.6/§8.6）', () => {
  // ── A. 简单 approve ──
  it('A. recordReviewDecision approve → outcome=good + recall 包含该 decision', () => {
    recorder.recordReviewDecision('sess-1', '短回复', { verdict: 'approve' });
    const recalled = recorder.recallForDecision('review');
    expect(recalled).toHaveLength(1);
    expect(recalled[0].outcome).toBe('good');
  });

  // ── B. modify ──
  it('B. recordReviewDecision modify → outcome=neutral + finalResponse 持久化', () => {
    recorder.recordReviewDecision('sess-1', '原 draft', {
      verdict: 'modify',
      finalResponse: '改后版本',
      reason: '语法修正',
    });
    const decisions = db.prepare('SELECT * FROM brain_decisions').all() as Array<{ outcome: string; output_json: string }>;
    expect(decisions[0].outcome).toBe('neutral');
    const output = JSON.parse(decisions[0].output_json);
    expect(output.finalResponse).toBe('改后版本');
  });

  // ── C. reject ──
  it('C. recordReviewDecision reject → outcome=bad', () => {
    recorder.recordReviewDecision('sess-1', '危险 draft', {
      verdict: 'reject',
      reason: '含敏感信息',
    });
    const decisions = db.prepare('SELECT outcome FROM brain_decisions').all() as Array<{ outcome: string }>;
    expect(decisions[0].outcome).toBe('bad');
  });

  // ── D. reRoute ──
  it('D. recordReviewDecision with reRoute → reRoute 字段被持久化', () => {
    recorder.recordReviewDecision('sess-1', '需要 code agent', {
      verdict: 'reject',
      reRoute: { intent: 'code', targetAgent: 'code', reason: '用户问代码问题' },
    });
    const decisions = db.prepare('SELECT output_json FROM brain_decisions').all() as Array<{ output_json: string }>;
    const output = JSON.parse(decisions[0].output_json);
    expect(output.reRoute.intent).toBe('code');
  });

  // ── E. sensitive data 脱敏 ──
  it('E. recordReviewDecision 触发脱敏（邮箱/token 等被替换为 [REDACTED:type]）', () => {
    recorder.recordReviewDecision('sess-1', '原 draft', {
      verdict: 'modify',
      finalResponse: '联系 user@example.com 取 AKIAIOSFODNN7EXAMPLE',
      reason: 'password=hunter2 也需注意',
    });
    const decisions = db.prepare('SELECT output_json FROM brain_decisions').all() as Array<{ output_json: string }>;
    const output = JSON.parse(decisions[0].output_json);
    expect(output.finalResponse).toContain('[REDACTED:email]');
    expect(output.finalResponse).toContain('[REDACTED:aws_access_key]');
    expect(output.finalResponse).not.toContain('user@example.com');
    expect(output.finalResponse).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(output.reason).toContain('[REDACTED:password]');
    expect(output.reason).not.toContain('hunter2');
  });

  // ── F. taskId 聚合 ──
  it('F. 多个 decision 同 taskId → recallForTask 返回全部', () => {
    recorder.recordRouteDecision('sess-1', 'q1', { intent: 'code' }, 'task-A');
    recorder.recordReviewDecision('sess-1', 'd1', { verdict: 'approve' }, 'task-A');
    recorder.recordReviewDecision('sess-1', 'd2', { verdict: 'modify' }, 'task-A');
    recorder.recordRouteDecision('sess-1', 'q2', { intent: 'chat' }, 'task-B');  // 不同 task

    const taskA = recorder.recallForTask('task-A');
    expect(taskA).toHaveLength(3);
    const summaries = taskA.map(d => d.inputSummary).sort();
    expect(summaries).toEqual(['d1', 'd2', 'q1']);
  });

  // ── G. lesson 更新（brain.review.feedback 路径）──
  it('G. updateLesson 修改 lesson 字段（feedback 路径）', () => {
    const id = recorder.record({
      sessionId: 'sess-1',
      decisionType: 'review',
      inputSummary: 'd',
      outputJson: { verdict: 'modify' },
    });
    expect(id).not.toBeNull();
    expect(typeof id).toBe('string');

    recorder.updateLesson(id!, '用户偏好简洁回复');
    const decision = db.prepare('SELECT lesson, resolved_at FROM brain_decisions WHERE id = ?').get(id!) as { lesson: string; resolved_at: number | null } | undefined;
    expect(decision).toBeDefined();
    expect(decision!.lesson).toBe('用户偏好简洁回复');
    expect(decision!.resolved_at).not.toBeNull();
  });

  // ── H. outcome 推导 ──
  it('H. deriveOutcome 对四种 decisionType 正确推导', () => {
    // route: confidence >= 0.8 → good; < 0.8 → neutral
    recorder.recordRouteDecision('s', 'q-high', { intent: 'code', confidence: 0.9 });
    recorder.recordRouteDecision('s', 'q-low', { intent: 'code', confidence: 0.5 });

    // review: approve→good; reject→bad; modify→neutral
    recorder.recordReviewDecision('s', 'rev-approve', { verdict: 'approve' });
    recorder.recordReviewDecision('s', 'rev-reject', { verdict: 'reject' });
    recorder.recordReviewDecision('s', 'rev-modify', { verdict: 'modify' });

    // permission: allowed→good; allowed undefined→neutral（用不同 toolName 避免 byType.set 覆盖）
    recorder.recordPermissionDecision('s', 'safe_tool', { allowed: true });
    recorder.recordPermissionDecision('s', 'unknown_tool', {});

    // correction: continue→good; stop/restart→bad
    recorder.record({ sessionId: 's', decisionType: 'correction', inputSummary: 'corr-continue', outputJson: { action: 'continue' } });
    recorder.record({ sessionId: 's', decisionType: 'correction', inputSummary: 'corr-stop', outputJson: { action: 'stop' } });
    recorder.record({ sessionId: 's', decisionType: 'correction', inputSummary: 'corr-restart', outputJson: { action: 'restart' } });

    // 按 decisionType + outcome 列出（用 inputSummary 关联）
    const rows = db.prepare('SELECT decision_type, outcome, input_summary FROM brain_decisions ORDER BY id').all() as Array<{ decision_type: string; outcome: string; input_summary: string }>;
    const byType = new Map<string, string>();
    for (const r of rows) byType.set(`${r.decision_type}:${r.input_summary}`, r.outcome);

    expect(byType.get('route:q-high')).toBe('good');
    expect(byType.get('route:q-low')).toBe('neutral');
    expect(byType.get('review:rev-approve')).toBe('good');
    expect(byType.get('review:rev-reject')).toBe('bad');
    expect(byType.get('review:rev-modify')).toBe('neutral');
    // permission: inputSummary 是 'tool: ${toolName}'
    expect(byType.get('permission:tool: safe_tool')).toBe('good');
    expect(byType.get('permission:tool: unknown_tool')).toBe('neutral');
    expect(byType.get('correction:corr-continue')).toBe('good');
    expect(byType.get('correction:corr-stop')).toBe('bad');
    expect(byType.get('correction:corr-restart')).toBe('bad');
  });

  // ── I. recallForDecision 含 lesson 优先 ──
  it('I. recallForDecision 优先返回带 lesson 的行（无时间衰减）', () => {
    // 10 条无 lesson 的旧记录
    for (let i = 0; i < 10; i++) {
      recorder.recordRouteDecision('s', `q${i}`, { intent: 'code' });
    }
    // 1 条带 lesson 的最新记录 — 用 record() 直接获取 id
    const idWithLesson = recorder.record({
      sessionId: 's',
      decisionType: 'route',
      inputSummary: 'important',
      outputJson: { intent: 'code' },
    });
    expect(idWithLesson).not.toBeNull();
    recorder.updateLesson(idWithLesson!, '关键教训');

    const recalled = recorder.recallForDecision('route', 3);
    expect(recalled).toHaveLength(3);
    // 第一个应该是带 lesson 的
    expect(recalled[0].lesson).toBe('关键教训');
  });

  // ── J. recallForTask 按 task 聚合 ──
  it('J. recallForTask 支持 decisionType 过滤', () => {
    recorder.recordRouteDecision('s', 'q', { intent: 'code' }, 'task-X');
    recorder.recordReviewDecision('s', 'd', { verdict: 'approve' }, 'task-X');
    recorder.recordPermissionDecision('s', 'tool', { allowed: true }, 'task-X');

    const all = recorder.recallForTask('task-X');
    expect(all).toHaveLength(3);

    const onlyReviews = recorder.recallForTask('task-X', 'review');
    expect(onlyReviews).toHaveLength(1);
    expect(onlyReviews[0].inputSummary).toBe('d');
  });
});
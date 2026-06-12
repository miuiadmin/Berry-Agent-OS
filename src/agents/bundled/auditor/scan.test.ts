import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runAudit } from './scan.js';

/**
 * 15.0 机制 C：Auditor scan.ts 确定性 5 维扫描测试。
 *
 * 用 :memory: 库 + 三张源表最小结构，造数据触发各维度，验证 runAudit 产出正确的
 * AuditReport findings / riskScore / recommendations。这是 Auditor 的核心逻辑（确定性），
 * agent 包装层（entry.ts）只是编排。
 */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_tool_calls (
      id TEXT PRIMARY KEY, session_id TEXT, task_id TEXT, agent_name TEXT,
      tool_name TEXT, input_summary TEXT, success INTEGER, duration_ms INTEGER,
      approved_by TEXT, error_message TEXT, created_at INTEGER
    );
    CREATE TABLE brain_decisions (
      id TEXT PRIMARY KEY, session_id TEXT, decision_type TEXT, input_summary TEXT,
      output_json TEXT, confidence REAL, outcome TEXT, created_at INTEGER, task_id TEXT
    );
    CREATE TABLE drift_signals (
      id TEXT PRIMARY KEY, session_id TEXT, correlation_id TEXT, checkpoint_type TEXT,
      alignment_score REAL, needs_intervention INTEGER, drift_description TEXT,
      suggested_action TEXT, actual_action TEXT, intent_anchor_id TEXT, created_at INTEGER
    );
  `);
  return db;
}

function insToolCall(db: Database.Database, id: string, tool: string, opts: { success?: number; approvedBy?: string; at?: number } = {}) {
  db.prepare(
    `INSERT INTO agent_tool_calls (id, session_id, task_id, agent_name, tool_name, success, approved_by, created_at) VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, 's', 't', 'code', tool, opts.success ?? 1, opts.approvedBy ?? 'auto', opts.at ?? 1000);
}

describe('Auditor runAudit (15.0 机制 C)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('空库 → 空报告，riskScore=0，taskCount=0', () => {
    const r = runAudit(db, { since: 0, to: 100000 });
    expect(r.taskCount).toBe(0);
    expect(r.riskScore).toBe(0);
    expect(r.findings.patterns).toHaveLength(0);
    expect(r.findings.risks).toHaveLength(0);
  });

  it('repeated_tool：同工具调用 ≥10 次 → 检出重复模式', () => {
    for (let i = 0; i < 12; i++) insToolCall(db, `t${i}`, 'write_file');
    const r = runAudit(db, { since: 0, to: 100000 });
    expect(r.findings.patterns.length).toBeGreaterThanOrEqual(1);
    expect(r.findings.patterns[0].subject).toBe('write_file');
    expect(r.findings.patterns[0].count).toBe(12);
  });

  it('accumulated_low_risk：50+ auto 批准 → 检出累积风险', () => {
    for (let i = 0; i < 55; i++) insToolCall(db, `t${i}`, 'read_file', { approvedBy: 'auto' });
    const r = runAudit(db, { since: 0, to: 100000 });
    expect(r.findings.risks.length).toBeGreaterThanOrEqual(1);
    expect(r.findings.risks[0].count).toBe(55);
  });

  it('review_gap：失败工具调用未经 Brain 审核 → 检出覆盖缺口', () => {
    insToolCall(db, 'g1', 'run_command', { success: 0, approvedBy: 'auto' });
    const r = runAudit(db, { since: 0, to: 100000 });
    expect(r.findings.coverageGaps).toHaveLength(1);
    expect(r.findings.coverageGaps[0].kind).toBe('review_gap');
  });

  it('drift_recap：needs_intervention=1 的漂移 → 检出', () => {
    db.prepare(
      `INSERT INTO drift_signals (id, session_id, correlation_id, checkpoint_type, alignment_score, needs_intervention, drift_description, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('d1', 's', 'c', 'final_response', 0.3, 1, '偏离意图', 1000);
    const r = runAudit(db, { since: 0, to: 100000 });
    expect(r.findings.driftRecap).toHaveLength(1);
    expect(r.findings.driftRecap[0].kind).toBe('drift_approved');
  });

  it('decision_inconsistency：同 session+type 有 good 和 bad outcome → 检出', () => {
    const ins = db.prepare(
      `INSERT INTO brain_decisions (id, session_id, decision_type, input_summary, output_json, outcome, created_at) VALUES (?,?,?,?,?,?,?)`,
    );
    ins.run('b1', 's', 'route', 'in', '{}', 'good', 1000);
    ins.run('b2', 's', 'route', 'in', '{}', 'bad', 1000);
    const r = runAudit(db, { since: 0, to: 100000 });
    expect(r.findings.inconsistencies).toHaveLength(1);
    expect(r.findings.inconsistencies[0].kind).toBe('decision_inconsistency');
  });

  it('riskScore ∈ [0,1]，发现项越多越高', () => {
    const empty = runAudit(db, { since: 0, to: 100000 });
    expect(empty.riskScore).toBe(0);
    // 造一堆问题
    for (let i = 0; i < 15; i++) insToolCall(db, `t${i}`, 'write_file');
    insToolCall(db, 'g', 'run_command', { success: 0, approvedBy: 'auto' });
    const heavy = runAudit(db, { since: 0, to: 100000 });
    expect(heavy.riskScore).toBeGreaterThan(0);
    expect(heavy.riskScore).toBeLessThanOrEqual(1);
  });

  it('recommendations：高危累积风险 → escalationToUser；重复工具 → forbiddenTools', () => {
    for (let i = 0; i < 250; i++) insToolCall(db, `t${i}`, 'write_file', { approvedBy: 'auto' }); // ≥200 = high
    const r = runAudit(db, { since: 0, to: 100000 });
    expect(r.recommendations.escalationToUser).toBeTruthy();
    expect(r.recommendations.forbiddenTools).toContain('write_file');
  });

  it('时间窗过滤：窗口外的数据不计入', () => {
    insToolCall(db, 'old', 'write_file', { at: 100 });
    for (let i = 0; i < 12; i++) insToolCall(db, `new${i}`, 'write_file', { at: 5000 });
    const r = runAudit(db, { since: 4000, to: 6000 });
    expect(r.findings.patterns[0].count).toBe(12); // 不含 old
  });
});

/**
 * 15.0 机制 C：Auditor 确定性 5 维扫描器。
 *
 * 纯 SQL 扫描（无 LLM）—— 跨任务模式 / 累积风险 / 决策一致性 / 审核覆盖 / 漂移回顾。
 * CLAUDE.md「确定性逻辑优先做代码模块」：扫描是确定性代码，runAudit 可独立单测；
 * LLM 模式解释是可选增强，不影响扫描产出。
 *
 * 所有函数接收 db + 时间窗（since, epoch ms），返回结构化 findings。
 */
import type Database from 'better-sqlite3';
import type {
  AuditReport,
  AuditPattern,
  AuditRisk,
  AuditIssue,
  AuditRecommendations,
} from '../../../contracts/audit.js';

/** 重复工具调用阈值：同一工具在窗口内调用超过此次数记为 repeated_tool 模式 */
const REPEATED_TOOL_THRESHOLD = 10;
/** 累积低风险操作阈值：auto 批准的工具调用超过此次数记为累积风险 */
const ACCUMULATED_LOW_RISK_THRESHOLD = 50;

/** 1. 跨任务模式：重复工具调用 / 高频路径 */
function scanPatterns(db: Database.Database, since: number, to: number): AuditPattern[] {
  const patterns: AuditPattern[] = [];
  // 重复工具调用：GROUP BY tool_name HAVING count >= 阈值
  const repeated = db
    .prepare(
      `SELECT tool_name, COUNT(*) AS cnt
       FROM agent_tool_calls
       WHERE created_at >= ? AND created_at <= ?
       GROUP BY tool_name
       HAVING cnt >= ?
       ORDER BY cnt DESC`,
    )
    .all(since, to, REPEATED_TOOL_THRESHOLD) as Array<{ tool_name: string; cnt: number }>;
  for (const r of repeated) {
    patterns.push({
      kind: 'repeated_tool',
      description: `工具 ${r.tool_name} 在审计窗口内被调用 ${r.cnt} 次（≥${REPEATED_TOOL_THRESHOLD}）`,
      count: r.cnt,
      subject: r.tool_name,
    });
  }
  return patterns;
}

/** 2. 累积风险：大量 auto 批准（低风险）操作的累积效果 */
function scanRisks(db: Database.Database, since: number, to: number): AuditRisk[] {
  const risks: AuditRisk[] = [];
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM agent_tool_calls
       WHERE created_at >= ? AND created_at <= ? AND approved_by = 'auto'`,
    )
    .get(since, to) as { cnt: number };
  if (row.cnt >= ACCUMULATED_LOW_RISK_THRESHOLD) {
    const severity: AuditRisk['severity'] = row.cnt >= ACCUMULATED_LOW_RISK_THRESHOLD * 4 ? 'high' : row.cnt >= ACCUMULATED_LOW_RISK_THRESHOLD * 2 ? 'medium' : 'low';
    risks.push({
      kind: 'accumulated_low_risk',
      description: `${row.cnt} 次 auto 批准的低风险操作累积（阈值 ${ACCUMULATED_LOW_RISK_THRESHOLD}），单次无害但总量需关注`,
      severity,
      count: row.cnt,
    });
  }
  return risks;
}

/** 3. 决策一致性：同一 session+decision_type 同时出现 good 与 bad outcome（决策质量前后不一） */
function scanInconsistencies(db: Database.Database, since: number, to: number): AuditIssue[] {
  const issues: AuditIssue[] = [];
  try {
    // brain_decisions 的决策结果在 output_json（非结构化），但 outcome 列记录决策质量反馈
    // （good/bad/neutral）。同一 session+type 既有 good 又有 bad → Brain 决策前后不一致。
    const rows = db
      .prepare(
        `SELECT session_id, decision_type,
                SUM(CASE WHEN outcome='good' THEN 1 ELSE 0 END) AS good_cnt,
                SUM(CASE WHEN outcome='bad' THEN 1 ELSE 0 END) AS bad_cnt
         FROM brain_decisions
         WHERE created_at >= ? AND created_at <= ? AND outcome IS NOT NULL
         GROUP BY session_id, decision_type
         HAVING good_cnt > 0 AND bad_cnt > 0`,
      )
      .all(since, to) as Array<{ session_id: string; decision_type: string; good_cnt: number; bad_cnt: number }>;
    for (const r of rows) {
      issues.push({
        kind: 'decision_inconsistency',
        description: `session ${r.session_id} 的 ${r.decision_type} 决策质量不一致（good=${r.good_cnt}, bad=${r.bad_cnt}），Brain 前后判断可能矛盾`,
        refId: r.session_id,
      });
    }
  } catch {
    // brain_decisions 列差异（旧库无 outcome 列）—— 静默跳过该维度
  }
  return issues;
}

/** 4. 审核覆盖缺口：工具调用失败（success=0）但未经 brain 批准（approved_by != 'brain'） */
function scanCoverageGaps(db: Database.Database, since: number, to: number): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const rows = db
    .prepare(
      `SELECT id, tool_name, agent_name FROM agent_tool_calls
       WHERE created_at >= ? AND created_at <= ? AND success = 0 AND approved_by != 'brain'`,
    )
    .all(since, to) as Array<{ id: string; tool_name: string; agent_name: string }>;
  for (const r of rows) {
    issues.push({
      kind: 'review_gap',
      description: `${r.agent_name} 的工具 ${r.tool_name} 调用失败且未经 Brain 审核（可能漏审）`,
      refId: r.id,
    });
  }
  return issues;
}

/** 5. 漂移回顾：drift_signals 中 needs_intervention=1（需干预的漂移） */
function scanDriftRecap(db: Database.Database, since: number, to: number): AuditIssue[] {
  const issues: AuditIssue[] = [];
  try {
    const rows = db
      .prepare(
        `SELECT id, session_id, alignment_score, drift_description FROM drift_signals
         WHERE created_at >= ? AND created_at <= ? AND needs_intervention = 1`,
      )
      .all(since, to) as Array<{ id: string; session_id: string; alignment_score: number; drift_description: string | null }>;
    for (const r of rows) {
      issues.push({
        kind: 'drift_approved',
        description: `session ${r.session_id} 检测到需干预的漂移（alignment=${r.alignment_score.toFixed(2)}）：${r.drift_description ?? '无描述'}`,
        refId: r.id,
      });
    }
  } catch {
    // drift_signals 可能不存在（旧库/部分 schema）—— 静默跳过该维度
  }
  return issues;
}

/** 按发现项数 + 严重度计算风险评分（0-1） */
function computeRiskScore(
  patterns: AuditPattern[],
  risks: AuditRisk[],
  inconsistencies: AuditIssue[],
  coverageGaps: AuditIssue[],
  driftRecap: AuditIssue[],
): number {
  let score = 0;
  score += patterns.length * 0.05;
  for (const r of risks) score += r.severity === 'high' ? 0.3 : r.severity === 'medium' ? 0.15 : 0.05;
  score += inconsistencies.length * 0.2; // Brain 矛盾权重高
  score += coverageGaps.length * 0.05;
  score += driftRecap.length * 0.1;
  return Math.min(score, 1);
}

/** 据 findings 生成给 Brain 的行动建议 */
function buildRecommendations(
  risks: AuditRisk[],
  inconsistencies: AuditIssue[],
  patterns: AuditPattern[],
): AuditRecommendations {
  const recs: AuditRecommendations = {};
  const highRisks = risks.filter((r) => r.severity === 'high');
  if (highRisks.length > 0) {
    recs.escalationToUser = `检测到 ${highRisks.length} 项高危累积风险，建议向用户确认`;
  }
  if (inconsistencies.length > 0) {
    recs.evolutionTriggers = [`Brain 决策不一致 ${inconsistencies.length} 处，建议回顾决策规则`];
  }
  const repeatedTools = patterns.filter((p) => p.kind === 'repeated_tool').map((p) => p.subject);
  if (repeatedTools.length > 0) {
    recs.forbiddenTools = repeatedTools; // 建议划禁区（Brain 决定是否采纳）
  }
  return recs;
}

/**
 * 运行一次完整审计：5 维扫描 → AuditReport。
 *
 * @param db    数据库连接
 * @param opts.since  审计窗口起始（epoch ms），缺省=最近 24h
 * @param opts.to    审计窗口结束（epoch ms），缺省=当前
 */
export function runAudit(db: Database.Database, opts?: { since?: number; to?: number }): AuditReport {
  const to = opts?.to ?? Date.now();
  const since = opts?.since ?? to - 24 * 60 * 60 * 1000;

  const patterns = scanPatterns(db, since, to);
  const risks = scanRisks(db, since, to);
  const inconsistencies = scanInconsistencies(db, since, to);
  const coverageGaps = scanCoverageGaps(db, since, to);
  const driftRecap = scanDriftRecap(db, since, to);

  const taskCountRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM agent_tool_calls WHERE created_at >= ? AND created_at <= ?`)
    .get(since, to) as { cnt: number };

  return {
    timeRange: { from: since, to },
    taskCount: taskCountRow.cnt,
    findings: { patterns, risks, inconsistencies, coverageGaps, driftRecap },
    recommendations: buildRecommendations(risks, inconsistencies, patterns),
    riskScore: computeRiskScore(patterns, risks, inconsistencies, coverageGaps, driftRecap),
  };
}

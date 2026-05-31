import type Database from 'better-sqlite3';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('stats-job');

export interface StatsJobResult {
  decisionsAnalyzed: number;
  insightsProduced: number;
  patterns: string[];
}

export function runStatsJob(db: Database.Database): StatsJobResult {
  const patterns: string[] = [];
  let insightsProduced = 0;

  try {
    const cutoff = Date.now() - 24 * 3600_000;

    // Count decisions by type and outcome in the last 24h
    const stats = db.prepare(`
      SELECT decision_type, outcome, COUNT(*) as count
      FROM brain_decisions
      WHERE created_at > ? AND decision_type != 'aggregated_insight'
      GROUP BY decision_type, outcome
    `).all(cutoff) as Array<{ decision_type: string; outcome: string | null; count: number }>;

    if (stats.length === 0) {
      return { decisionsAnalyzed: 0, insightsProduced: 0, patterns: [] };
    }

    const totalDecisions = stats.reduce((sum, s) => sum + s.count, 0);
    const byType = new Map<string, { good: number; bad: number; neutral: number; total: number }>();

    for (const s of stats) {
      const entry = byType.get(s.decision_type) ?? { good: 0, bad: 0, neutral: 0, total: 0 };
      entry.total += s.count;
      if (s.outcome === 'good') entry.good += s.count;
      else if (s.outcome === 'bad') entry.bad += s.count;
      else entry.neutral += s.count;
      byType.set(s.decision_type, entry);
    }

    // Detect patterns and produce insights
    for (const [type, counts] of byType) {
      if (counts.total < 5) continue;

      const badRate = counts.bad / counts.total;
      const goodRate = counts.good / counts.total;

      if (badRate > 0.3) {
        const pattern = `${type} decisions have ${(badRate * 100).toFixed(0)}% bad outcome rate (${counts.bad}/${counts.total})`;
        patterns.push(pattern);
        writeInsight(db, type, pattern, `High failure rate in ${type} suggests prompt or context issue`);
        insightsProduced++;
      }

      if (goodRate > 0.9 && counts.total >= 10) {
        const pattern = `${type} decisions are ${(goodRate * 100).toFixed(0)}% successful (${counts.good}/${counts.total})`;
        patterns.push(pattern);
      }
    }

    // Check for lesson-less decisions that should have feedback
    const noOutcome = db.prepare(`
      SELECT COUNT(*) as count FROM brain_decisions
      WHERE created_at > ? AND outcome IS NULL AND decision_type != 'aggregated_insight'
    `).get(cutoff) as { count: number };

    if (noOutcome.count > 20) {
      const pattern = `${noOutcome.count} decisions without outcome feedback — Evolution Agent may not be running`;
      patterns.push(pattern);
      writeInsight(db, 'evolution', pattern, 'Consider triggering Evolution Agent extract_feedback more frequently');
      insightsProduced++;
    }

    if (insightsProduced > 0) {
      logger.info({ totalDecisions, insightsProduced, patterns }, 'Stats job completed');
    }

    return { decisionsAnalyzed: totalDecisions, insightsProduced, patterns };
  } catch (err) {
    logger.debug({ err }, 'Stats job failed');
    return { decisionsAnalyzed: 0, insightsProduced: 0, patterns: [] };
  }
}

function writeInsight(db: Database.Database, category: string, summary: string, detail: string): void {
  try {
    db.prepare(`
      INSERT INTO brain_decisions (id, session_id, decision_type, input_summary, output_json, outcome, created_at)
      VALUES (?, 'system', 'aggregated_insight', ?, ?, 'good', ?)
    `).run(genId('bdec'), `[${category}] ${summary}`, JSON.stringify({ insight: detail, source: 'stats_job' }), Date.now());
  } catch { /* best-effort */ }
}

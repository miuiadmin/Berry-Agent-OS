/**
 * 12.0 漂移度量聚合服务。
 *
 * 从 drift_signals 和 intent_anchors 表中聚合数据，
 * 计算平均对齐分数、干预率、恢复率等指标。
 */

import type Database from 'better-sqlite3';
import type { DriftMetrics } from '../contracts/intent.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('drift-metrics');

/** 单条漂移信号记录（API 返回用） */
export interface DriftSignalRow {
  id: string;
  sessionId: string;
  correlationId: string;
  checkpointType: string;
  alignmentScore: number;
  needsIntervention: boolean;
  driftDescription: string | null;
  suggestedAction: string | null;
  actualAction: string | null;
  createdAt: number;
}

export class DriftMetricsService {
  constructor(private readonly db: Database.Database) {}

  /** 聚合指定时间窗口内的漂移度量 */
  aggregate(days: number): DriftMetrics {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    try {
      // 总体统计
      const stats = this.db.prepare(`
        SELECT
          COUNT(*) as total,
          AVG(alignment_score) as avg_score,
          SUM(CASE WHEN needs_intervention = 1 THEN 1 ELSE 0 END) as intervention_count
        FROM drift_signals WHERE created_at >= ?
      `).get(since) as { total: number; avg_score: number | null; intervention_count: number };

      // 最终回复的平均对齐分数
      const finalStats = this.db.prepare(`
        SELECT AVG(alignment_score) as avg_score
        FROM drift_signals WHERE checkpoint_type = 'final_response' AND created_at >= ?
      `).get(since) as { avg_score: number | null };

      // 恢复率：干预后同 session 后续信号对齐分数 > 0.7 的比例
      // 简化实现：干预后同 correlationId 是否有后续 approve（actual_action = 'continue'）
      const recoveryStats = this.db.prepare(`
        SELECT
          COUNT(*) as total_interventions,
          SUM(CASE WHEN actual_action = 'approved_after_correction' THEN 1 ELSE 0 END) as recovered
        FROM drift_signals WHERE needs_intervention = 1 AND created_at >= ?
      `).get(since) as { total_interventions: number; recovered: number };

      const totalSignals = stats.total || 0;
      const interventionRate = totalSignals > 0 ? (stats.intervention_count / totalSignals) : 0;
      const recoveryRate = recoveryStats.total_interventions > 0
        ? (recoveryStats.recovered / recoveryStats.total_interventions)
        : 0;

      return {
        avgAlignmentScore: stats.avg_score ?? 1,
        interventionRate,
        recoveryRate,
        finalResponseAlignment: finalStats.avg_score ?? 1,
        hotspotPairs: [],
        totalSignals,
      };
    } catch (err) {
      logger.error({ err }, 'drift metrics aggregate failed');
      return {
        avgAlignmentScore: 1,
        interventionRate: 0,
        recoveryRate: 0,
        finalResponseAlignment: 1,
        hotspotPairs: [],
        totalSignals: 0,
      };
    }
  }

  /** 列出漂移信号记录（分页） */
  listSignals(opts: { sessionId?: string; limit?: number; offset?: number }): DriftSignalRow[] {
    const { sessionId, limit = 50, offset = 0 } = opts;
    try {
      const whereClause = sessionId ? 'WHERE session_id = ?' : '';
      const params = sessionId ? [sessionId, limit, offset] : [limit, offset];
      const rows = this.db.prepare(`
        SELECT id, session_id, correlation_id, checkpoint_type, alignment_score,
               needs_intervention, drift_description, suggested_action, actual_action, created_at
        FROM drift_signals ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(...params) as Array<Record<string, unknown>>;

      return rows.map(r => ({
        id: r.id as string,
        sessionId: r.session_id as string,
        correlationId: r.correlation_id as string,
        checkpointType: r.checkpoint_type as string,
        alignmentScore: r.alignment_score as number,
        needsIntervention: Boolean(r.needs_intervention),
        driftDescription: r.drift_description as string | null,
        suggestedAction: r.suggested_action as string | null,
        actualAction: r.actual_action as string | null,
        createdAt: r.created_at as number,
      }));
    } catch (err) {
      logger.error({ err }, 'drift metrics listSignals failed');
      return [];
    }
  }
}

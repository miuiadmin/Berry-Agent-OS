/**
 * 13.0 §3.7 升级式纠偏 — 同 agent/task 短时间反复纠偏 → 自动升级 severity。
 *
 * 升级规则：
 *   - 同 (agent, task) 最近 5 分钟内 low 纠偏 ≥ 2 次 → 下一次升级为 medium
 *   - 同 (agent, task) 最近 5 分钟内 medium 纠偏 ≥ 2 次 → 下一次升级为 high
 *   - high 纠偏触发后冷却 10 分钟，避免持续升级把工具都禁用
 *
 * 数据源：brain_corrections 表（已由 CorrectionFrequencyDetector 写入）。
 *
 * 调用方：
 *   - CorrectionFlow.applyAdjust/applyStop/applyRestart：传入 Brain LLM 推断的 severity，
 *     由本类返回的 `suggestedSeverity` 覆盖（取 max）。
 *   - BrainDecisionRecorder.recordReviewDecision：把 escalationReason 写到 lesson 字段。
 */

import { getDb } from '../memory/index.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('correction-escalation');

export type Severity = 'low' | 'medium' | 'high';

const SEVERITY_ORDER: Severity[] = ['low', 'medium', 'high'];

const WINDOW_MS = 5 * 60_000;          // 5 分钟窗口
const LOW_UPGRADE_THRESHOLD = 2;
const MEDIUM_UPGRADE_THRESHOLD = 2;
const HIGH_COOLDOWN_MS = 10 * 60_000;  // high 触发后冷却 10 分钟

export interface EscalationResult {
  /** 当前 Brain LLM 推断的 severity */
  baseSeverity: Severity;
  /** 经过升级规则调整后的 severity（≥ baseSeverity） */
  suggestedSeverity: Severity;
  /** 触发升级的具体原因（无升级时为 null） */
  upgradeReason: string | null;
  /** 同 (agent, task) 窗口内的历史纠偏次数（按 severity 分组） */
  stats: { low: number; medium: number; high: number; total: number };
}

export class CorrectionEscalationDetector {
  /** (agent|task) → 上次升级到 high 的时间戳（用于冷却） */
  private lastHighAt = new Map<string, number>();

  /**
   * 查询当前 (agent, task) 的纠偏历史并返回建议的 severity。
   *
   * @param agentName 被纠偏的 agent 类型
   * @param taskId 关联的 task（planTaskId / agentTaskId / sessionId）
   * @param baseSeverity 当前 Brain LLM 推断的 severity
   */
  evaluate(agentName: string, taskId: string | undefined, baseSeverity: Severity): EscalationResult {
    const stats = this.queryStats(agentName, taskId);
    const cacheKey = `${agentName}|${taskId ?? '_none_'}`;

    // 冷却：如果最近已升级到 high，10 分钟内不再升级
    const lastHigh = this.lastHighAt.get(cacheKey) ?? 0;
    if (now() - lastHigh < HIGH_COOLDOWN_MS && stats.high > 0) {
      return {
        baseSeverity,
        suggestedSeverity: maxSeverity(baseSeverity, 'high'),
        upgradeReason: 'high_cooldown',
        stats,
      };
    }

    // 规则 1: low ≥ 2 → 升级 medium
    if (baseSeverity === 'low' && stats.low >= LOW_UPGRADE_THRESHOLD) {
      return {
        baseSeverity,
        suggestedSeverity: 'medium',
        upgradeReason: `low_count_${stats.low}_in_${WINDOW_MS / 60_000}min`,
        stats,
      };
    }

    // 规则 2: medium ≥ 2 → 升级 high
    if (baseSeverity === 'medium' && stats.medium >= MEDIUM_UPGRADE_THRESHOLD) {
      this.lastHighAt.set(cacheKey, now());
      return {
        baseSeverity,
        suggestedSeverity: 'high',
        upgradeReason: `medium_count_${stats.medium}_in_${WINDOW_MS / 60_000}min`,
        stats,
      };
    }

    // 规则 3: 已经有 high 纠偏 → 强制 high
    if (stats.high > 0) {
      this.lastHighAt.set(cacheKey, now());
      return {
        baseSeverity,
        suggestedSeverity: maxSeverity(baseSeverity, 'high'),
        upgradeReason: `has_prior_high`,
        stats,
      };
    }

    return {
      baseSeverity,
      suggestedSeverity: baseSeverity,
      upgradeReason: null,
      stats,
    };
  }

  /**
   * 查询最近 5 分钟内 (agent, task) 的纠偏次数。
   */
  private queryStats(agentName: string, taskId: string | undefined): { low: number; medium: number; high: number; total: number } {
    if (!agentName) return { low: 0, medium: 0, high: 0, total: 0 };
    const db = getDb();
    try {
      // 注意：brain_corrections 表 task_id 是可选字段。taskId 未提供时按 agentName 聚合。
      const rows = db.prepare(`
        SELECT severity, COUNT(*) AS cnt
        FROM brain_corrections
        WHERE agent_name = ?
          AND created_at >= ?
          AND (? IS NULL OR task_id = ?)
        GROUP BY severity
      `).all(agentName, now() - WINDOW_MS, taskId ?? null, taskId ?? null) as Array<{ severity: Severity; cnt: number }>;

      const low = rows.find(r => r.severity === 'low')?.cnt ?? 0;
      const medium = rows.find(r => r.severity === 'medium')?.cnt ?? 0;
      const high = rows.find(r => r.severity === 'high')?.cnt ?? 0;
      return { low, medium, high, total: low + medium + high };
    } catch (err) {
      logger.warn({ err, agentName, taskId }, 'correction-escalation: queryStats failed');
      return { low: 0, medium: 0, high: 0, total: 0 };
    }
  }

  /**
   * 重置冷却（测试用）。
   */
  resetCooldown(agentName?: string, taskId?: string): void {
    if (agentName && taskId) {
      this.lastHighAt.delete(`${agentName}|${taskId}`);
    } else {
      this.lastHighAt.clear();
    }
  }
}

/** 取两个 severity 中较大的一个 */
function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;
}

/** 集中 now() 便于测试 mock */
function now(): number {
  return Date.now();
}

/** 全局单例 */
let globalDetector: CorrectionEscalationDetector | null = null;

export function getCorrectionEscalationDetector(): CorrectionEscalationDetector {
  if (!globalDetector) {
    globalDetector = new CorrectionEscalationDetector();
  }
  return globalDetector;
}

export function resetCorrectionEscalationDetector(): void {
  globalDetector = null;
}
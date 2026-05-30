import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('insights-lifecycle');

const VALIDATE_THRESHOLD_ADOPTIONS = 3;
const EXPIRE_DAYS_WITHOUT_ADOPTION = 14;
const EXPIRE_DAYS_TENTATIVE_STALE = 7;

export interface InsightLifecycleResult {
  validated: number;
  expired: number;
  total: number;
}

export function runInsightsLifecycle(db: Database.Database): InsightLifecycleResult {
  const now = Date.now();
  let validated = 0;
  let expired = 0;

  try {
    // 1. Validate tentative insights that have been adopted enough times
    const toValidate = db.prepare(`
      UPDATE system_insights
      SET status = 'validated', updated_at = ?
      WHERE status = 'tentative'
        AND adopted_count >= ?
        AND confidence >= 0.5
    `).run(now, VALIDATE_THRESHOLD_ADOPTIONS);
    validated = toValidate.changes;

    // 2. Expire tentative insights that are stale (no adoption in N days)
    const tentativeExpireCutoff = now - EXPIRE_DAYS_TENTATIVE_STALE * 86400_000;
    const staleTentative = db.prepare(`
      UPDATE system_insights
      SET status = 'expired', expired_at = ?, updated_at = ?
      WHERE status = 'tentative'
        AND adopted_count = 0
        AND created_at < ?
    `).run(now, now, tentativeExpireCutoff);

    // 3. Expire validated insights not adopted recently
    const validatedExpireCutoff = now - EXPIRE_DAYS_WITHOUT_ADOPTION * 86400_000;
    const staleValidated = db.prepare(`
      UPDATE system_insights
      SET status = 'expired', expired_at = ?, updated_at = ?
      WHERE status = 'validated'
        AND (last_adopted_at IS NULL OR last_adopted_at < ?)
        AND updated_at < ?
    `).run(now, now, validatedExpireCutoff, validatedExpireCutoff);

    expired = staleTentative.changes + staleValidated.changes;

    const total = (db.prepare(`SELECT COUNT(*) as c FROM system_insights WHERE status != 'expired'`).get() as { c: number }).c;

    if (validated > 0 || expired > 0) {
      logger.info({ validated, expired, activeTotal: total }, 'Insights lifecycle completed');
    }

    return { validated, expired, total };
  } catch (err) {
    logger.debug({ err }, 'Insights lifecycle skipped (table may not exist)');
    return { validated: 0, expired: 0, total: 0 };
  }
}

export function markInsightAdoptedByDecision(
  db: Database.Database,
  decisionType: string,
  insightIds: string[],
): void {
  if (insightIds.length === 0) return;
  const now = Date.now();
  try {
    const stmt = db.prepare(`
      UPDATE system_insights
      SET adopted_count = adopted_count + 1, last_adopted_at = ?, updated_at = ?
      WHERE id = ?
    `);
    for (const id of insightIds) {
      stmt.run(now, now, id);
    }
  } catch {
    // best-effort
  }
}

import type { Database } from 'better-sqlite3';
import { genId } from '../../utils/id.js';
import { evolutionMetrics } from '../../observability/evolution-metrics.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('skill-telemetry');

const CONSECUTIVE_FAILURE_THRESHOLD = 5;

export interface SkillStatsRow {
  use_count: number;
  view_count: number;
  success_count: number;
  failure_count: number;
  patch_count: number;
  last_used_at: number | null;
  last_viewed_at: number | null;
}

export class SkillTelemetry {
  private consecutiveFailures = new Map<string, number>();

  constructor(private readonly db: Database) {}

  ensureRow(name: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO skills_meta (id, name, version, description, file_path, origin, created_by, state, disabled, created_at, updated_at)
      VALUES (?, ?, '0.1.0', '', '', 'user', 'system', 'active', 0, ?, ?)
    `).run(genId('sk'), name, Date.now(), Date.now());
  }

  bumpView(name: string): void {
    this.ensureRow(name);
    this.db.prepare(
      `UPDATE skills_meta SET view_count = view_count + 1, last_viewed_at = ? WHERE name = ?`,
    ).run(Date.now(), name);
  }

  recordOutcome(name: string, success: boolean): void {
    this.ensureRow(name);
    const field = success ? 'success_count' : 'failure_count';
    this.db.prepare(
      `UPDATE skills_meta SET use_count = use_count + 1, ${field} = ${field} + 1, last_used_at = ? WHERE name = ?`,
    ).run(Date.now(), name);
    evolutionMetrics.skillInvocation.inc({ skill_name: name });

    if (success) {
      this.consecutiveFailures.delete(name);
    } else {
      const count = (this.consecutiveFailures.get(name) ?? 0) + 1;
      this.consecutiveFailures.set(name, count);
      if (count >= CONSECUTIVE_FAILURE_THRESHOLD) {
        this.autoDisable(name, count);
      }
    }
  }

  private autoDisable(name: string, failures: number): void {
    this.updateManifestRow(name, { disabled: true });
    this.recordEvent(name, 'auto_disabled', { reason: `${failures} consecutive failures`, failures });
    this.consecutiveFailures.delete(name);
    logger.warn({ skill: name, failures }, 'Skill auto-disabled due to consecutive failures');
  }

  bumpPatch(name: string): void {
    this.ensureRow(name);
    this.db.prepare(
      `UPDATE skills_meta SET patch_count = patch_count + 1, last_patched_at = ?, updated_at = ? WHERE name = ?`,
    ).run(Date.now(), Date.now(), name);
  }

  getStats(name: string): SkillStatsRow | undefined {
    return this.db.prepare(
      `SELECT use_count, view_count, success_count, failure_count, patch_count, last_used_at, last_viewed_at FROM skills_meta WHERE name = ?`,
    ).get(name) as SkillStatsRow | undefined;
  }

  getSuccessRate(name: string): number | null {
    const stats = this.getStats(name);
    if (!stats || stats.use_count === 0) return null;
    return stats.success_count / stats.use_count;
  }

  recordEvent(skillName: string, eventType: string, payload?: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO skill_events (id, skill_name, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(genId('se'), skillName, eventType, payload ? JSON.stringify(payload) : null, Date.now());
  }

  updateManifestRow(name: string, fields: {
    version?: string;
    description?: string;
    filePath?: string;
    origin?: string;
    createdBy?: string;
    disabled?: boolean;
  }): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (fields.version !== undefined) { sets.push('version = ?'); values.push(fields.version); }
    if (fields.description !== undefined) { sets.push('description = ?'); values.push(fields.description); }
    if (fields.filePath !== undefined) { sets.push('file_path = ?'); values.push(fields.filePath); }
    if (fields.origin !== undefined) { sets.push('origin = ?'); values.push(fields.origin); }
    if (fields.createdBy !== undefined) { sets.push('created_by = ?'); values.push(fields.createdBy); }
    if (fields.disabled !== undefined) { sets.push('disabled = ?'); values.push(fields.disabled ? 1 : 0); }

    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(Date.now());
    values.push(name);

    this.db.prepare(`UPDATE skills_meta SET ${sets.join(', ')} WHERE name = ?`).run(...values);
  }
}

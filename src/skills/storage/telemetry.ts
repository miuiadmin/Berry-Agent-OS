import type { Database } from 'better-sqlite3';
import { genId } from '../../utils/id.js';

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

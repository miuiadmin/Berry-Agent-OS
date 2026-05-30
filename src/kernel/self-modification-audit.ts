import type Database from 'better-sqlite3';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('self-modification');

export type PromptTarget = 'brain_routing' | 'brain_review' | 'brain_permission' | 'brain_correction';

export interface PromptVersion {
  id: string;
  target: PromptTarget;
  version: number;
  content: string;
  reason: string;
  source: 'system' | 'brain_self' | 'user' | 'learning_agent';
  status: 'active' | 'superseded' | 'rolled_back';
  performanceScore: number | null;
  createdAt: number;
}

export interface ModificationProposal {
  target: PromptTarget;
  newContent: string;
  reason: string;
  evidenceIds: string[];
  expectedImprovement: string;
}

export interface ModificationResult {
  approved: boolean;
  versionId: string | null;
  reason: string;
}

export class SelfModificationAudit {
  constructor(private readonly db: Database.Database) {
    this.ensureTable();
  }

  getCurrentVersion(target: PromptTarget): PromptVersion | null {
    try {
      const row = this.db.prepare(`
        SELECT * FROM prompt_versions
        WHERE target = ? AND status = 'active'
        ORDER BY version DESC LIMIT 1
      `).get(target) as Record<string, unknown> | undefined;
      return row ? rowToVersion(row) : null;
    } catch {
      return null;
    }
  }

  getVersionHistory(target: PromptTarget, limit = 10): PromptVersion[] {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM prompt_versions
        WHERE target = ?
        ORDER BY version DESC LIMIT ?
      `).all(target, limit) as Array<Record<string, unknown>>;
      return rows.map(rowToVersion);
    } catch {
      return [];
    }
  }

  recordInitialVersion(target: PromptTarget, content: string): PromptVersion {
    const existing = this.getCurrentVersion(target);
    if (existing) return existing;

    const id = genId('pv');
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO prompt_versions (id, target, version, content, reason, source, status, created_at)
      VALUES (?, ?, 1, ?, 'initial system prompt', 'system', 'active', ?)
    `).run(id, target, content, now);

    return { id, target, version: 1, content, reason: 'initial system prompt', source: 'system', status: 'active', performanceScore: null, createdAt: now };
  }

  applyModification(proposal: ModificationProposal, source: PromptVersion['source'] = 'brain_self'): ModificationResult {
    try {
      const current = this.getCurrentVersion(proposal.target);
      const nextVersion = current ? current.version + 1 : 1;

      // Supersede current version
      if (current) {
        this.db.prepare(`
          UPDATE prompt_versions SET status = 'superseded' WHERE id = ?
        `).run(current.id);
      }

      // Create new version
      const id = genId('pv');
      const now = Date.now();
      this.db.prepare(`
        INSERT INTO prompt_versions (id, target, version, content, reason, source, status, evidence_ids, expected_improvement, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(id, proposal.target, nextVersion, proposal.newContent, proposal.reason, source, JSON.stringify(proposal.evidenceIds), proposal.expectedImprovement, now);

      logger.info({ target: proposal.target, version: nextVersion, reason: proposal.reason }, 'Prompt version updated');

      return { approved: true, versionId: id, reason: 'applied' };
    } catch (err) {
      logger.error({ err, target: proposal.target }, 'Failed to apply modification');
      return { approved: false, versionId: null, reason: (err as Error).message };
    }
  }

  rollback(target: PromptTarget, toVersion?: number): ModificationResult {
    try {
      const current = this.getCurrentVersion(target);
      if (!current) {
        return { approved: false, versionId: null, reason: 'no active version to roll back' };
      }

      // Find the version to roll back to
      let targetRow: Record<string, unknown> | undefined;
      if (toVersion !== undefined) {
        targetRow = this.db.prepare(`
          SELECT * FROM prompt_versions WHERE target = ? AND version = ?
        `).get(target, toVersion) as Record<string, unknown> | undefined;
      } else {
        targetRow = this.db.prepare(`
          SELECT * FROM prompt_versions WHERE target = ? AND version < ? ORDER BY version DESC LIMIT 1
        `).get(target, current.version) as Record<string, unknown> | undefined;
      }

      if (!targetRow) {
        return { approved: false, versionId: null, reason: 'no previous version found' };
      }

      // Mark current as rolled_back
      this.db.prepare(`UPDATE prompt_versions SET status = 'rolled_back' WHERE id = ?`).run(current.id);

      // Reactivate target version
      this.db.prepare(`UPDATE prompt_versions SET status = 'active' WHERE id = ?`).run(targetRow.id as string);

      logger.info({ target, fromVersion: current.version, toVersion: targetRow.version }, 'Prompt rolled back');
      return { approved: true, versionId: targetRow.id as string, reason: `rolled back to v${targetRow.version}` };
    } catch (err) {
      return { approved: false, versionId: null, reason: (err as Error).message };
    }
  }

  recordPerformanceScore(versionId: string, score: number): void {
    try {
      this.db.prepare(`
        UPDATE prompt_versions SET performance_score = ? WHERE id = ?
      `).run(score, versionId);
    } catch {
      // best-effort
    }
  }

  getModificationStats(target: PromptTarget): { totalVersions: number; rollbacks: number; avgScore: number | null } {
    try {
      const total = (this.db.prepare(`SELECT COUNT(*) as c FROM prompt_versions WHERE target = ?`).get(target) as { c: number }).c;
      const rollbacks = (this.db.prepare(`SELECT COUNT(*) as c FROM prompt_versions WHERE target = ? AND status = 'rolled_back'`).get(target) as { c: number }).c;
      const avgRow = this.db.prepare(`SELECT AVG(performance_score) as avg FROM prompt_versions WHERE target = ? AND performance_score IS NOT NULL`).get(target) as { avg: number | null };
      return { totalVersions: total, rollbacks, avgScore: avgRow.avg };
    } catch {
      return { totalVersions: 0, rollbacks: 0, avgScore: null };
    }
  }

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS prompt_versions (
          id TEXT PRIMARY KEY,
          target TEXT NOT NULL,
          version INTEGER NOT NULL,
          content TEXT NOT NULL,
          reason TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('system','brain_self','user','learning_agent')),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','rolled_back')),
          evidence_ids TEXT,
          expected_improvement TEXT,
          performance_score REAL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        );

        CREATE INDEX IF NOT EXISTS idx_prompt_versions_target_active
          ON prompt_versions(target, status) WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS idx_prompt_versions_target_version
          ON prompt_versions(target, version DESC);
      `);
    } catch {
      // already exists or migration issue
    }
  }
}

function rowToVersion(row: Record<string, unknown>): PromptVersion {
  return {
    id: row.id as string,
    target: row.target as PromptTarget,
    version: row.version as number,
    content: row.content as string,
    reason: row.reason as string,
    source: row.source as PromptVersion['source'],
    status: row.status as PromptVersion['status'],
    performanceScore: row.performance_score as number | null,
    createdAt: row.created_at as number,
  };
}

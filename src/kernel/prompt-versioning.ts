import type Database from 'better-sqlite3';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('prompt-versioning');

export interface PromptVersion {
  id: string;
  promptKey: string;
  version: number;
  content: string;
  previousVersionId: string | null;
  changeReason: string;
  changeSource: 'brain' | 'learning' | 'manual';
  status: 'active' | 'rolled_back' | 'superseded';
  metricsAtCreation: string | null;
  metricsAfterAdoption: string | null;
  createdAt: number;
  rolledBackAt: number | null;
}

export interface ProposePromptChangeInput {
  promptKey: string;
  newContent: string;
  changeReason: string;
  changeSource: 'brain' | 'learning' | 'manual';
  currentMetrics?: Record<string, number>;
}

export class PromptVersioning {
  constructor(private readonly db: Database.Database) {
    this.ensureTable();
  }

  getActiveVersion(promptKey: string): PromptVersion | null {
    try {
      const row = this.db.prepare(`
        SELECT * FROM prompt_versions
        WHERE prompt_key = ? AND status = 'active'
        ORDER BY version DESC LIMIT 1
      `).get(promptKey) as Record<string, unknown> | undefined;
      return row ? rowToVersion(row) : null;
    } catch (e) {
      logger.debug({ err: e, promptKey }, 'getActiveVersion query failed');
      return null;
    }
  }

  getVersionHistory(promptKey: string, limit = 10): PromptVersion[] {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM prompt_versions
        WHERE prompt_key = ?
        ORDER BY version DESC LIMIT ?
      `).all(promptKey, limit) as Array<Record<string, unknown>>;
      return rows.map(rowToVersion);
    } catch (e) {
      logger.debug({ err: e, promptKey }, 'getVersionHistory query failed');
      return [];
    }
  }

  propose(input: ProposePromptChangeInput): PromptVersion {
    const current = this.getActiveVersion(input.promptKey);
    const nextVersion = current ? current.version + 1 : 1;

    // Mark current as superseded
    if (current) {
      this.db.prepare(`
        UPDATE prompt_versions SET status = 'superseded' WHERE id = ?
      `).run(current.id);
    }

    const id = genId('pv');
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO prompt_versions
        (id, prompt_key, version, content, previous_version_id, change_reason, change_source, status, metrics_at_creation, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      id,
      input.promptKey,
      nextVersion,
      input.newContent,
      current?.id ?? null,
      input.changeReason,
      input.changeSource,
      input.currentMetrics ? JSON.stringify(input.currentMetrics) : null,
      now,
    );

    logger.info({ promptKey: input.promptKey, version: nextVersion, source: input.changeSource }, 'New prompt version created');

    return {
      id,
      promptKey: input.promptKey,
      version: nextVersion,
      content: input.newContent,
      previousVersionId: current?.id ?? null,
      changeReason: input.changeReason,
      changeSource: input.changeSource,
      status: 'active',
      metricsAtCreation: input.currentMetrics ? JSON.stringify(input.currentMetrics) : null,
      metricsAfterAdoption: null,
      createdAt: now,
      rolledBackAt: null,
    };
  }

  rollback(promptKey: string, reason?: string): PromptVersion | null {
    const current = this.getActiveVersion(promptKey);
    if (!current || !current.previousVersionId) {
      logger.warn({ promptKey }, 'Cannot rollback: no previous version');
      return null;
    }

    const now = Date.now();

    // Mark current as rolled_back
    this.db.prepare(`
      UPDATE prompt_versions SET status = 'rolled_back', rolled_back_at = ? WHERE id = ?
    `).run(now, current.id);

    // Reactivate previous version
    this.db.prepare(`
      UPDATE prompt_versions SET status = 'active' WHERE id = ?
    `).run(current.previousVersionId);

    logger.info({ promptKey, rolledBackFrom: current.version, reason }, 'Prompt rolled back');

    return this.getActiveVersion(promptKey);
  }

  recordMetricsAfterAdoption(versionId: string, metrics: Record<string, number>): void {
    try {
      this.db.prepare(`
        UPDATE prompt_versions SET metrics_after_adoption = ? WHERE id = ?
      `).run(JSON.stringify(metrics), versionId);
    } catch {
      // best-effort
    }
  }

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS prompt_versions (
          id TEXT PRIMARY KEY,
          prompt_key TEXT NOT NULL,
          version INTEGER NOT NULL,
          content TEXT NOT NULL,
          previous_version_id TEXT,
          change_reason TEXT NOT NULL,
          change_source TEXT NOT NULL CHECK(change_source IN ('brain','learning','manual')),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','rolled_back','superseded')),
          metrics_at_creation TEXT,
          metrics_after_adoption TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          rolled_back_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_prompt_versions_key_status
          ON prompt_versions(prompt_key, status);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_versions_key_version
          ON prompt_versions(prompt_key, version);
      `);
    } catch {
      // table might already exist
    }
  }
}

function rowToVersion(row: Record<string, unknown>): PromptVersion {
  return {
    id: row.id as string,
    promptKey: row.prompt_key as string,
    version: row.version as number,
    content: row.content as string,
    previousVersionId: row.previous_version_id as string | null,
    changeReason: row.change_reason as string,
    changeSource: row.change_source as 'brain' | 'learning' | 'manual',
    status: row.status as 'active' | 'rolled_back' | 'superseded',
    metricsAtCreation: row.metrics_at_creation as string | null,
    metricsAfterAdoption: row.metrics_after_adoption as string | null,
    createdAt: row.created_at as number,
    rolledBackAt: row.rolled_back_at as number | null,
  };
}

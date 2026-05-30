import type Database from 'better-sqlite3';
import { genId } from '../utils/id.js';
import type { IWorkspaceContextService, WorkspaceContextHistoryRow } from './contracts.js';

export class WorkspaceContextService implements IWorkspaceContextService {
  private stmts: ReturnType<typeof this.prepareStatements>;

  constructor(private db: Database.Database) {
    this.stmts = this.prepareStatements();
  }

  private prepareStatements() {
    return {
      getContext: this.db.prepare(`SELECT context FROM workspaces WHERE id = ?`),
      updateContext: this.db.prepare(`UPDATE workspaces SET context = ? WHERE id = ?`),
      getCurrentVersion: this.db.prepare(`SELECT MAX(version) as v FROM workspace_context_history WHERE workspace_id = ?`),
      insertHistory: this.db.prepare(`
        INSERT INTO workspace_context_history (id, workspace_id, version, content, change_summary, changed_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      getVersion: this.db.prepare(`SELECT * FROM workspace_context_history WHERE workspace_id = ? AND version = ?`),
      getHistory: this.db.prepare(`SELECT * FROM workspace_context_history WHERE workspace_id = ? ORDER BY version DESC LIMIT ?`),
      pruneOld: this.db.prepare(`
        DELETE FROM workspace_context_history WHERE workspace_id = ? AND version < ?
      `),
      countVersions: this.db.prepare(`SELECT COUNT(*) as cnt FROM workspace_context_history WHERE workspace_id = ?`),
      getMinVersionToKeep: this.db.prepare(`
        SELECT version FROM workspace_context_history WHERE workspace_id = ? ORDER BY version DESC LIMIT 1 OFFSET ?
      `),
    };
  }

  getContext(workspaceId: string): string | null {
    const row = this.stmts.getContext.get(workspaceId) as { context: string | null } | undefined;
    return row?.context ?? null;
  }

  updateContext(workspaceId: string, content: string, changedBy: string, changeSummary?: string): number {
    const currentVersion = this.getCurrentVersion(workspaceId);
    const newVersion = currentVersion + 1;
    const now = Date.now();

    this.stmts.updateContext.run(content, workspaceId);
    this.stmts.insertHistory.run(genId(), workspaceId, newVersion, content, changeSummary ?? null, changedBy, now);

    return newVersion;
  }

  getVersion(workspaceId: string, version: number): WorkspaceContextHistoryRow | null {
    return (this.stmts.getVersion.get(workspaceId, version) as WorkspaceContextHistoryRow) ?? null;
  }

  getHistory(workspaceId: string, limit?: number): WorkspaceContextHistoryRow[] {
    return this.stmts.getHistory.all(workspaceId, limit ?? 20) as WorkspaceContextHistoryRow[];
  }

  getCurrentVersion(workspaceId: string): number {
    const row = this.stmts.getCurrentVersion.get(workspaceId) as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  freezeSnapshot(workspaceId: string): string {
    return this.getContext(workspaceId) ?? '';
  }

  rollbackToVersion(workspaceId: string, version: number, changedBy: string): number {
    const historyRow = this.getVersion(workspaceId, version);
    if (!historyRow) throw new Error(`Version ${version} not found for workspace ${workspaceId}`);
    return this.updateContext(workspaceId, historyRow.content, changedBy, `Rollback to version ${version}`);
  }

  pruneOldVersions(workspaceId: string, keep?: number): number {
    const keepCount = keep ?? 20;
    const cutoffRow = this.stmts.getMinVersionToKeep.get(workspaceId, keepCount - 1) as { version: number } | undefined;
    if (!cutoffRow) return 0;
    const result = this.stmts.pruneOld.run(workspaceId, cutoffRow.version);
    return result.changes;
  }
}

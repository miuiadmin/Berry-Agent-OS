import type Database from 'better-sqlite3';
import { genId } from '../utils/id.js';
import type { IAsyncDelegationService, AsyncDelegationRow, CreateAsyncDelegationInput, AsyncDelegationStatus, AggregatedResult } from './contracts.js';

export class AsyncDelegationService implements IAsyncDelegationService {
  private stmts: ReturnType<typeof this.prepareStatements>;

  constructor(private db: Database.Database) {
    this.stmts = this.prepareStatements();
  }

  private prepareStatements() {
    return {
      insert: this.db.prepare(`
        INSERT INTO async_delegations (id, source_session_id, source_workspace_id, target_workspace_id, target_agent_id, prompt, context_snapshot, status, priority, timeout_ms, parent_delegation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `),
      get: this.db.prepare(`SELECT * FROM async_delegations WHERE id = ?`),
      listBySession: this.db.prepare(`SELECT * FROM async_delegations WHERE source_session_id = ? ORDER BY created_at DESC`),
      listByWorkspace: this.db.prepare(`SELECT * FROM async_delegations WHERE target_workspace_id = ? ORDER BY created_at DESC`),
      listByWorkspaceStatus: this.db.prepare(`SELECT * FROM async_delegations WHERE target_workspace_id = ? AND status = ? ORDER BY created_at DESC`),
      updateStatus: this.db.prepare(`UPDATE async_delegations SET status = ? WHERE id = ?`),
      accept: this.db.prepare(`UPDATE async_delegations SET status = 'accepted', accepted_at = ? WHERE id = ?`),
      markRunning: this.db.prepare(`UPDATE async_delegations SET status = 'running' WHERE id = ?`),
      complete: this.db.prepare(`UPDATE async_delegations SET status = 'completed', result = ?, completed_at = ? WHERE id = ?`),
      fail: this.db.prepare(`UPDATE async_delegations SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`),
      cancel: this.db.prepare(`UPDATE async_delegations SET status = 'cancelled', completed_at = ? WHERE id = ?`),
      findTimedOut: this.db.prepare(`
        SELECT * FROM async_delegations
        WHERE status IN ('pending','accepted','running')
          AND created_at + timeout_ms < ?
      `),
      getMultiple: this.db.prepare(`SELECT * FROM async_delegations WHERE id IN (SELECT value FROM json_each(?))`),
    };
  }

  create(input: CreateAsyncDelegationInput): AsyncDelegationRow {
    const id = genId();
    const now = Date.now();
    const priority = input.priority ?? 'normal';
    const timeoutMs = input.timeoutMs ?? 7200000;
    this.stmts.insert.run(
      id, input.sourceSessionId, input.sourceWorkspaceId ?? null,
      input.targetWorkspaceId, input.targetAgentId ?? null,
      input.prompt, input.contextSnapshot ?? null,
      priority, timeoutMs, input.parentDelegationId ?? null, now,
    );
    return {
      id, source_session_id: input.sourceSessionId,
      source_workspace_id: input.sourceWorkspaceId ?? null,
      target_workspace_id: input.targetWorkspaceId,
      target_agent_id: input.targetAgentId ?? null,
      prompt: input.prompt, context_snapshot: input.contextSnapshot ?? null,
      status: 'pending', priority, timeout_ms: timeoutMs,
      result: null, error: null, parent_delegation_id: input.parentDelegationId ?? null,
      created_at: now, accepted_at: null, completed_at: null,
    };
  }

  accept(delegationId: string): void {
    this.stmts.accept.run(Date.now(), delegationId);
  }

  markRunning(delegationId: string): void {
    this.stmts.markRunning.run(delegationId);
  }

  complete(delegationId: string, result: string): void {
    this.stmts.complete.run(result, Date.now(), delegationId);
  }

  fail(delegationId: string, error: string): void {
    this.stmts.fail.run(error, Date.now(), delegationId);
  }

  cancel(delegationId: string): void {
    this.stmts.cancel.run(Date.now(), delegationId);
  }

  get(id: string): AsyncDelegationRow | null {
    return (this.stmts.get.get(id) as AsyncDelegationRow) ?? null;
  }

  listBySession(sessionId: string): AsyncDelegationRow[] {
    return this.stmts.listBySession.all(sessionId) as AsyncDelegationRow[];
  }

  listByWorkspace(workspaceId: string, status?: AsyncDelegationStatus): AsyncDelegationRow[] {
    if (status) return this.stmts.listByWorkspaceStatus.all(workspaceId, status) as AsyncDelegationRow[];
    return this.stmts.listByWorkspace.all(workspaceId) as AsyncDelegationRow[];
  }

  checkTimeouts(): string[] {
    const now = Date.now();
    const timedOut = this.stmts.findTimedOut.all(now) as AsyncDelegationRow[];
    const ids: string[] = [];
    for (const row of timedOut) {
      this.stmts.updateStatus.run('timeout', row.id);
      ids.push(row.id);
    }
    return ids;
  }

  dispatchParallel(inputs: CreateAsyncDelegationInput[]): AsyncDelegationRow[] {
    return inputs.map(input => this.create(input));
  }

  aggregateResults(delegationIds: string[]): AggregatedResult {
    const rows = this.stmts.getMultiple.all(JSON.stringify(delegationIds)) as AsyncDelegationRow[];
    const delegations = rows.map(r => ({
      id: r.id,
      workspaceId: r.target_workspace_id,
      status: r.status,
      result: r.result,
      error: r.error,
    }));
    const allCompleted = delegations.every(d => ['completed', 'failed', 'timeout', 'cancelled'].includes(d.status));
    return { delegations, allCompleted };
  }
}

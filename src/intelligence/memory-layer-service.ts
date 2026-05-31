import type Database from 'better-sqlite3';
import { genId } from '../utils/id.js';
import { MS_PER_DAY } from '../lib/time-constants.js';
import type {
  IMemoryLayerService,
  AgentMemoryRow,
  WorkspaceMemoryRow,
  GlobalMemoryRow,
  AgentMemoryBindingRow,
  CreateAgentMemoryInput,
  CreateWorkspaceMemoryInput,
  CreateGlobalMemoryInput,
  RecallContext,
  RecallResult,
  RecalledMemory,
  MemoryType,
  MemoryVisibility,
  MemoryLayer,
} from './contracts.js';

export class MemoryLayerService implements IMemoryLayerService {
  private stmts: ReturnType<typeof this.prepareStatements>;

  constructor(private db: Database.Database) {
    this.stmts = this.prepareStatements();
  }

  private prepareStatements() {
    return {
      insertAgent: this.db.prepare(`
        INSERT INTO agent_memories_v2 (id, agent_id, workspace_id, type, content, source, importance, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getAgentMemories: this.db.prepare(`
        SELECT * FROM agent_memories_v2 WHERE agent_id = ? AND archived = 0 ORDER BY importance DESC, updated_at DESC LIMIT ?
      `),
      getAgentMemoriesByType: this.db.prepare(`
        SELECT * FROM agent_memories_v2 WHERE agent_id = ? AND archived = 0 AND type = ? ORDER BY importance DESC, updated_at DESC LIMIT ?
      `),
      getAgentMemory: this.db.prepare(`SELECT * FROM agent_memories_v2 WHERE id = ?`),
      updateAgentMemory: this.db.prepare(`UPDATE agent_memories_v2 SET content = ?, importance = ?, type = ?, updated_at = ? WHERE id = ?`),
      archiveAgentMemory: this.db.prepare(`UPDATE agent_memories_v2 SET archived = 1, updated_at = ? WHERE id = ?`),
      recordAgentAccess: this.db.prepare(`
        UPDATE agent_memories_v2 SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?
      `),

      insertWorkspace: this.db.prepare(`
        INSERT INTO workspace_memories (id, workspace_id, owner_agent_id, type, content, origin, visibility, importance, tags, source_memory_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getWorkspaceMemories: this.db.prepare(`
        SELECT * FROM workspace_memories WHERE workspace_id = ? AND archived = 0 ORDER BY importance DESC, updated_at DESC LIMIT ?
      `),
      getWorkspaceMemoriesByVisibility: this.db.prepare(`
        SELECT * FROM workspace_memories WHERE workspace_id = ? AND archived = 0 AND visibility = ? ORDER BY importance DESC, updated_at DESC LIMIT ?
      `),
      getWorkspaceMemoriesByType: this.db.prepare(`
        SELECT * FROM workspace_memories WHERE workspace_id = ? AND archived = 0 AND type = ? ORDER BY importance DESC, updated_at DESC LIMIT ?
      `),
      getWorkspaceMemory: this.db.prepare(`SELECT * FROM workspace_memories WHERE id = ?`),
      updateWorkspaceMemory: this.db.prepare(`UPDATE workspace_memories SET content = ?, importance = ?, visibility = ?, type = ?, updated_at = ? WHERE id = ?`),
      archiveWorkspaceMemory: this.db.prepare(`UPDATE workspace_memories SET archived = 1, updated_at = ? WHERE id = ?`),
      recordWorkspaceAccess: this.db.prepare(`
        UPDATE workspace_memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?
      `),

      insertGlobal: this.db.prepare(`
        INSERT INTO global_memories (id, user_id, type, content, origin, source_workspace_id, source_memory_id, importance, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getGlobalMemories: this.db.prepare(`
        SELECT * FROM global_memories WHERE user_id = ? AND archived = 0 ORDER BY importance DESC, updated_at DESC LIMIT ?
      `),
      getGlobalMemoriesByType: this.db.prepare(`
        SELECT * FROM global_memories WHERE user_id = ? AND archived = 0 AND type = ? ORDER BY importance DESC, updated_at DESC LIMIT ?
      `),
      getGlobalMemory: this.db.prepare(`SELECT * FROM global_memories WHERE id = ?`),
      updateGlobalMemory: this.db.prepare(`UPDATE global_memories SET content = ?, importance = ?, type = ?, updated_at = ? WHERE id = ?`),
      archiveGlobalMemory: this.db.prepare(`UPDATE global_memories SET archived = 1, updated_at = ? WHERE id = ?`),
      recordGlobalAccess: this.db.prepare(`
        UPDATE global_memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?
      `),

      insertBinding: this.db.prepare(`
        INSERT OR IGNORE INTO agent_memory_bindings_v2 (id, agent_id, memory_id, memory_layer, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      deleteBinding: this.db.prepare(`DELETE FROM agent_memory_bindings_v2 WHERE agent_id = ? AND memory_id = ?`),
      getBindings: this.db.prepare(`SELECT * FROM agent_memory_bindings_v2 WHERE agent_id = ? AND enabled = 1`),

      verifyAgent: this.db.prepare(`UPDATE agent_memories_v2 SET updated_at = ? WHERE id = ?`),
      verifyWorkspace: this.db.prepare(`UPDATE workspace_memories SET verified_at = ?, updated_at = ? WHERE id = ?`),
      verifyGlobal: this.db.prepare(`UPDATE global_memories SET verified_at = ?, updated_at = ? WHERE id = ?`),

      insertAgentFts: this.db.prepare(`INSERT INTO agent_memories_fts (rowid, content) VALUES (?, ?)`),
      insertWorkspaceFts: this.db.prepare(`INSERT INTO workspace_memories_fts (rowid, content) VALUES (?, ?)`),
      insertGlobalFts: this.db.prepare(`INSERT INTO global_memories_fts (rowid, content) VALUES (?, ?)`),

      decayAgentKnowledge: this.db.prepare(`
        UPDATE agent_memories_v2 SET importance = MAX(0, importance - 0.1), updated_at = ?
        WHERE archived = 0 AND type IN ('knowledge','context')
          AND last_accessed_at IS NOT NULL AND last_accessed_at < ?
      `),
      decayWorkspaceKnowledge: this.db.prepare(`
        UPDATE workspace_memories SET importance = MAX(0, importance - 0.1), updated_at = ?
        WHERE archived = 0 AND type IN ('knowledge','context')
          AND last_recalled_at IS NOT NULL AND last_recalled_at < ?
      `),
      decayGlobalKnowledge: this.db.prepare(`
        UPDATE global_memories SET importance = MAX(0, importance - 0.1), updated_at = ?
        WHERE archived = 0 AND type IN ('knowledge','context')
          AND last_recalled_at IS NOT NULL AND last_recalled_at < ?
      `),

      archiveStaleAgent: this.db.prepare(`
        UPDATE agent_memories_v2 SET archived = 1, updated_at = ?
        WHERE archived = 0 AND importance <= 0
          AND last_accessed_at IS NOT NULL AND last_accessed_at < ?
      `),
      archiveStaleWorkspace: this.db.prepare(`
        UPDATE workspace_memories SET archived = 1, updated_at = ?
        WHERE archived = 0 AND importance <= 0
          AND last_recalled_at IS NOT NULL AND last_recalled_at < ?
      `),
      archiveStaleGlobal: this.db.prepare(`
        UPDATE global_memories SET archived = 1, updated_at = ?
        WHERE archived = 0 AND importance <= 0
          AND last_recalled_at IS NOT NULL AND last_recalled_at < ?
      `),
    };
  }

  // --- Agent Memory CRUD ---

  createAgentMemory(input: CreateAgentMemoryInput): AgentMemoryRow {
    const id = genId();
    const now = Date.now();
    const importance = input.importance ?? 0.5;
    this.stmts.insertAgent.run(id, input.agentId, input.workspaceId ?? null, input.type, input.content, input.source ?? null, importance, now, now);
    this.syncAgentFts(id, input.content);
    return {
      id, agent_id: input.agentId, workspace_id: input.workspaceId ?? null,
      type: input.type, content: input.content, source: input.source ?? null,
      importance, access_count: 0, last_accessed_at: null, archived: 0, created_at: now, updated_at: now,
    };
  }

  getAgentMemories(agentId: string, opts?: { type?: MemoryType; limit?: number }): AgentMemoryRow[] {
    const limit = opts?.limit ?? 50;
    if (opts?.type) return this.stmts.getAgentMemoriesByType.all(agentId, opts.type, limit) as AgentMemoryRow[];
    return this.stmts.getAgentMemories.all(agentId, limit) as AgentMemoryRow[];
  }

  updateAgentMemory(id: string, updates: Partial<Pick<AgentMemoryRow, 'content' | 'importance' | 'type'>>): void {
    const row = this.stmts.getAgentMemory.get(id) as AgentMemoryRow | undefined;
    if (!row) return;
    const content = updates.content ?? row.content;
    const importance = updates.importance ?? row.importance;
    const type = updates.type ?? row.type;
    this.stmts.updateAgentMemory.run(content, importance, type, Date.now(), id);
    if (updates.content) this.syncAgentFts(id, content);
  }

  deleteAgentMemory(id: string): void {
    this.stmts.archiveAgentMemory.run(Date.now(), id);
  }

  recordAccess(memoryId: string, layer: MemoryLayer): void {
    const now = Date.now();
    switch (layer) {
      case 'agent': this.stmts.recordAgentAccess.run(now, memoryId); break;
      case 'workspace': this.stmts.recordWorkspaceAccess.run(now, memoryId); break;
      case 'global': this.stmts.recordGlobalAccess.run(now, memoryId); break;
    }
  }

  // --- Workspace Memory CRUD ---

  createWorkspaceMemory(input: CreateWorkspaceMemoryInput): WorkspaceMemoryRow {
    const id = genId();
    const now = Date.now();
    const importance = input.importance ?? 0.5;
    const origin = input.origin ?? 'manual';
    const visibility = input.visibility ?? 'workspace';
    const tags = input.tags ? JSON.stringify(input.tags) : null;
    this.stmts.insertWorkspace.run(id, input.workspaceId, input.ownerAgentId ?? null, input.type, input.content, origin, visibility, importance, tags, input.sourceMemoryId ?? null, now, now);
    this.syncWorkspaceFts(id, input.content);
    return {
      id, workspace_id: input.workspaceId, owner_agent_id: input.ownerAgentId ?? null,
      type: input.type, content: input.content, origin, visibility, importance, tags,
      recall_count: 0, verified_at: null, source_memory_id: input.sourceMemoryId ?? null,
      archived: 0, last_recalled_at: null, created_at: now, updated_at: now,
    };
  }

  getWorkspaceMemories(workspaceId: string, opts?: { visibility?: MemoryVisibility; type?: MemoryType; limit?: number }): WorkspaceMemoryRow[] {
    const limit = opts?.limit ?? 50;
    if (opts?.visibility) return this.stmts.getWorkspaceMemoriesByVisibility.all(workspaceId, opts.visibility, limit) as WorkspaceMemoryRow[];
    if (opts?.type) return this.stmts.getWorkspaceMemoriesByType.all(workspaceId, opts.type, limit) as WorkspaceMemoryRow[];
    return this.stmts.getWorkspaceMemories.all(workspaceId, limit) as WorkspaceMemoryRow[];
  }

  updateWorkspaceMemory(id: string, updates: Partial<Pick<WorkspaceMemoryRow, 'content' | 'importance' | 'visibility' | 'type'>>): void {
    const row = this.stmts.getWorkspaceMemory.get(id) as WorkspaceMemoryRow | undefined;
    if (!row) return;
    const content = updates.content ?? row.content;
    const importance = updates.importance ?? row.importance;
    const visibility = updates.visibility ?? row.visibility;
    const type = updates.type ?? row.type;
    this.stmts.updateWorkspaceMemory.run(content, importance, visibility, type, Date.now(), id);
    if (updates.content) this.syncWorkspaceFts(id, content);
  }

  deleteWorkspaceMemory(id: string): void {
    this.stmts.archiveWorkspaceMemory.run(Date.now(), id);
  }

  // --- Global Memory CRUD ---

  createGlobalMemory(input: CreateGlobalMemoryInput): GlobalMemoryRow {
    const id = genId();
    const now = Date.now();
    const importance = input.importance ?? 0.5;
    const origin = input.origin ?? 'manual';
    const tags = input.tags ? JSON.stringify(input.tags) : null;
    this.stmts.insertGlobal.run(id, input.userId, input.type, input.content, origin, input.sourceWorkspaceId ?? null, input.sourceMemoryId ?? null, importance, tags, now, now);
    this.syncGlobalFts(id, input.content);
    return {
      id, user_id: input.userId, type: input.type, content: input.content, origin, importance, tags,
      source_workspace_id: input.sourceWorkspaceId ?? null, source_memory_id: input.sourceMemoryId ?? null,
      recall_count: 0, verified_at: null, archived: 0, last_recalled_at: null, created_at: now, updated_at: now,
    };
  }

  getGlobalMemories(userId: string, opts?: { type?: MemoryType; limit?: number }): GlobalMemoryRow[] {
    const limit = opts?.limit ?? 50;
    if (opts?.type) return this.stmts.getGlobalMemoriesByType.all(userId, opts.type, limit) as GlobalMemoryRow[];
    return this.stmts.getGlobalMemories.all(userId, limit) as GlobalMemoryRow[];
  }

  updateGlobalMemory(id: string, updates: Partial<Pick<GlobalMemoryRow, 'content' | 'importance' | 'type'>>): void {
    const row = this.stmts.getGlobalMemory.get(id) as GlobalMemoryRow | undefined;
    if (!row) return;
    const content = updates.content ?? row.content;
    const importance = updates.importance ?? row.importance;
    const type = updates.type ?? row.type;
    this.stmts.updateGlobalMemory.run(content, importance, type, Date.now(), id);
    if (updates.content) this.syncGlobalFts(id, content);
  }

  deleteGlobalMemory(id: string): void {
    this.stmts.archiveGlobalMemory.run(Date.now(), id);
  }

  // --- Promotion ---

  promoteAgentToWorkspace(memoryId: string): WorkspaceMemoryRow {
    const row = this.stmts.getAgentMemory.get(memoryId) as AgentMemoryRow | undefined;
    if (!row) throw new Error(`Agent memory ${memoryId} not found`);
    if (!row.workspace_id) throw new Error('Cannot promote: no workspace_id on agent memory');
    return this.createWorkspaceMemory({
      workspaceId: row.workspace_id,
      ownerAgentId: row.agent_id,
      type: row.type,
      content: row.content,
      origin: 'promoted',
      visibility: 'workspace',
      importance: row.importance,
      sourceMemoryId: memoryId,
    });
  }

  promoteWorkspaceToGlobal(memoryId: string, userId: string): GlobalMemoryRow {
    const row = this.stmts.getWorkspaceMemory.get(memoryId) as WorkspaceMemoryRow | undefined;
    if (!row) throw new Error(`Workspace memory ${memoryId} not found`);
    return this.createGlobalMemory({
      userId,
      type: row.type,
      content: row.content,
      origin: 'promoted',
      sourceWorkspaceId: row.workspace_id,
      sourceMemoryId: memoryId,
      importance: row.importance,
    });
  }

  evaluatePromotion(memoryId: string): boolean {
    const row = this.stmts.getAgentMemory.get(memoryId) as AgentMemoryRow | undefined;
    if (!row) return false;
    return row.importance >= 0.5 && row.access_count >= 2;
  }

  // --- Recall (FTS5 merged search) ---

  recall(query: string, context: RecallContext): RecallResult {
    const topK = context.topK ?? 12;
    const tokenBudget = context.tokenBudget ?? 8000;
    const now = Date.now();

    const scored: RecalledMemory[] = [];

    if (context.agentId) {
      const agentResults = this.ftsSearch('agent_memories_fts', 'agent_memories_v2', query, context.agentId, 'agent_id', topK * 2);
      for (const r of agentResults) {
        scored.push({
          id: r.id, layer: 'agent', content: r.content, type: r.type as MemoryType,
          importance: r.importance,
          score: this.computeScore(r.rank, r.importance, r.last_ts, now, 0.9),
        });
      }
    }

    if (context.workspaceId) {
      const wsResults = this.ftsSearch('workspace_memories_fts', 'workspace_memories', query, context.workspaceId, 'workspace_id', topK * 2);
      for (const r of wsResults) {
        scored.push({
          id: r.id, layer: 'workspace', content: r.content, type: r.type as MemoryType,
          importance: r.importance,
          score: this.computeScore(r.rank, r.importance, r.last_ts, now, 1.0),
        });
      }
    }

    if (context.userId) {
      const globalResults = this.ftsSearch('global_memories_fts', 'global_memories', query, context.userId, 'user_id', topK * 2);
      for (const r of globalResults) {
        scored.push({
          id: r.id, layer: 'global', content: r.content, type: r.type as MemoryType,
          importance: r.importance,
          score: this.computeScore(r.rank, r.importance, r.last_ts, now, 1.1),
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    const memories: RecalledMemory[] = [];
    let totalChars = 0;
    let truncated = false;

    for (const m of scored) {
      if (memories.length >= topK) { truncated = true; break; }
      if (totalChars + m.content.length > tokenBudget * 4) { truncated = true; break; }
      memories.push(m);
      totalChars += m.content.length;
      this.recordAccess(m.id, m.layer);
    }

    return { memories, totalChars, truncated };
  }

  // --- Decay + Archival ---

  applyTimeDecay(): number {
    const now = Date.now();
    const threshold = now - 90 * MS_PER_DAY; // 90 days
    let total = 0;
    total += this.stmts.decayAgentKnowledge.run(now, threshold).changes;
    total += this.stmts.decayWorkspaceKnowledge.run(now, threshold).changes;
    total += this.stmts.decayGlobalKnowledge.run(now, threshold).changes;
    return total;
  }

  archiveStale(): number {
    const now = Date.now();
    const threshold = now - 90 * MS_PER_DAY;
    let total = 0;
    total += this.stmts.archiveStaleAgent.run(now, threshold).changes;
    total += this.stmts.archiveStaleWorkspace.run(now, threshold).changes;
    total += this.stmts.archiveStaleGlobal.run(now, threshold).changes;
    return total;
  }

  // --- Bindings ---

  bindToAgent(agentId: string, memoryId: string, layer: MemoryLayer, source: string): void {
    this.stmts.insertBinding.run(genId(), agentId, memoryId, layer, source, Date.now());
  }

  unbindFromAgent(agentId: string, memoryId: string): void {
    this.stmts.deleteBinding.run(agentId, memoryId);
  }

  getAgentBindings(agentId: string): AgentMemoryBindingRow[] {
    return this.stmts.getBindings.all(agentId) as AgentMemoryBindingRow[];
  }

  // --- Verify ---

  verifyMemory(memoryId: string, layer: MemoryLayer): void {
    const now = Date.now();
    switch (layer) {
      case 'agent': this.stmts.verifyAgent.run(now, memoryId); break;
      case 'workspace': this.stmts.verifyWorkspace.run(now, now, memoryId); break;
      case 'global': this.stmts.verifyGlobal.run(now, now, memoryId); break;
    }
  }

  // --- FTS helpers ---

  private syncAgentFts(id: string, content: string): void {
    try {
      const rowid = this.getRowId('agent_memories_v2', id);
      if (rowid != null) this.stmts.insertAgentFts.run(rowid, content);
    } catch { /* FTS sync is best-effort */ }
  }

  private syncWorkspaceFts(id: string, content: string): void {
    try {
      const rowid = this.getRowId('workspace_memories', id);
      if (rowid != null) this.stmts.insertWorkspaceFts.run(rowid, content);
    } catch { /* FTS sync is best-effort */ }
  }

  private syncGlobalFts(id: string, content: string): void {
    try {
      const rowid = this.getRowId('global_memories', id);
      if (rowid != null) this.stmts.insertGlobalFts.run(rowid, content);
    } catch { /* FTS sync is best-effort */ }
  }

  private getRowId(table: string, id: string): number | null {
    const row = this.db.prepare(`SELECT rowid FROM ${table} WHERE id = ?`).get(id) as { rowid: number } | undefined;
    return row?.rowid ?? null;
  }

  private ftsSearch(ftsTable: string, sourceTable: string, query: string, filterId: string, filterCol: string, limit: number): FtsRow[] {
    const safeQuery = query.replace(/['"]/g, '').trim();
    if (!safeQuery) return [];

    const terms = safeQuery.split(/\s+/).filter(Boolean).map(t => `"${t}"`).join(' OR ');

    try {
      const sql = `
        SELECT s.id, s.content, s.type, s.importance,
          COALESCE(s.${sourceTable === 'agent_memories_v2' ? 'last_accessed_at' : 'last_recalled_at'}, s.created_at) as last_ts,
          f.rank
        FROM ${ftsTable} f
        JOIN ${sourceTable} s ON s.rowid = f.rowid
        WHERE ${ftsTable} MATCH ? AND s.${filterCol} = ? AND s.archived = 0
        ORDER BY f.rank
        LIMIT ?
      `;
      return this.db.prepare(sql).all(terms, filterId, limit) as FtsRow[];
    } catch {
      return [];
    }
  }

  private computeScore(rank: number, importance: number, lastTs: number, now: number, layerWeight: number): number {
    const bm25 = Math.abs(rank);
    const normalizedBm25 = Math.min(bm25 / 10, 1);
    const daysSinceAccess = (now - lastTs) / MS_PER_DAY;
    const recency = Math.max(0, 1 - daysSinceAccess / 365);
    return (normalizedBm25 * 0.6 + importance * 0.3 + recency * 0.1) * layerWeight;
  }
}

interface FtsRow {
  id: string;
  content: string;
  type: string;
  importance: number;
  last_ts: number;
  rank: number;
}

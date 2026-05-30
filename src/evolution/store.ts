import type { Database } from 'better-sqlite3';
import { genId } from '../utils/id.js';
import type {
  CreateEvolutionProposalInput,
  EvolutionProposal,
  EvolutionProposalStatus,
} from './types.js';

export interface SignalHistoryEntry {
  id: string;
  signalType: string;
  target: string;
  confidence: number;
  sourceTurnId: string | null;
  outcome: 'pending' | 'accepted' | 'rejected' | 'deduped';
  createdAt: number;
}

export class EvolutionProposalStore {
  constructor(private readonly db: Database) {}

  create(input: CreateEvolutionProposalInput): EvolutionProposal {
    const now = Date.now();
    const id = genId('evo');
    this.db.prepare(`
      INSERT INTO evolution_proposals (
        id, type, source, target_name, evidence_json, draft_path,
        diff_json, validator_result, risk_level, status, reason,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.type,
      input.source,
      input.targetName,
      JSON.stringify(input.evidence),
      input.draftPath ?? null,
      input.diff ? JSON.stringify(input.diff) : null,
      input.validatorResult ? JSON.stringify(input.validatorResult) : null,
      input.riskLevel ?? 'medium',
      input.status ?? 'draft',
      input.reason ?? null,
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): EvolutionProposal | undefined {
    const row = this.db.prepare(`SELECT * FROM evolution_proposals WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToProposal(row) : undefined;
  }

  findOpenByTarget(type: string, targetName: string): EvolutionProposal | undefined {
    const row = this.db.prepare(`
      SELECT * FROM evolution_proposals
      WHERE type = ? AND target_name = ? AND status NOT IN ('applied','rejected','failed','rolled_back')
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(type, targetName) as Record<string, unknown> | undefined;
    return row ? rowToProposal(row) : undefined;
  }

  list(status?: EvolutionProposalStatus): EvolutionProposal[] {
    const rows = status
      ? this.db.prepare(`SELECT * FROM evolution_proposals WHERE status = ? ORDER BY updated_at DESC`).all(status)
      : this.db.prepare(`SELECT * FROM evolution_proposals ORDER BY updated_at DESC`).all();
    return (rows as Record<string, unknown>[]).map(rowToProposal);
  }

  update(id: string, updates: {
    status?: EvolutionProposalStatus;
    draftPath?: string | null;
    diff?: Record<string, unknown> | null;
    validatorResult?: Record<string, unknown> | null;
    reason?: string | null;
    brainReviewId?: string | null;
  }): EvolutionProposal {
    const sets = ['updated_at = ?'];
    const values: unknown[] = [Date.now()];

    if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
    if (updates.draftPath !== undefined) { sets.push('draft_path = ?'); values.push(updates.draftPath); }
    if (updates.diff !== undefined) { sets.push('diff_json = ?'); values.push(updates.diff ? JSON.stringify(updates.diff) : null); }
    if (updates.validatorResult !== undefined) { sets.push('validator_result = ?'); values.push(updates.validatorResult ? JSON.stringify(updates.validatorResult) : null); }
    if (updates.reason !== undefined) { sets.push('reason = ?'); values.push(updates.reason); }
    if (updates.brainReviewId !== undefined) { sets.push('brain_review_id = ?'); values.push(updates.brainReviewId); }

    values.push(id);
    this.db.prepare(`UPDATE evolution_proposals SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    const proposal = this.get(id);
    if (!proposal) throw new Error(`自进化提案不存在: ${id}`);
    return proposal;
  }

  getSignalHistory(opts?: { target?: string; limit?: number }): SignalHistoryEntry[] {
    const limit = opts?.limit ?? 100;
    if (opts?.target) {
      const rows = this.db.prepare(
        `SELECT * FROM signal_history WHERE target = ? ORDER BY created_at DESC LIMIT ?`,
      ).all(opts.target, limit) as Record<string, unknown>[];
      return rows.map(rowToSignalHistory);
    }
    const rows = this.db.prepare(
      `SELECT * FROM signal_history ORDER BY created_at DESC LIMIT ?`,
    ).all(limit) as Record<string, unknown>[];
    return rows.map(rowToSignalHistory);
  }
}

function rowToProposal(row: Record<string, unknown>): EvolutionProposal {
  return {
    id: row.id as string,
    type: row.type as EvolutionProposal['type'],
    source: row.source as EvolutionProposal['source'],
    targetName: row.target_name as string,
    evidence: safeParse(row.evidence_json as string, { observations: [], confidence: 0 }),
    draftPath: (row.draft_path as string) ?? null,
    diff: row.diff_json ? safeParse(row.diff_json as string, {}) : null,
    validatorResult: row.validator_result ? safeParse(row.validator_result as string, {}) : null,
    riskLevel: row.risk_level as EvolutionProposal['riskLevel'],
    status: row.status as EvolutionProposal['status'],
    brainReviewId: (row.brain_review_id as string) ?? null,
    reason: (row.reason as string) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function safeParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToSignalHistory(row: Record<string, unknown>): SignalHistoryEntry {
  return {
    id: row.id as string,
    signalType: row.signal_type as string,
    target: row.target as string,
    confidence: row.confidence as number,
    sourceTurnId: (row.source_turn_id as string) ?? null,
    outcome: row.outcome as SignalHistoryEntry['outcome'],
    createdAt: row.created_at as number,
  };
}

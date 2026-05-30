import type { Database } from 'better-sqlite3';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('saga');

export type SagaStatus = 'running' | 'completed' | 'compensating' | 'failed';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'compensated';

export interface SagaStep {
  name: string;
  execute: () => Promise<Record<string, unknown>>;
  compensate?: () => Promise<void>;
}

export interface SagaRecord {
  id: string;
  sessionId: string;
  name: string;
  status: SagaStatus;
  currentStep: number;
  steps: Array<{ name: string; status: StepStatus; output?: Record<string, unknown>; error?: string }>;
  createdAt: number;
  completedAt: number | null;
}

export class SagaOrchestrator {
  constructor(private db: Database) {
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sagas (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        current_step INTEGER NOT NULL DEFAULT 0,
        steps TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sagas_session ON sagas(session_id);
      CREATE INDEX IF NOT EXISTS idx_sagas_status ON sagas(status);
    `);
  }

  async execute(sessionId: string, name: string, steps: SagaStep[]): Promise<SagaRecord> {
    const sagaId = genId('saga');
    const stepRecords = steps.map(s => ({ name: s.name, status: 'pending' as StepStatus }));

    this.db.prepare(`
      INSERT INTO sagas (id, session_id, name, status, current_step, steps, created_at)
      VALUES (?, ?, ?, 'running', 0, ?, ?)
    `).run(sagaId, sessionId, name, JSON.stringify(stepRecords), Date.now());

    const outputs: Array<Record<string, unknown>> = [];

    for (let i = 0; i < steps.length; i++) {
      this.updateStep(sagaId, i, 'running');

      try {
        const output = await steps[i].execute();
        outputs.push(output);
        this.updateStep(sagaId, i, 'completed', output);
      } catch (err) {
        const error = (err as Error).message;
        this.updateStep(sagaId, i, 'failed', undefined, error);
        logger.warn({ sagaId, step: steps[i].name, error }, 'Saga step failed, starting compensation');

        await this.compensate(sagaId, steps, i - 1);
        return this.getSaga(sagaId)!;
      }
    }

    this.db.prepare(`UPDATE sagas SET status = 'completed', completed_at = ? WHERE id = ?`)
      .run(Date.now(), sagaId);

    return this.getSaga(sagaId)!;
  }

  private async compensate(sagaId: string, steps: SagaStep[], fromStep: number): Promise<void> {
    this.db.prepare(`UPDATE sagas SET status = 'compensating' WHERE id = ?`).run(sagaId);

    for (let i = fromStep; i >= 0; i--) {
      if (!steps[i].compensate) {
        this.updateStep(sagaId, i, 'compensated');
        continue;
      }

      try {
        await steps[i].compensate!();
        this.updateStep(sagaId, i, 'compensated');
      } catch (err) {
        logger.error({ sagaId, step: steps[i].name, error: (err as Error).message }, 'Compensation failed');
        this.updateStep(sagaId, i, 'failed', undefined, `Compensation failed: ${(err as Error).message}`);
      }
    }

    this.db.prepare(`UPDATE sagas SET status = 'failed', completed_at = ? WHERE id = ?`)
      .run(Date.now(), sagaId);
  }

  getSaga(sagaId: string): SagaRecord | null {
    const row = this.db.prepare('SELECT * FROM sagas WHERE id = ?').get(sagaId) as {
      id: string; session_id: string; name: string; status: string;
      current_step: number; steps: string; created_at: number; completed_at: number | null;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      name: row.name,
      status: row.status as SagaStatus,
      currentStep: row.current_step,
      steps: JSON.parse(row.steps),
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }

  getBySession(sessionId: string): SagaRecord[] {
    const rows = this.db.prepare('SELECT * FROM sagas WHERE session_id = ? ORDER BY created_at DESC')
      .all(sessionId) as Array<{
        id: string; session_id: string; name: string; status: string;
        current_step: number; steps: string; created_at: number; completed_at: number | null;
      }>;
    return rows.map(row => ({
      id: row.id,
      sessionId: row.session_id,
      name: row.name,
      status: row.status as SagaStatus,
      currentStep: row.current_step,
      steps: JSON.parse(row.steps),
      createdAt: row.created_at,
      completedAt: row.completed_at,
    }));
  }

  private updateStep(sagaId: string, index: number, status: StepStatus, output?: Record<string, unknown>, error?: string): void {
    const saga = this.getSaga(sagaId);
    if (!saga) return;
    saga.steps[index].status = status;
    if (output) saga.steps[index].output = output;
    if (error) saga.steps[index].error = error;
    this.db.prepare('UPDATE sagas SET current_step = ?, steps = ? WHERE id = ?')
      .run(index, JSON.stringify(saga.steps), sagaId);
  }
}

import type { Database } from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('task-checkpoint');

export interface Checkpoint {
  taskId: string;
  stepIndex: number;
  state: Record<string, unknown>;
  createdAt: number;
}

export class TaskCheckpointManager {
  constructor(private db: Database) {
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON task_checkpoints(task_id, step_index DESC);
    `);
  }

  save(taskId: string, stepIndex: number, state: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO task_checkpoints (task_id, step_index, state, created_at)
      VALUES (?, ?, ?, ?)
    `).run(taskId, stepIndex, JSON.stringify(state), Date.now());
    logger.debug({ taskId, stepIndex }, 'Checkpoint saved');
  }

  getLatest(taskId: string): Checkpoint | null {
    const row = this.db.prepare(`
      SELECT task_id, step_index, state, created_at
      FROM task_checkpoints
      WHERE task_id = ?
      ORDER BY step_index DESC
      LIMIT 1
    `).get(taskId) as { task_id: string; step_index: number; state: string; created_at: number } | undefined;

    if (!row) return null;
    return {
      taskId: row.task_id,
      stepIndex: row.step_index,
      state: JSON.parse(row.state),
      createdAt: row.created_at,
    };
  }

  getAll(taskId: string): Checkpoint[] {
    const rows = this.db.prepare(`
      SELECT task_id, step_index, state, created_at
      FROM task_checkpoints
      WHERE task_id = ?
      ORDER BY step_index ASC
    `).all(taskId) as Array<{ task_id: string; step_index: number; state: string; created_at: number }>;

    return rows.map(r => ({
      taskId: r.task_id,
      stepIndex: r.step_index,
      state: JSON.parse(r.state),
      createdAt: r.created_at,
    }));
  }

  cleanup(taskId: string): number {
    const result = this.db.prepare('DELETE FROM task_checkpoints WHERE task_id = ?').run(taskId);
    if (result.changes > 0) {
      logger.debug({ taskId, deleted: result.changes }, 'Checkpoints cleaned up');
    }
    return result.changes;
  }

  purgeOlderThan(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db.prepare('DELETE FROM task_checkpoints WHERE created_at < ?').run(cutoff);
    return result.changes;
  }
}

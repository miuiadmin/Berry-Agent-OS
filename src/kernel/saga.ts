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

  // ─────────────────────────────────────────────────────────────
  // VF-4: 运行时补偿注册（late-binding）
  // ─────────────────────────────────────────────────────────────

  /**
   * 创建一个空 saga 并立即转为 running 状态。
   *
   * 配合 addCompensation() 使用：先创建 saga，然后在工具执行过程中
   * 逐个注册补偿动作，最后手动 complete 或 compensate。
   *
   * @param sessionId 会话 ID
   * @param name saga 名称（如 "code_write_task"）
   * @returns saga ID
   */
  createSaga(sessionId: string, name: string): string {
    const sagaId = genId('saga');
    this.db.prepare(`
      INSERT INTO sagas (id, session_id, name, status, current_step, steps, created_at)
      VALUES (?, ?, ?, 'running', 0, '[]', ?)
    `).run(sagaId, sessionId, name, Date.now());
    return sagaId;
  }

  /**
   * 向运行中的 saga 添加一个补偿步骤（late-binding）。
   *
   * 每次工具（如 write_file）执行成功后调用，注册对应的回滚动作。
   * 仅在内存中保存闭包；SQLite 仅记录步骤名称和状态。
   *
   * @param sagaId saga ID
   * @param stepName 步骤名称（如 "write_auth.ts"）
   * @param compensate 回滚闭包（恢复文件旧内容等）
   */
  addCompensation(sagaId: string, stepName: string, compensate: () => Promise<void>): void {
    // 持久化步骤记录到 SQLite（compensate 闭包只存内存）
    const saga = this.getSaga(sagaId);
    if (!saga || saga.status !== 'running') return;

    const stepRecord = { name: stepName, status: 'completed' as StepStatus };
    saga.steps.push(stepRecord);
    this.db.prepare('UPDATE sagas SET current_step = ?, steps = ? WHERE id = ?')
      .run(saga.steps.length - 1, JSON.stringify(saga.steps), sagaId);

    // 内存中保存闭包
    this.pendingCompensations.get(sagaId)?.push({ name: stepName, compensate });
  }

  /**
   * 手动完成 saga（无需补偿）。
   */
  completeSaga(sagaId: string): void {
    this.db.prepare(`UPDATE sagas SET status = 'completed', completed_at = ? WHERE id = ?`)
      .run(Date.now(), sagaId);
    this.pendingCompensations.delete(sagaId);
  }

  /**
   * 手动触发补偿：执行该 saga 所有已注册的补偿动作（倒序）。
   *
   * 适用场景：用户拒绝确认 / 任务被终止 / Brain stop 动作。
   *
   * @param sagaId saga ID
   * @returns 是否成功完成所有补偿
   */
  async compensateSaga(sagaId: string): Promise<boolean> {
    const saga = this.getSaga(sagaId);
    if (!saga) return false;

    this.db.prepare(`UPDATE sagas SET status = 'compensating' WHERE id = ?`).run(sagaId);

    const compensations = this.pendingCompensations.get(sagaId) ?? [];
    let allSuccess = true;

    // 倒序执行补偿（最后写入的最先回滚）
    for (let i = compensations.length - 1; i >= 0; i--) {
      try {
        await compensations[i].compensate();
        if (saga.steps[i]) saga.steps[i].status = 'compensated';
        logger.debug({ sagaId, step: compensations[i].name }, 'saga:compensation step completed');
      } catch (err) {
        allSuccess = false;
        logger.error({ sagaId, step: compensations[i].name, error: (err as Error).message }, 'saga:compensation step failed');
        if (saga.steps[i]) saga.steps[i].status = 'failed';
      }
    }

    this.db.prepare('UPDATE sagas SET status = ?, steps = ?, completed_at = ? WHERE id = ?')
      .run(allSuccess ? 'completed' : 'failed', JSON.stringify(saga.steps), Date.now(), sagaId);
    this.pendingCompensations.delete(sagaId);

    return allSuccess;
  }

  /** sagaId → 补偿闭包列表（内存态，进程重启后丢失） */
  private pendingCompensations = new Map<string, Array<{ name: string; compensate: () => Promise<void> }>>();

  /**
   * 确保 saga 的内存补偿列表已初始化（内部使用）。
   * addCompensation 调用前需要先调用此方法。
   */
  ensureCompensationList(sagaId: string): void {
    if (!this.pendingCompensations.has(sagaId)) {
      this.pendingCompensations.set(sagaId, []);
    }
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

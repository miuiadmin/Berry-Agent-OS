import type { Database } from 'better-sqlite3';
import { genId } from '../utils/id.js';

export interface FileLock {
  id: string;
  filePath: string;
  workspaceDir: string;
  taskId: string;
  agentName: string;
  lockType: 'read' | 'write';
  fileHash: string | null;
  acquiredAt: number;
  expiresAt: number;
}

export interface AcquireParams {
  filePath: string;
  workspaceDir: string;
  taskId: string;
  agentName: string;
  lockType: 'read' | 'write';
  fileHash?: string;
  ttlMs?: number;
}

// LockStatus 已在 16.0 §17.8 随 isLocked 一并删除

export class LockConflictError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly existingLock: { taskId: string; agentName: string; lockType: string },
  ) {
    super(`文件锁冲突: ${filePath} 已被 ${existingLock.agentName} (task: ${existingLock.taskId}) 以 ${existingLock.lockType} 锁定`);
    this.name = 'LockConflictError';
  }
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class LockManager {
  constructor(private readonly db: Database) {}

  acquire(params: AcquireParams): FileLock {
    const { filePath, workspaceDir, taskId, agentName, lockType, fileHash, ttlMs } = params;
    const ttl = ttlMs ?? DEFAULT_TTL_MS;
    const now = Date.now();
    const expiresAt = now + ttl;

    const result = this.db.transaction(() => {
      this.expireStaleInternal(now);

      const activeLocks = this.db.prepare(`
        SELECT task_id, agent_name, lock_type, expires_at
        FROM file_locks
        WHERE workspace_dir = ? AND file_path = ? AND status = 'held' AND expires_at > ?
      `).all(workspaceDir, filePath, now) as Array<{ task_id: string; agent_name: string; lock_type: string; expires_at: number }>;

      if (lockType === 'write') {
        const conflict = activeLocks.find(l => l.task_id !== taskId);
        if (conflict) {
          throw new LockConflictError(filePath, {
            taskId: conflict.task_id,
            agentName: conflict.agent_name,
            lockType: conflict.lock_type,
          });
        }
      } else {
        const writeConflict = activeLocks.find(l => l.lock_type === 'write' && l.task_id !== taskId);
        if (writeConflict) {
          throw new LockConflictError(filePath, {
            taskId: writeConflict.task_id,
            agentName: writeConflict.agent_name,
            lockType: writeConflict.lock_type,
          });
        }
      }

      const existing = activeLocks.find(l => l.task_id === taskId);
      if (existing) {
        this.db.prepare(`
          UPDATE file_locks SET expires_at = ?, lock_type = ?
          WHERE workspace_dir = ? AND file_path = ? AND task_id = ? AND status = 'held'
        `).run(expiresAt, lockType, workspaceDir, filePath, taskId);
        return {
          id: '', // will be fetched below
          filePath,
          workspaceDir,
          taskId,
          agentName,
          lockType,
          fileHash: fileHash ?? null,
          acquiredAt: now,
          expiresAt,
        };
      }

      const id = genId('flk');
      this.db.prepare(`
        INSERT INTO file_locks (id, file_path, workspace_dir, task_id, agent_name, lock_type, file_hash, acquired_at, expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'held')
      `).run(id, filePath, workspaceDir, taskId, agentName, lockType, fileHash ?? null, now, expiresAt);

      return { id, filePath, workspaceDir, taskId, agentName, lockType, fileHash: fileHash ?? null, acquiredAt: now, expiresAt } satisfies FileLock;
    })();

    return result;
  }

  release(lockId: string): void {
    this.db.prepare(`
      UPDATE file_locks SET status = 'released', released_at = ? WHERE id = ? AND status = 'held'
    `).run(Date.now(), lockId);
  }

  // extend / isLocked / expireStale / getTaskLocks 已在 16.0 §17.8 删除（零调用方）。
  // acquire / releaseAll 保留（task-phases.ts + agents/bundled/code/entry.ts 活调用）。
  // expireStaleInternal（私有）保留——acquire 内部调用它清理过期锁。

  releaseAll(taskId: string): number {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE file_locks SET status = 'released', released_at = ? WHERE task_id = ? AND status = 'held'
    `).run(now, taskId);
    return result.changes;
  }

  private expireStaleInternal(now: number): number {
    const result = this.db.prepare(`
      UPDATE file_locks SET status = 'expired' WHERE status = 'held' AND expires_at <= ?
    `).run(now);
    return result.changes;
  }
}

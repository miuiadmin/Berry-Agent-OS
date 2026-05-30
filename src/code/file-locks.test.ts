import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb, closeDb } from '../memory/db.js';
import { LockManager, LockConflictError } from './file-locks.js';

let tempDir: string;
let db: Database.Database;
let lockManager: LockManager;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'berry-locks-'));
  const dbPath = join(tempDir, 'test.db');
  db = initDb(dbPath);
  lockManager = new LockManager(db);

  db.prepare(`
    INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, status, input_payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('task_1', 'sess_1', 'corr_1', 'code_task', 'test', 'code', 'running', '{}', Date.now());
  db.prepare(`
    INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, status, input_payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('task_2', 'sess_2', 'corr_2', 'code_task', 'test', 'code', 'running', '{}', Date.now());
});

afterEach(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('LockManager', () => {
  describe('acquire', () => {
    it('成功获取 write 锁', () => {
      const lock = lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'write',
      });
      expect(lock.id).toMatch(/^flk_/);
      expect(lock.filePath).toBe('src/index.ts');
      expect(lock.lockType).toBe('write');
    });

    it('成功获取 read 锁', () => {
      const lock = lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'read',
      });
      expect(lock.lockType).toBe('read');
    });

    it('重复 acquire write 锁抛出 LockConflictError', () => {
      lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'write',
      });

      expect(() => lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_2',
        agentName: 'code',
        lockType: 'write',
      })).toThrow(LockConflictError);
    });

    it('多个 read 锁共存', () => {
      const lock1 = lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'read',
      });
      const lock2 = lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_2',
        agentName: 'code',
        lockType: 'read',
      });
      expect(lock1.id).toBeTruthy();
      expect(lock2.id).toBeTruthy();
    });

    it('write 锁存在时 read 锁被拒绝', () => {
      lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'write',
      });

      expect(() => lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_2',
        agentName: 'code',
        lockType: 'read',
      })).toThrow(LockConflictError);
    });

    it('read 锁存在时 write 锁被拒绝', () => {
      lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'read',
      });

      expect(() => lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_2',
        agentName: 'code',
        lockType: 'write',
      })).toThrow(LockConflictError);
    });

    it('同一任务可以升级锁', () => {
      lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'read',
      });

      const upgraded = lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'write',
      });
      expect(upgraded.lockType).toBe('write');
    });

    it('记录 fileHash', () => {
      const lock = lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'write',
        fileHash: 'abc123',
      });
      expect(lock.fileHash).toBe('abc123');
    });
  });

  describe('release', () => {
    it('释放锁后可重新获取', () => {
      const lock = lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'write',
      });
      lockManager.release(lock.id);

      const newLock = lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_2',
        agentName: 'code',
        lockType: 'write',
      });
      expect(newLock.id).toMatch(/^flk_/);
    });
  });

  describe('extend', () => {
    it('延长到期时间', () => {
      const lock = lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'write',
        ttlMs: 1000,
      });
      lockManager.extend(lock.id, 5000);

      const locks = lockManager.getTaskLocks('task_1');
      expect(locks[0].expiresAt).toBeGreaterThan(lock.expiresAt);
    });
  });

  describe('isLocked', () => {
    it('无锁时返回 locked: false', () => {
      const status = lockManager.isLocked('/repo', 'src/index.ts');
      expect(status.locked).toBe(false);
      expect(status.holders).toHaveLength(0);
    });

    it('有锁时返回正确状态', () => {
      lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'write',
      });
      const status = lockManager.isLocked('/repo', 'src/index.ts');
      expect(status.locked).toBe(true);
      expect(status.lockType).toBe('write');
      expect(status.holders).toHaveLength(1);
      expect(status.holders[0].taskId).toBe('task_1');
    });
  });

  describe('expireStale', () => {
    it('清理过期锁', () => {
      lockManager.acquire({
        filePath: 'src/index.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'write',
        ttlMs: 1, // expires immediately
      });

      // Wait for expiration
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy wait */ }

      const expired = lockManager.expireStale();
      expect(expired).toBe(1);

      const status = lockManager.isLocked('/repo', 'src/index.ts');
      expect(status.locked).toBe(false);
    });
  });

  describe('releaseAll', () => {
    it('批量释放任务的所有锁', () => {
      lockManager.acquire({
        filePath: 'src/a.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'write',
      });
      lockManager.acquire({
        filePath: 'src/b.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'read',
      });

      const released = lockManager.releaseAll('task_1');
      expect(released).toBe(2);

      expect(lockManager.getTaskLocks('task_1')).toHaveLength(0);
    });

    it('不影响其他任务的锁', () => {
      lockManager.acquire({
        filePath: 'src/a.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'write',
      });
      lockManager.acquire({
        filePath: 'src/b.ts',
        workspaceDir: '/repo',
        taskId: 'task_2',
        agentName: 'code',
        lockType: 'write',
      });

      lockManager.releaseAll('task_1');
      expect(lockManager.getTaskLocks('task_2')).toHaveLength(1);
    });
  });

  describe('getTaskLocks', () => {
    it('返回任务持有的所有锁', () => {
      lockManager.acquire({
        filePath: 'src/a.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'write',
      });
      lockManager.acquire({
        filePath: 'src/b.ts',
        workspaceDir: '/repo',
        taskId: 'task_1',
        agentName: 'code',
        lockType: 'read',
      });

      const locks = lockManager.getTaskLocks('task_1');
      expect(locks).toHaveLength(2);
      expect(locks.map(l => l.filePath).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    });
  });
});

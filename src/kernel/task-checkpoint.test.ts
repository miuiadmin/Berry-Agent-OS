import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { TaskCheckpointManager } from './task-checkpoint.js';

describe('TaskCheckpointManager', () => {
  let db: InstanceType<typeof Database>;
  let mgr: TaskCheckpointManager;

  beforeEach(() => {
    db = new Database(':memory:');
    mgr = new TaskCheckpointManager(db);
  });

  it('saves and retrieves latest checkpoint', () => {
    mgr.save('tsk-1', 0, { phase: 'init', files: [] });
    mgr.save('tsk-1', 1, { phase: 'analysis', files: ['a.ts'] });
    mgr.save('tsk-1', 2, { phase: 'codegen', files: ['a.ts', 'b.ts'] });

    const latest = mgr.getLatest('tsk-1');
    expect(latest).not.toBeNull();
    expect(latest!.stepIndex).toBe(2);
    expect(latest!.state).toEqual({ phase: 'codegen', files: ['a.ts', 'b.ts'] });
  });

  it('returns null for tasks without checkpoints', () => {
    expect(mgr.getLatest('nonexistent')).toBeNull();
  });

  it('retrieves all checkpoints in order', () => {
    mgr.save('tsk-1', 0, { step: 'a' });
    mgr.save('tsk-1', 1, { step: 'b' });

    const all = mgr.getAll('tsk-1');
    expect(all).toHaveLength(2);
    expect(all[0].stepIndex).toBe(0);
    expect(all[1].stepIndex).toBe(1);
  });

  it('cleans up checkpoints for a task', () => {
    mgr.save('tsk-1', 0, { x: 1 });
    mgr.save('tsk-1', 1, { x: 2 });

    const deleted = mgr.cleanup('tsk-1');
    expect(deleted).toBe(2);
    expect(mgr.getLatest('tsk-1')).toBeNull();
  });

  it('purges old checkpoints', () => {
    mgr.save('tsk-1', 0, { old: true });
    // Backdate
    db.prepare('UPDATE task_checkpoints SET created_at = ? WHERE task_id = ?')
      .run(Date.now() - 100000, 'tsk-1');

    mgr.save('tsk-2', 0, { fresh: true });

    const purged = mgr.purgeOlderThan(50000);
    expect(purged).toBe(1);
    expect(mgr.getLatest('tsk-1')).toBeNull();
    expect(mgr.getLatest('tsk-2')).not.toBeNull();
  });

  it('isolates checkpoints between tasks', () => {
    mgr.save('tsk-1', 0, { task: 1 });
    mgr.save('tsk-2', 0, { task: 2 });

    expect(mgr.getLatest('tsk-1')!.state).toEqual({ task: 1 });
    expect(mgr.getLatest('tsk-2')!.state).toEqual({ task: 2 });
  });
});

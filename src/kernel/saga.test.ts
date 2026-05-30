import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SagaOrchestrator } from './saga.js';

describe('SagaOrchestrator', () => {
  let db: InstanceType<typeof Database>;
  let saga: SagaOrchestrator;

  beforeEach(() => {
    db = new Database(':memory:');
    saga = new SagaOrchestrator(db);
  });

  it('executes all steps successfully', async () => {
    const result = await saga.execute('sess-1', 'deploy', [
      { name: 'build', execute: async () => ({ artifact: 'dist.zip' }) },
      { name: 'upload', execute: async () => ({ url: 's3://...' }) },
      { name: 'activate', execute: async () => ({ version: '1.2' }) },
    ]);

    expect(result.status).toBe('completed');
    expect(result.steps).toHaveLength(3);
    expect(result.steps.every(s => s.status === 'completed')).toBe(true);
    expect(result.completedAt).not.toBeNull();
  });

  it('compensates on failure in reverse order', async () => {
    const compensated: string[] = [];

    const result = await saga.execute('sess-1', 'deploy', [
      {
        name: 'build',
        execute: async () => ({ ok: true }),
        compensate: async () => { compensated.push('build'); },
      },
      {
        name: 'upload',
        execute: async () => ({ ok: true }),
        compensate: async () => { compensated.push('upload'); },
      },
      {
        name: 'activate',
        execute: async () => { throw new Error('deploy failed'); },
        compensate: async () => { compensated.push('activate'); },
      },
    ]);

    expect(result.status).toBe('failed');
    expect(compensated).toEqual(['upload', 'build']);
    expect(result.steps[2].status).toBe('failed');
    expect(result.steps[1].status).toBe('compensated');
    expect(result.steps[0].status).toBe('compensated');
  });

  it('handles steps without compensate gracefully', async () => {
    const result = await saga.execute('sess-1', 'simple', [
      { name: 'step1', execute: async () => ({}) },
      { name: 'step2', execute: async () => { throw new Error('oops'); } },
    ]);

    expect(result.status).toBe('failed');
    expect(result.steps[0].status).toBe('compensated');
  });

  it('persists saga state', async () => {
    await saga.execute('sess-1', 'test', [
      { name: 'step1', execute: async () => ({ done: true }) },
    ]);

    const records = saga.getBySession('sess-1');
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe('test');
  });

  it('records compensation failure without crashing', async () => {
    const result = await saga.execute('sess-1', 'risky', [
      {
        name: 'step1',
        execute: async () => ({}),
        compensate: async () => { throw new Error('compensate failed'); },
      },
      { name: 'step2', execute: async () => { throw new Error('step failed'); } },
    ]);

    expect(result.status).toBe('failed');
    expect(result.steps[0].status).toBe('failed');
  });
});

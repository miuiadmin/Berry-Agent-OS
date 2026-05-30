import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { IpcCapture } from './ipc-capture.js';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ipc_journal (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      "from" TEXT NOT NULL,
      "to" TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      delivered_at INTEGER
    )
  `);
  return db;
}

function insertMessage(db: Database.Database, msg: {
  id: string; type: string; from: string; to: string;
  payload?: Record<string, unknown>; status?: string; createdAt: number;
}) {
  db.prepare(`INSERT INTO ipc_journal (id, type, "from", "to", payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(msg.id, msg.type, msg.from, msg.to, JSON.stringify(msg.payload ?? {}), msg.status ?? 'delivered', msg.createdAt);
}

describe('IpcCapture', () => {
  let db: Database.Database;
  let capture: IpcCapture;

  beforeEach(() => {
    db = createDb();
    capture = new IpcCapture(db);

    insertMessage(db, { id: 'msg-1', type: 'route.request', from: 'core', to: 'brain', createdAt: 1000 });
    insertMessage(db, { id: 'msg-2', type: 'route.result', from: 'brain', to: 'core', createdAt: 2000 });
    insertMessage(db, { id: 'msg-3', type: 'user.message', from: 'core', to: 'conversation', createdAt: 3000 });
    insertMessage(db, { id: 'msg-4', type: 'review.request', from: 'core', to: 'brain', createdAt: 4000 });
    insertMessage(db, { id: 'msg-5', type: 'review.result', from: 'brain', to: 'core', createdAt: 5000 });
  });

  it('getAll returns all messages in order', () => {
    const all = capture.getAll();
    expect(all).toHaveLength(5);
    expect(all[0].id).toBe('msg-1');
    expect(all[4].id).toBe('msg-5');
  });

  it('filters by type', () => {
    const results = capture.getAll({ type: 'route.request' });
    expect(results).toHaveLength(1);
    expect(results[0].from).toBe('core');
  });

  it('filters by multiple types', () => {
    const results = capture.getAll({ type: ['route.request', 'route.result'] });
    expect(results).toHaveLength(2);
  });

  it('filters by from', () => {
    const results = capture.getAll({ from: 'brain' });
    expect(results).toHaveLength(2);
  });

  it('filters by since timestamp', () => {
    const results = capture.getAll({ since: 3000 });
    expect(results).toHaveLength(3);
  });

  it('getByType is a shorthand', () => {
    const results = capture.getByType('user.message');
    expect(results).toHaveLength(1);
    expect(results[0].to).toBe('conversation');
  });

  it('count returns correct number', () => {
    expect(capture.count({ from: 'core' })).toBe(3);
    expect(capture.count({ to: 'brain' })).toBe(2);
  });

  it('assertHasMessage passes when message exists', () => {
    expect(() => capture.assertHasMessage({ type: 'review.result' })).not.toThrow();
  });

  it('assertHasMessage throws when message not found', () => {
    expect(() => capture.assertHasMessage({ type: 'final.response' })).toThrow('found none');
  });

  it('assertMessageOrder verifies correct ordering', () => {
    expect(() => capture.assertMessageOrder([
      'route.request', 'route.result', 'user.message',
    ])).not.toThrow();
  });

  it('assertMessageOrder throws on wrong order', () => {
    expect(() => capture.assertMessageOrder([
      'review.result', 'route.request',
    ])).toThrow();
  });
});

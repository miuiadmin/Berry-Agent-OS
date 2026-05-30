import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { IpcJournal } from './ipc-journal.js';
import type { IpcMessage } from './types.js';

function makeMsg(overrides: Partial<IpcMessage> = {}): IpcMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'user.message',
    from: 'kernel',
    to: 'brain',
    payload: { text: 'hello' },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('IpcJournal', () => {
  let db: Database.Database;
  let journal: IpcJournal;

  beforeEach(() => {
    db = new Database(':memory:');
    journal = new IpcJournal(db);
  });

  it('records journaled message types', () => {
    const msg = makeMsg({ type: 'user.message' });
    journal.record(msg);

    const pending = journal.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(msg.id);
    expect(pending[0].type).toBe('user.message');
    expect(pending[0].status).toBe('pending');
    expect(JSON.parse(pending[0].payload)).toEqual({ text: 'hello' });
  });

  it('skips non-journaled message types', () => {
    const msg = makeMsg({ type: 'agent.heartbeat' });
    journal.record(msg);

    expect(journal.getPending()).toHaveLength(0);
  });

  it('marks messages as delivered', () => {
    const msg = makeMsg();
    journal.record(msg);
    journal.markDelivered(msg.id);

    expect(journal.getPending()).toHaveLength(0);

    const row = db.prepare('SELECT * FROM ipc_journal WHERE id = ?').get(msg.id) as {
      status: string; delivered_at: number;
    };
    expect(row.status).toBe('delivered');
    expect(row.delivered_at).toBeGreaterThan(0);
  });

  it('marks messages as failed', () => {
    const msg = makeMsg();
    journal.record(msg);
    journal.markFailed(msg.id);

    expect(journal.getPending()).toHaveLength(0);

    const row = db.prepare('SELECT status FROM ipc_journal WHERE id = ?').get(msg.id) as { status: string };
    expect(row.status).toBe('failed');
  });

  it('returns pending messages in order', () => {
    const msg1 = makeMsg({ id: 'msg_1', timestamp: 1000 });
    const msg2 = makeMsg({ id: 'msg_2', timestamp: 2000 });
    const msg3 = makeMsg({ id: 'msg_3', timestamp: 3000 });

    journal.record(msg1);
    journal.record(msg2);
    journal.record(msg3);
    journal.markDelivered('msg_2');

    const pending = journal.getPending();
    expect(pending).toHaveLength(2);
    expect(pending[0].id).toBe('msg_1');
    expect(pending[1].id).toBe('msg_3');
  });

  it('cleans up old delivered messages', () => {
    const msg = makeMsg();
    journal.record(msg);
    journal.markDelivered(msg.id);

    // Override delivered_at to be old
    db.prepare('UPDATE ipc_journal SET delivered_at = ? WHERE id = ?').run(
      Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
      msg.id,
    );

    const cleaned = journal.cleanup();
    expect(cleaned).toBe(1);

    const count = db.prepare('SELECT COUNT(*) as cnt FROM ipc_journal').get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it('does not clean up recent delivered messages', () => {
    const msg = makeMsg();
    journal.record(msg);
    journal.markDelivered(msg.id);

    const cleaned = journal.cleanup();
    expect(cleaned).toBe(0);
  });

  it('shouldJournal returns true for critical types', () => {
    expect(journal.shouldJournal('user.message')).toBe(true);
    expect(journal.shouldJournal('agent.task')).toBe(true);
    expect(journal.shouldJournal('agent.task.result')).toBe(true);
    expect(journal.shouldJournal('route.request')).toBe(true);
    expect(journal.shouldJournal('final.response')).toBe(true);
  });

  it('shouldJournal returns false for non-critical types', () => {
    expect(journal.shouldJournal('agent.heartbeat')).toBe(false);
    expect(journal.shouldJournal('agent.register')).toBe(false);
    expect(journal.shouldJournal('agent.shutdown')).toBe(false);
  });
});

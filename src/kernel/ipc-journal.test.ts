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
    expect(journal.shouldJournal('review.request')).toBe(true);
  });

  it('shouldJournal returns true for agent→core critical types', () => {
    // 之前被遗漏的 agent→core 关键消息现在必须被 journal
    expect(journal.shouldJournal('final.response')).toBe(true);
    expect(journal.shouldJournal('draft.response')).toBe(true);
    expect(journal.shouldJournal('turn.correction')).toBe(true);
    expect(journal.shouldJournal('tool.audit')).toBe(true);
    expect(journal.shouldJournal('dialogue.reply')).toBe(true);
    expect(journal.shouldJournal('verify.request')).toBe(true);
    expect(journal.shouldJournal('verify.result')).toBe(true);
    expect(journal.shouldJournal('drift.check.request')).toBe(true);
    expect(journal.shouldJournal('drift.check.result')).toBe(true);
    expect(journal.shouldJournal('superior.review.request')).toBe(true);
    expect(journal.shouldJournal('superior.review.result')).toBe(true);
    expect(journal.shouldJournal('checkpoint.evaluate')).toBe(true);
    expect(journal.shouldJournal('checkpoint.evaluate.result')).toBe(true);
  });

  it('shouldJournal returns true for telemetry types (subject to sampling)', () => {
    expect(journal.shouldJournal('task.telemetry')).toBe(true);
    expect(journal.shouldJournal('task.progress')).toBe(true);
    expect(journal.shouldJournal('task.acknowledge')).toBe(true);
    expect(journal.shouldJournal('task.started')).toBe(true);
  });

  it('shouldJournal returns false for non-critical types', () => {
    expect(journal.shouldJournal('agent.heartbeat')).toBe(false);
    expect(journal.shouldJournal('agent.register')).toBe(false);
    expect(journal.shouldJournal('agent.shutdown')).toBe(false);
  });

  it('markSent transitions pending → sent', () => {
    const msg = makeMsg();
    journal.record(msg);
    expect(journal.getPending()).toHaveLength(1);
    journal.markSent(msg.id);
    const row = db.prepare('SELECT status FROM ipc_journal WHERE id = ?').get(msg.id) as { status: string };
    expect(row.status).toBe('sent');
  });

  it('markSent only affects pending rows (idempotent for terminal states)', () => {
    const msg = makeMsg();
    journal.record(msg);
    journal.markFailed(msg.id);
    // 已 failed 的不应被 markSent 改回
    journal.markSent(msg.id);
    const row = db.prepare('SELECT status FROM ipc_journal WHERE id = ?').get(msg.id) as { status: string };
    expect(row.status).toBe('failed');
  });

  it('telemetry sampling is stable for same message id', () => {
    const m1 = makeMsg({ id: 'stable_1', type: 'task.telemetry' });
    const m2 = makeMsg({ id: 'stable_1', type: 'task.telemetry' });
    expect(journal.shouldSampleTelemetry(m1)).toBe(journal.shouldSampleTelemetry(m2));
  });

  it('telemetry sampling rate is approximately 10%', () => {
    let sampled = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const msg = makeMsg({ id: `tm_${i}`, type: 'task.telemetry' });
      if (journal.shouldSampleTelemetry(msg)) sampled++;
    }
    // 允许 ±5% 误差
    expect(sampled).toBeGreaterThan(N * 0.05);
    expect(sampled).toBeLessThan(N * 0.15);
  });
});

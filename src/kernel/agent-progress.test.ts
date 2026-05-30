import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { AgentProgress } from './agent-progress.js';
import { EventBus } from './event-bus.js';
import { CORE_INDEX_SQL, CORE_SCHEMA_SQL } from '../memory/schema.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(CORE_SCHEMA_SQL);
  db.exec(CORE_INDEX_SQL);
  db.prepare(`
    INSERT INTO agent_tasks (
      id, session_id, correlation_id, task_type, requester, target_agent, input_payload
    ) VALUES ('tsk_1', 'ses_1', 'cor_1', 'conversation_turn', 'user', 'conversation', '{}')
  `).run();
  return db;
}

describe('AgentProgress', () => {
  it('写入 task_events 并发送事件总线进度', () => {
    const db = createDb();
    const bus = new EventBus();
    const progress = new AgentProgress(db, bus);
    let emitted: { taskId: string; message: string } | null = null;
    bus.on('task.progress', (payload) => {
      emitted = payload;
    });

    progress.report({
      taskId: 'tsk_1',
      sessionId: 'ses_1',
      source: 'conversation',
      message: '正在调用工具',
      payload: { tool: 'read_file' },
    });

    const row = db.prepare(`
      SELECT event_type, source, message, payload FROM task_events WHERE task_id = 'tsk_1'
    `).get() as { event_type: string; source: string; message: string; payload: string };

    expect(row.event_type).toBe('progress');
    expect(row.source).toBe('conversation');
    expect(row.message).toBe('正在调用工具');
    expect(JSON.parse(row.payload)).toEqual({ tool: 'read_file' });
    expect(emitted).toEqual({ taskId: 'tsk_1', message: '正在调用工具', payload: { tool: 'read_file' } });

    db.close();
  });
});

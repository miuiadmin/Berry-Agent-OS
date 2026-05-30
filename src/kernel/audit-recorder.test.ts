import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { AuditRecorder } from './audit-recorder.js';
import { CORE_SCHEMA_SQL, CORE_INDEX_SQL } from '../memory/schema.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(CORE_SCHEMA_SQL);
  db.exec(CORE_INDEX_SQL);
  return db;
}

describe('AuditRecorder', () => {
  let db: Database.Database;
  let recorder: AuditRecorder;

  beforeEach(() => {
    db = createTestDb();
    recorder = new AuditRecorder(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('recordToolCall', () => {
    it('inserts a record into tool_calls table', () => {
      recorder.recordToolCall({
        sessionId: 'ses-1',
        taskId: undefined,
        correlationId: 'cor-1',
        agentName: 'conversation',
        toolName: 'read_file',
        toolInput: '/tmp/test.txt',
        toolResult: 'file contents here',
        isError: false,
        dangerLevel: 'safe',
        durationMs: 42,
        permissionToken: 'ptk-1',
      });

      const rows = db.prepare('SELECT * FROM tool_calls').all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].tool_name).toBe('read_file');
      expect(rows[0].agent_name).toBe('conversation');
      expect(rows[0].is_error).toBe(0);
      expect(rows[0].duration_ms).toBe(42);
      expect(rows[0].permission_token).toBe('ptk-1');
      expect(rows[0].permission_verdict).toBe('allow');
    });

    it('sets permission_verdict to deny when result starts with permission denied prefix', () => {
      recorder.recordToolCall({
        sessionId: 'ses-1',
        agentName: 'conversation',
        toolName: 'run_command',
        toolInput: 'rm -rf /',
        toolResult: '权限被拒绝: 工具被禁止',
        isError: true,
        dangerLevel: 'dangerous',
        durationMs: 1,
      });

      const rows = db.prepare('SELECT permission_verdict FROM tool_calls').all() as any[];
      expect(rows[0].permission_verdict).toBe('deny');
    });

    it('computes consistent input hash', () => {
      const input = '{"path": "/tmp/file.txt"}';
      recorder.recordToolCall({
        sessionId: 'ses-1',
        agentName: 'conversation',
        toolName: 'read_file',
        toolInput: input,
        toolResult: 'ok',
        isError: false,
        dangerLevel: 'safe',
        durationMs: 10,
      });
      recorder.recordToolCall({
        sessionId: 'ses-2',
        agentName: 'learning',
        toolName: 'read_file',
        toolInput: input,
        toolResult: 'ok',
        isError: false,
        dangerLevel: 'safe',
        durationMs: 10,
      });

      const rows = db.prepare('SELECT input_hash FROM tool_calls').all() as any[];
      expect(rows[0].input_hash).toBe(rows[1].input_hash);
    });

    it('does not throw on duplicate calls', () => {
      const call = () => recorder.recordToolCall({
        sessionId: 'ses-1',
        agentName: 'conversation',
        toolName: 'read_file',
        toolInput: '/tmp/test.txt',
        toolResult: 'ok',
        isError: false,
        dangerLevel: 'safe',
        durationMs: 5,
      });

      call();
      call();
      const rows = db.prepare('SELECT * FROM tool_calls').all();
      expect(rows).toHaveLength(2);
    });
  });

  describe('recordReview', () => {
    it('inserts a record into review_requests table', () => {
      recorder.recordReview({
        sessionId: 'ses-1',
        level: 'A',
        draft: 'draft response',
        userMessage: 'hi there',
        toolCalls: [{ name: 'read_file', input: '/tmp', result: 'contents' }],
        verdict: 'approve',
        finalResponse: 'final response',
      });

      const rows = db.prepare('SELECT * FROM review_requests').all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe('ses-1');
      expect(rows[0].level).toBe('A');
      expect(rows[0].verdict).toBe('approve');
      expect(rows[0].draft_response).toBe('draft response');
      expect(rows[0].final_response).toBe('final response');

      const reviewInput = JSON.parse(rows[0].review_input);
      expect(reviewInput.user_message).toBe('hi there');
      expect(reviewInput.tool_calls).toHaveLength(1);
    });
  });
});

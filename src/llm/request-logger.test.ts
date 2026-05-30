import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { RequestLogger } from './request-logger.js';
import { CORE_SCHEMA_SQL, CORE_INDEX_SQL } from '../memory/schema.js';
import type { ModelRequest, ModelResponse } from '../contracts/model.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(CORE_SCHEMA_SQL);
  db.exec(CORE_INDEX_SQL);
  return db;
}

function makeRequest(id = 'req_1'): ModelRequest {
  return {
    id,
    agent: 'test-agent',
    purpose: 'test',
    modelTier: 'default',
    mode: 'live',
    backend: 'ai_sdk',
    apiKind: 'standard',
    sessionId: 'ses_1',
    correlationId: 'corr_1',
    stepIndex: 0,
    messages: [{ role: 'user', content: 'hello' }],
    options: {},
    promptHash: 'hash_abc',
  } as ModelRequest;
}

function makeResponse(requestId = 'req_1'): ModelResponse {
  return {
    requestId,
    content: 'response text',
    contentBlocks: [{ type: 'text', text: 'response text' }],
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
    model: 'claude-sonnet',
  };
}

describe('RequestLogger', () => {
  let db: Database.Database;
  let logger: RequestLogger;

  beforeEach(() => {
    db = createTestDb();
    logger = new RequestLogger(db);
  });

  afterEach(() => {
    db.close();
  });

  it('logPending inserts a row with status pending', () => {
    logger.logPending(makeRequest());

    const rows = db.prepare('SELECT * FROM model_requests').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('req_1');
    expect(rows[0].status).toBe('pending');
    expect(rows[0].session_id).toBe('ses_1');
    expect(rows[0].agent_name).toBe('test-agent');
    expect(rows[0].purpose).toBe('test');
    expect(rows[0].model_tier).toBe('default');
  });

  it('logCompleted updates status to responded with payload', () => {
    logger.logPending(makeRequest());
    logger.logCompleted('req_1', makeResponse());

    const rows = db.prepare('SELECT * FROM model_requests').all() as any[];
    expect(rows[0].status).toBe('responded');
    expect(rows[0].model_name).toBe('claude-sonnet');
    expect(rows[0].responded_at).toBeGreaterThan(0);

    const payload = JSON.parse(rows[0].response_payload);
    expect(payload.content).toBe('response text');
    expect(payload.stopReason).toBe('end_turn');
    expect(payload.usage.inputTokens).toBe(10);
  });

  it('logFailed updates status to failed with error message', () => {
    logger.logPending(makeRequest());
    logger.logFailed('req_1', 'Connection timeout');

    const rows = db.prepare('SELECT * FROM model_requests').all() as any[];
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toBe('Connection timeout');
    expect(rows[0].responded_at).toBeGreaterThan(0);
  });

  it('stores request payload as JSON', () => {
    logger.logPending(makeRequest());

    const rows = db.prepare('SELECT request_payload FROM model_requests').all() as any[];
    const payload = JSON.parse(rows[0].request_payload);
    expect(payload.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});

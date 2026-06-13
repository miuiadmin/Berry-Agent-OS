import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { CORE_SCHEMA_SQL } from '../memory/schema.js';
import { AuditRecorder } from './audit-recorder.js';

/**
 * AuditRecorder redaction 测试 —— 15.0 D3-1 安全网。
 *
 * 钉死 recordToolCall / recordReview 落库前对含密钥的 input/result 做 redactSecrets，
 * 防止工具入参/结果里的密钥（API key、token、私钥）明文持久化到 SQLite。
 */
function makeRecorder(): { recorder: AuditRecorder; db: Database.Database } {
  const db = new Database(':memory:');
  db.exec(CORE_SCHEMA_SQL);
  return { recorder: new AuditRecorder(db), db };
}

const SECRET_INPUT = '{"cmd": "export API_KEY=sk-ant-test1234567890abcdefghijklmnop"}';
const SECRET_RESULT = 'token=xoxp-1234567890abcdefghij';

describe('AuditRecorder redaction (15.0 D3-1)', () => {
  it('recordToolCall: 含密钥的 toolInput/result 落库后被 redact', () => {
    const { recorder, db } = makeRecorder();
    recorder.recordToolCall({
      sessionId: 's1',
      toolName: 'run_command',
      toolInput: SECRET_INPUT,
      toolResult: SECRET_RESULT,
      isError: false,
      dangerLevel: 'moderate',
      durationMs: 10,
      agentName: 'code',
    });

    const row = db.prepare('SELECT input, result, input_hash FROM tool_calls WHERE session_id = ?').get('s1') as {
      input: string; result: string; input_hash: string;
    };
    // 落库内容密钥被替换为 [REDACTED:xxx]
    expect(row.input).not.toContain('sk-ant-test1234567890abcdefghijklmnop');
    expect(row.input).toContain('[REDACTED:');
    expect(row.result).not.toContain('xoxp-1234567890abcdefghij');
    expect(row.result).toContain('[REDACTED:');
  });

  it('recordToolCall: input_hash 仍从原始 toolInput 计算（未 redact）', () => {
    const { recorder, db } = makeRecorder();
    recorder.recordToolCall({
      sessionId: 's2', toolName: 't', toolInput: SECRET_INPUT, toolResult: 'ok',
      isError: false, dangerLevel: 'safe', durationMs: 0, agentName: 'a',
    });
    const row = db.prepare('SELECT input_hash FROM tool_calls WHERE session_id = ?').get('s2') as { input_hash: string };
    const { createHash } = require('node:crypto');
    const expected = createHash('sha256').update(SECRET_INPUT).digest('hex').slice(0, 16);
    expect(row.input_hash).toBe(expected);
  });

  it('recordReview: review_input 内 tool_calls input/result 与 user_message 均 redact', () => {
    const { recorder, db } = makeRecorder();
    recorder.recordReview({
      sessionId: 's3',
      level: 'A',
      draft: 'draft',
      userMessage: 'my key is ghp_1234567890abcdefghijklmnopqrstuvwxyz',
      toolCalls: [{ name: 'run_command', input: SECRET_INPUT, result: SECRET_RESULT }],
      verdict: 'approve',
      finalResponse: 'ok',
    });

    const row = db.prepare('SELECT review_input FROM review_requests WHERE session_id = ?').get('s3') as { review_input: string };
    expect(row.review_input).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwxyz');
    expect(row.review_input).not.toContain('sk-ant-test1234567890abcdefghijklmnop');
    expect(row.review_input).not.toContain('xoxp-1234567890abcdefghij');
    expect(row.review_input).toContain('[REDACTED:');
  });
});

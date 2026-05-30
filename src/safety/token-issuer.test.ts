import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { TokenIssuer, computeBindingHash } from './token-issuer.js';
import { CORE_SCHEMA_SQL, CORE_INDEX_SQL } from '../memory/schema.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(CORE_SCHEMA_SQL);
  db.exec(CORE_INDEX_SQL);
  return db;
}

describe('TokenIssuer', () => {
  let db: Database.Database;
  let issuer: TokenIssuer;

  beforeEach(() => {
    db = createTestDb();
    issuer = new TokenIssuer(db);
  });

  describe('computeBindingHash', () => {
    it('相同参数生成相同 hash', () => {
      const binding = { sessionId: 's1', agentName: 'conversation', toolName: 'read_file', inputHash: 'abc', cwd: '/tmp' };
      expect(computeBindingHash(binding)).toBe(computeBindingHash(binding));
    });

    it('不同参数生成不同 hash', () => {
      const a = { sessionId: 's1', agentName: 'conversation', toolName: 'read_file', inputHash: 'abc' };
      const b = { sessionId: 's2', agentName: 'conversation', toolName: 'read_file', inputHash: 'abc' };
      expect(computeBindingHash(a)).not.toBe(computeBindingHash(b));
    });

    it('cwd 为空时仍可计算', () => {
      const binding = { sessionId: 's1', agentName: 'conversation', toolName: 'read_file', inputHash: 'abc' };
      const hash = computeBindingHash(binding);
      expect(hash).toHaveLength(64);
    });
  });

  describe('issue', () => {
    it('签发 allow_once 令牌', () => {
      const token = issuer.issue({
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_123',
        cwd: '/project',
      });

      expect(token.id).toMatch(/^ptk_/);
      expect(token.sessionId).toBe('sess_1');
      expect(token.agentName).toBe('conversation');
      expect(token.toolName).toBe('read_file');
      expect(token.verdict).toBe('allow_once');
      expect(token.oneTime).toBe(true);
      expect(token.consumed).toBe(false);
      expect(token.expiresAt).toBeGreaterThan(Date.now());
    });

    it('签发 allow_session 令牌', () => {
      const token = issuer.issue({
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'run_command',
        inputHash: 'hash_456',
        verdict: 'allow_session',
        expiresMs: 120_000,
      });

      expect(token.verdict).toBe('allow_session');
      expect(token.oneTime).toBe(false);
    });

    it('令牌持久化到数据库', () => {
      const token = issuer.issue({
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_789',
      });

      const row = db.prepare('SELECT * FROM permission_tokens WHERE id = ?').get(token.id) as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.session_id).toBe('sess_1');
      expect(row.binding_hash).toBe(token.bindingHash);
    });
  });

  describe('validate', () => {
    it('有效令牌通过校验', () => {
      const token = issuer.issue({
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_abc',
        cwd: '/project',
      });

      const result = issuer.validate(token.id, {
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_abc',
        cwd: '/project',
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.token.id).toBe(token.id);
      }
    });

    it('不存在的令牌校验失败', () => {
      const result = issuer.validate('ptk_nonexistent', {
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_abc',
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('不存在');
      }
    });

    it('已消费的令牌校验失败', () => {
      const token = issuer.issue({
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_abc',
      });

      issuer.consume(token.id);

      const result = issuer.validate(token.id, {
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_abc',
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('已被消费');
      }
    });

    it('过期令牌校验失败', () => {
      const token = issuer.issue({
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_abc',
        expiresMs: 1,
      });

      // 等待令牌过期
      const expiresAt = token.expiresAt;
      db.prepare('UPDATE permission_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, token.id);

      const result = issuer.validate(token.id, {
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_abc',
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('已过期');
      }
    });

    it('binding 不匹配校验失败', () => {
      const token = issuer.issue({
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_abc',
      });

      const result = issuer.validate(token.id, {
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'write_file',
        inputHash: 'hash_abc',
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('不匹配');
      }
    });
  });

  describe('consume', () => {
    it('成功消费令牌', () => {
      const token = issuer.issue({
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_abc',
      });

      const consumed = issuer.consume(token.id);
      expect(consumed).toBe(true);

      const row = db.prepare('SELECT consumed, consumed_at FROM permission_tokens WHERE id = ?').get(token.id) as Record<string, unknown>;
      expect(row.consumed).toBe(1);
      expect(row.consumed_at).toBeGreaterThan(0);
    });

    it('重复消费返回 false', () => {
      const token = issuer.issue({
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_abc',
      });

      expect(issuer.consume(token.id)).toBe(true);
      expect(issuer.consume(token.id)).toBe(false);
    });

    it('过期令牌无法消费', () => {
      const token = issuer.issue({
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_abc',
      });

      db.prepare('UPDATE permission_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, token.id);

      expect(issuer.consume(token.id)).toBe(false);
    });
  });

  describe('findSessionToken', () => {
    it('找到未消费的 session 令牌', () => {
      issuer.issue({
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_abc',
        verdict: 'allow_session',
        expiresMs: 60_000,
      });

      const found = issuer.findSessionToken({
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_abc',
      });

      expect(found).not.toBeNull();
      expect(found!.verdict).toBe('allow_session');
    });

    it('不返回 allow_once 令牌', () => {
      issuer.issue({
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_abc',
        verdict: 'allow_once',
      });

      const found = issuer.findSessionToken({
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_abc',
      });

      expect(found).toBeNull();
    });

    it('不返回过期的 session 令牌', () => {
      const token = issuer.issue({
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_abc',
        verdict: 'allow_session',
      });

      db.prepare('UPDATE permission_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, token.id);

      const found = issuer.findSessionToken({
        sessionId: 'sess_1',
        agentName: 'conversation',
        toolName: 'read_file',
        inputHash: 'hash_abc',
      });

      expect(found).toBeNull();
    });
  });

  describe('getAuditLog', () => {
    it('返回指定 session 的审计记录', () => {
      issuer.issue({ sessionId: 'sess_1', agentName: 'conversation', toolName: 'read_file', inputHash: 'h1' });
      issuer.issue({ sessionId: 'sess_1', agentName: 'conversation', toolName: 'write_file', inputHash: 'h2' });
      issuer.issue({ sessionId: 'sess_2', agentName: 'conversation', toolName: 'read_file', inputHash: 'h3' });

      const log = issuer.getAuditLog('sess_1');
      expect(log).toHaveLength(2);
      expect(log[0].toolName).toBe('read_file');
      expect(log[1].toolName).toBe('write_file');
    });

    it('空 session 返回空数组', () => {
      const log = issuer.getAuditLog('nonexistent');
      expect(log).toHaveLength(0);
    });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ApprovalManager } from './approval-manager.js';
import { TokenIssuer } from './token-issuer.js';
import { CORE_SCHEMA_SQL, CORE_INDEX_SQL } from '../memory/schema.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(CORE_SCHEMA_SQL);
  db.exec(CORE_INDEX_SQL);
  return db;
}

function createManager(mode: 'ask' | 'allow-all' | 'deny-all' = 'allow-all') {
  const db = createTestDb();
  const tokenIssuer = new TokenIssuer(db);
  const manager = new ApprovalManager(db, tokenIssuer, mode);
  return { db, tokenIssuer, manager };
}

const baseParams = {
  sessionId: 'sess_1',
  correlationId: 'corr_1',
  kind: 'tool' as const,
  requester: 'conversation',
  riskLevel: 'low' as const,
  requestPayload: { toolName: 'read_file', toolInput: '{"path":"/tmp/test"}' },
  bindingPayload: { agentName: 'conversation', toolName: 'read_file', inputHash: 'hash_abc' },
};

describe('ApprovalManager', () => {
  describe('createRequest', () => {
    it('创建 pending 审批请求', () => {
      const { manager } = createManager();
      const req = manager.createRequest(baseParams);

      expect(req.id).toMatch(/^apr_/);
      expect(req.status).toBe('pending');
      expect(req.sessionId).toBe('sess_1');
      expect(req.kind).toBe('tool');
      expect(req.riskLevel).toBe('low');
      expect(req.expiresAt).toBeGreaterThan(Date.now());
    });

    it('审批请求持久化到数据库', () => {
      const { db, manager } = createManager();
      const req = manager.createRequest(baseParams);

      const row = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(req.id) as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.status).toBe('pending');
      expect(row.kind).toBe('tool');
    });

    it('创建时清理过期请求', () => {
      const { db, manager } = createManager();

      const expired = manager.createRequest({ ...baseParams, expiresMs: 1 });
      db.prepare('UPDATE approval_requests SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, expired.id);

      manager.createRequest(baseParams);

      const row = db.prepare('SELECT status FROM approval_requests WHERE id = ?').get(expired.id) as Record<string, unknown>;
      expect(row.status).toBe('expired');
    });

    it('记录 tool_use_id 和 schema 到请求 payload', () => {
      const { manager } = createManager();

      const req = manager.createRequest({
        ...baseParams,
        toolUseId: 'toolu_1',
        schema: { type: 'object' },
      });

      expect(req.requestPayload.tool_use_id).toBe('toolu_1');
      expect(req.requestPayload.schema).toEqual({ type: 'object' });
    });
  });

  describe('resolve', () => {
    it('批准请求并签发令牌', () => {
      const { manager } = createManager();
      const req = manager.createRequest(baseParams);

      const token = manager.resolve(req.id, {
        verdict: 'approved',
        source: 'rule',
        reason: '自动批准',
      });

      expect(token).not.toBeNull();
      expect(token!.id).toMatch(/^ptk_/);
      expect(token!.toolName).toBe('read_file');
      expect(token!.agentName).toBe('conversation');
    });

    it('拒绝请求返回 null', () => {
      const { manager } = createManager();
      const req = manager.createRequest(baseParams);

      const token = manager.resolve(req.id, {
        verdict: 'denied',
        source: 'user',
        reason: '用户拒绝',
      });

      expect(token).toBeNull();

      const updated = manager.getRequest(req.id);
      expect(updated!.status).toBe('denied');
      expect(updated!.decisionSource).toBe('user');
    });

    it('不能重复 resolve', () => {
      const { manager } = createManager();
      const req = manager.createRequest(baseParams);

      manager.resolve(req.id, { verdict: 'approved', source: 'rule' });
      const second = manager.resolve(req.id, { verdict: 'approved', source: 'rule' });

      expect(second).toBeNull();
    });

    it('不存在的请求返回 null', () => {
      const { manager } = createManager();
      const token = manager.resolve('apr_nonexistent', { verdict: 'approved', source: 'rule' });
      expect(token).toBeNull();
    });

    it('可指定 allow_session 令牌', () => {
      const { manager } = createManager();
      const req = manager.createRequest(baseParams);

      const token = manager.resolve(req.id, {
        verdict: 'approved',
        source: 'rule',
        tokenVerdict: 'allow_session',
        tokenExpiresMs: 300_000,
      });

      expect(token!.verdict).toBe('allow_session');
      expect(token!.oneTime).toBe(false);
    });

    it('计划审批不会签发具体工具令牌', () => {
      const { manager } = createManager();
      const req = manager.createRequest({
        ...baseParams,
        kind: 'code',
        requestPayload: { plan: '修改代码' },
        bindingPayload: { agentName: 'code', toolName: 'plan_approval', inputHash: 'plan_hash' },
      });

      const token = manager.resolve(req.id, {
        verdict: 'approved',
        source: 'user',
        reason: '计划通过',
      });

      expect(token).toBeNull();
      expect(manager.getRequest(req.id)!.status).toBe('approved');
    });

    it('重复响应被忽略', () => {
      const { manager } = createManager();
      const req = manager.createRequest(baseParams);

      const first = manager.resolve(req.id, { verdict: 'approved', source: 'user' });
      const second = manager.resolve(req.id, { verdict: 'denied', source: 'user' });

      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(manager.getRequest(req.id)!.status).toBe('approved');
    });

    it('保存 updatedInput/updatedPermissions 决策信息', () => {
      const { manager } = createManager();
      const req = manager.createRequest(baseParams);

      manager.resolve(req.id, {
        verdict: 'denied',
        source: 'user',
        reason: '需要改参数',
        updatedInput: { path: '/tmp/safe' },
        updatedPermissions: { fs: 'read-only' },
      });

      const updated = manager.getRequest(req.id)!;
      expect(JSON.parse(updated.reason!)).toEqual({
        reason: '需要改参数',
        updatedInput: { path: '/tmp/safe' },
        updatedPermissions: { fs: 'read-only' },
      });
    });
  });

  describe('autoDecide', () => {
    it('allow-all 模式自动批准', () => {
      const { manager } = createManager('allow-all');
      const req = manager.createRequest(baseParams);

      const token = manager.autoDecide(req);
      expect(token).not.toBeNull();
      expect(token!.toolName).toBe('read_file');

      const updated = manager.getRequest(req.id);
      expect(updated!.status).toBe('approved');
      expect(updated!.decisionSource).toBe('rule');
    });

    it('deny-all 模式自动拒绝', () => {
      const { manager } = createManager('deny-all');
      const req = manager.createRequest(baseParams);

      const token = manager.autoDecide(req);
      expect(token).toBeNull();

      const updated = manager.getRequest(req.id);
      expect(updated!.status).toBe('denied');
    });

    it('ask 模式低风险自动批准', () => {
      const { manager } = createManager('ask');
      const req = manager.createRequest({ ...baseParams, riskLevel: 'low' });

      const token = manager.autoDecide(req);
      expect(token).not.toBeNull();
    });

    it('ask 模式高风险暂时自动批准', () => {
      const { manager } = createManager('ask');
      const req = manager.createRequest({ ...baseParams, riskLevel: 'high' });

      const token = manager.autoDecide(req);
      expect(token).not.toBeNull();

      const updated = manager.getRequest(req.id);
      expect(updated!.reason).toContain('Phase 3');
    });
  });

  describe('expire', () => {
    it('批量过期到期请求', () => {
      const { db, manager } = createManager();

      const req1 = manager.createRequest({ ...baseParams, correlationId: 'c1' });
      const req2 = manager.createRequest({ ...baseParams, correlationId: 'c2' });

      db.prepare('UPDATE approval_requests SET expires_at = ? WHERE id IN (?, ?)').run(
        Date.now() - 1000, req1.id, req2.id,
      );

      const count = manager.expire();
      expect(count).toBe(2);

      const r1 = manager.getRequest(req1.id);
      expect(r1!.status).toBe('expired');
    });

    it('未到期请求不受影响', () => {
      const { manager } = createManager();
      manager.createRequest(baseParams);

      const count = manager.expire();
      expect(count).toBe(0);
    });
  });

  describe('cancel', () => {
    it('取消 pending 请求', () => {
      const { manager } = createManager();
      const req = manager.createRequest(baseParams);

      const cancelled = manager.cancel(req.id);
      expect(cancelled).toBe(true);

      const updated = manager.getRequest(req.id);
      expect(updated!.status).toBe('cancelled');
      expect(updated!.resolvedAt).toBeGreaterThan(0);
    });

    it('非 pending 请求无法取消', () => {
      const { manager } = createManager();
      const req = manager.createRequest(baseParams);
      manager.resolve(req.id, { verdict: 'approved', source: 'rule' });

      const cancelled = manager.cancel(req.id);
      expect(cancelled).toBe(false);
    });

    it('不存在的请求返回 false', () => {
      const { manager } = createManager();
      expect(manager.cancel('apr_nonexistent')).toBe(false);
    });
  });

  describe('getPending', () => {
    it('返回所有 pending 请求', () => {
      const { manager } = createManager();
      manager.createRequest({ ...baseParams, correlationId: 'c1' });
      manager.createRequest({ ...baseParams, correlationId: 'c2' });

      const pending = manager.getPending();
      expect(pending).toHaveLength(2);
    });

    it('按 sessionId 过滤', () => {
      const { manager } = createManager();
      manager.createRequest({ ...baseParams, sessionId: 'sess_a', correlationId: 'c1' });
      manager.createRequest({ ...baseParams, sessionId: 'sess_b', correlationId: 'c2' });

      const pending = manager.getPending('sess_a');
      expect(pending).toHaveLength(1);
      expect(pending[0].sessionId).toBe('sess_a');
    });

    it('不包含已 resolved 的请求', () => {
      const { manager } = createManager();
      const req = manager.createRequest(baseParams);
      manager.resolve(req.id, { verdict: 'approved', source: 'rule' });

      const pending = manager.getPending();
      expect(pending).toHaveLength(0);
    });
  });

  describe('getRequest', () => {
    it('返回完整请求信息', () => {
      const { manager } = createManager();
      const req = manager.createRequest(baseParams);

      const found = manager.getRequest(req.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(req.id);
      expect(found!.requestPayload).toEqual(baseParams.requestPayload);
      expect(found!.bindingPayload).toEqual(baseParams.bindingPayload);
    });

    it('不存在的 ID 返回 null', () => {
      const { manager } = createManager();
      expect(manager.getRequest('apr_nonexistent')).toBeNull();
    });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { CORE_SCHEMA_SQL } from '../memory/schema.js';
import { PermissionEngine } from '../safety/permissions.js';
import { TokenIssuer } from '../safety/token-issuer.js';
import { ApprovalManager } from '../safety/approval-manager.js';
import { PermissionCoordinator } from './permission-coordinator.js';
import type { PermissionMode } from '../safety/permissions.js';
import type { DangerLevel } from '../bus/contract.js';

/**
 * PermissionCoordinator.checkAndIssue 表征测试 —— 15.0 机制 A 重构安全网。
 *
 * 钉死 checkAndIssue（所有权限请求的核心入口）的行为矩阵。15.0 收敛后：
 * - requiresReview 一律携带 requestId（历史 quirk 已修复：engine 路径原先在创建
 *   approval request 之前 return，导致 handler 无法 resolve）
 * - allow-all 模式下危险工具类别（write_file）仍 requiresReview（engine 检查先于 mode）
 *
 * 机制 A 在此基础上把 moderate 路由从 user_confirm 改到 Brain，届时增补 yolo 断言。
 * 行为变化需显式记录，不能静默漂移。
 */
function makeCoordinator(mode: PermissionMode): { coord: PermissionCoordinator; db: Database.Database } {
  const db = new Database(':memory:');
  db.exec(CORE_SCHEMA_SQL);
  const tokenIssuer = new TokenIssuer(db);
  const approvalManager = new ApprovalManager(db, tokenIssuer, mode);
  const engine = new PermissionEngine(mode);
  const coord = new PermissionCoordinator({ engine, tokenIssuer, approvalManager });
  return { coord, db };
}

const baseParams = (toolName: string, dangerLevel: DangerLevel) => ({
  agentName: 'conversation',
  sessionId: 'sess_test',
  toolName,
  toolInput: '{}',
  dangerLevel,
  correlationId: 'corr_test',
});

describe('PermissionCoordinator.checkAndIssue 表征（当前行为）', () => {
  describe('mode = allow-all（默认）', () => {
    let coord: PermissionCoordinator;
    beforeEach(() => {
      ({ coord } = makeCoordinator('allow-all'));
    });

    it('safe → allowed + tokenId', () => {
      const r = coord.checkAndIssue(baseParams('memory_query', 'safe'));
      expect(r.allowed).toBe(true);
      expect(r.tokenId).toBeTruthy();
    });

    it('moderate → allowed + tokenId（autoDecide 放行）', () => {
      const r = coord.checkAndIssue(baseParams('moderate_tool', 'moderate'));
      expect(r.allowed).toBe(true);
      expect(r.tokenId).toBeTruthy();
    });

    it('dangerous 普通工具 → allowed + tokenId', () => {
      const r = coord.checkAndIssue(baseParams('plain_tool', 'dangerous'));
      expect(r.allowed).toBe(true);
      expect(r.tokenId).toBeTruthy();
    });

    it('危险工具类别 write_file → requiresReview + requestId（收敛后统一带 requestId）', () => {
      const r = coord.checkAndIssue(baseParams('write_file', 'safe'));
      expect(r.allowed).toBe(false);
      expect(r.requiresReview).toBe(true);
      // 15.0 收敛：engine 危险类别检查后统一创建 approval request，故 requiresReview 带 requestId
      // （历史 quirk 已修复：之前此处无 requestId，handler 无法 resolve）
      expect(r.requestId).toBeTruthy();
    });
  });

  describe('mode = ask', () => {
    let coord: PermissionCoordinator;
    beforeEach(() => {
      ({ coord } = makeCoordinator('ask'));
    });

    it('safe → allowed + tokenId（engine 放行 safe）', () => {
      const r = coord.checkAndIssue(baseParams('memory_query', 'safe'));
      expect(r.allowed).toBe(true);
      expect(r.tokenId).toBeTruthy();
    });

    it('moderate → requiresReview + requestId（收敛修复了无 requestId 的 quirk）', () => {
      const r = coord.checkAndIssue(baseParams('moderate_tool', 'moderate'));
      expect(r.allowed).toBe(false);
      expect(r.requiresReview).toBe(true);
      // 15.0 收敛后：requiresReview 一律带 requestId（historical quirk 已修复）。
      //    机制 A 将在此基础上把 moderate 路由到 Brain（而非 user_confirm）。
      expect(r.requestId).toBeTruthy();
    });

    it('dangerous 普通工具 → requiresReview', () => {
      const r = coord.checkAndIssue(baseParams('plain_tool', 'dangerous'));
      expect(r.requiresReview).toBe(true);
    });

    it('危险工具类别 → requiresReview', () => {
      const r = coord.checkAndIssue(baseParams('edit_code', 'moderate'));
      expect(r.requiresReview).toBe(true);
    });
  });

  describe('mode = deny-all', () => {
    it('safe → denied', () => {
      const { coord } = makeCoordinator('deny-all');
      const r = coord.checkAndIssue(baseParams('memory_query', 'safe'));
      expect(r.allowed).toBe(false);
      expect(r.requiresReview).toBeFalsy();
    });
  });

  describe('active_scope 硬拦截（无 StateCache 时不拦截）', () => {
    it('未注入 StateCache → 不做 scope 拦截，正常走风险路由', () => {
      const { coord } = makeCoordinator('ask');
      const r = coord.checkAndIssue(baseParams('memory_query', 'safe'));
      expect(r.allowed).toBe(true);
    });
  });

  describe('acquire 与 checkAndIssue 一致性', () => {
    it('acquire 对 requiresReview 结果原样透传', () => {
      const { coord } = makeCoordinator('ask');
      const r = coord.acquire(baseParams('moderate_tool', 'moderate'));
      expect(r.requiresReview).toBe(true);
    });

    it('acquire 对 allowed 结果带 tokenId', () => {
      const { coord } = makeCoordinator('allow-all');
      const r = coord.acquire(baseParams('memory_query', 'safe'));
      expect(r.allowed).toBe(true);
      expect(r.tokenId).toBeTruthy();
    });
  });
});

describe('checkAndIssueSimple (15.0 R2-2, module agent requiresReview 不硬拒)', () => {
  it('ask + moderate → 不硬拒，在 scope 内签 token（修复前被拒）', () => {
    const { coord } = makeCoordinator('ask');
    const r = coord.checkAndIssueSimple({ agentName: 'code', sessionId: 's', toolName: 'moderate_tool', toolInput: '{}', dangerLevel: 'moderate' });
    expect(r.allowed).toBe(true);
    expect(r.tokenId).toBeTruthy();
  });

  it('ask + dangerous 普通工具 → 签 token（requiresReview 非硬拒）', () => {
    const { coord } = makeCoordinator('ask');
    const r = coord.checkAndIssueSimple({ agentName: 'code', sessionId: 's', toolName: 'plain_tool', toolInput: '{}', dangerLevel: 'dangerous' });
    expect(r.allowed).toBe(true);
  });

  it('deny-all → 仍硬拒（!allowed 且非 requiresReview）', () => {
    const { coord } = makeCoordinator('deny-all');
    const r = coord.checkAndIssueSimple({ agentName: 'code', sessionId: 's', toolName: 'moderate_tool', toolInput: '{}', dangerLevel: 'moderate' });
    expect(r.allowed).toBe(false);
  });

  it('allow-all + moderate → 签 token', () => {
    const { coord } = makeCoordinator('allow-all');
    const r = coord.checkAndIssueSimple({ agentName: 'code', sessionId: 's', toolName: 'moderate_tool', toolInput: '{}', dangerLevel: 'moderate' });
    expect(r.allowed).toBe(true);
  });
});

describe('PermissionCoordinator per-session mode (15.0 R2-4，并发不污染)', () => {
  it('两个会话不同 mode 互不污染——s1=ask 的 moderate 走 requiresReview，s2=allow-all 放行', () => {
    const { coord } = makeCoordinator('ask'); // 默认 ask
    coord.setSessionMode('s1', 'ask');
    coord.setSessionMode('s2', 'allow-all');
    // s1（ask）：moderate → requiresReview
    const r1 = coord.checkAndIssue({ ...baseParams('moderate_tool', 'moderate'), sessionId: 's1' });
    expect(r1.requiresReview).toBe(true);
    // s2（allow-all）：moderate → allowed + token（不被 s1 的 ask 污染）
    const r2 = coord.checkAndIssue({ ...baseParams('moderate_tool', 'moderate'), sessionId: 's2' });
    expect(r2.allowed).toBe(true);
    expect(r2.tokenId).toBeTruthy();
  });

  it('getMode(sessionId) 返回该会话 mode，无则回退默认', () => {
    const { coord } = makeCoordinator('ask');
    coord.setSessionMode('sX', 'yolo');
    expect(coord.getMode('sX')).toBe('yolo');
    expect(coord.getMode('unknown')).toBe('ask'); // 回退默认
    expect(coord.getMode()).toBe('ask'); // 无参=默认
  });

  it('checkAndIssueSimple 也按 per-session mode（s2=allow-all 的 moderate 签 token）', () => {
    const { coord } = makeCoordinator('deny-all');
    coord.setSessionMode('sA', 'allow-all');
    const r = coord.checkAndIssueSimple({ agentName: 'code', sessionId: 'sA', toolName: 'm', toolInput: '{}', dangerLevel: 'moderate' });
    expect(r.allowed).toBe(true); // sA=allow-all，不被全局 deny-all 污染
  });
});

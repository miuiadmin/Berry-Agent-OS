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

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { CORE_SCHEMA_SQL } from '../memory/schema.js';
import { PermissionEngine } from '../safety/permissions.js';
import { TokenIssuer } from '../safety/token-issuer.js';
import { ApprovalManager } from '../safety/approval-manager.js';
import { PermissionCoordinator } from './permission-coordinator.js';
import { StateCache } from './state-cache.js';
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
function makeCoordinator(mode: PermissionMode, withCache = false): { coord: PermissionCoordinator; db: Database.Database; stateCache: StateCache } {
  const db = new Database(':memory:');
  db.exec(CORE_SCHEMA_SQL);
  const tokenIssuer = new TokenIssuer(db);
  const approvalManager = new ApprovalManager(db, tokenIssuer, mode);
  const engine = new PermissionEngine(mode);
  const stateCache = new StateCache();
  const coord = new PermissionCoordinator(withCache ? { engine, tokenIssuer, approvalManager, stateCache } : { engine, tokenIssuer, approvalManager });
  return { coord, db, stateCache };
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

/**
 * 15.0 D4：updateEngine 是 config reload 的活跃入口（CoreService 在 permissionMode 变更时调用）。
 * 钉死它改变全局默认 mode，且只影响无显式 per-session mode 的会话。
 */
describe('updateEngine 全局默认热重载 (15.0 D4，config reload 入口)', () => {
  it('updateEngine 改变默认 mode——无 per-session mode 的会话跟随新默认', () => {
    const { coord } = makeCoordinator('ask'); // 默认 ask
    // 未设 per-session mode 的会话 'fresh'，初始走默认 ask → moderate requiresReview
    const before = coord.checkAndIssue({ ...baseParams('moderate_tool', 'moderate'), sessionId: 'fresh' });
    expect(before.requiresReview).toBe(true);
    // config reload：默认改为 allow-all
    coord.updateEngine(new PermissionEngine('allow-all'));
    expect(coord.getMode('fresh')).toBe('allow-all'); // 回退新默认
    const after = coord.checkAndIssue({ ...baseParams('moderate_tool', 'moderate'), sessionId: 'fresh' });
    expect(after.allowed).toBe(true); // 现在放行
  });

  it('updateEngine 不覆盖已设的 per-session mode', () => {
    const { coord } = makeCoordinator('ask');
    coord.setSessionMode('s1', 'deny-all');
    coord.updateEngine(new PermissionEngine('allow-all')); // 全局改 allow-all
    // s1 仍保持显式 deny-all，不被全局热重载覆盖
    expect(coord.getMode('s1')).toBe('deny-all');
  });
});

describe('checkAndIssueSimple 危险类别不自动放行 (15.0 R3 F1/F2/F5)', () => {
  it('ask + write_file（危险类别）→ 拒绝（不签 token，需用户/Brain 审核）', () => {
    const { coord } = makeCoordinator('ask');
    const r = coord.checkAndIssueSimple({ agentName: 'code', sessionId: 's', toolName: 'write_file', toolInput: '{}', dangerLevel: 'safe' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('危险工具');
  });

  it('ask + run_command（危险类别）→ 拒绝（blocklist rm -rf 不被绕过）', () => {
    const { coord } = makeCoordinator('ask');
    const r = coord.checkAndIssueSimple({ agentName: 'code', sessionId: 's', toolName: 'run_command', toolInput: 'rm -rf /', dangerLevel: 'moderate' });
    expect(r.allowed).toBe(false);
  });

  it('ask + edit_code（危险类别）→ 拒绝', () => {
    const { coord } = makeCoordinator('ask');
    const r = coord.checkAndIssueSimple({ agentName: 'code', sessionId: 's', toolName: 'edit_code', toolInput: '{}', dangerLevel: 'moderate' });
    expect(r.allowed).toBe(false);
  });

  it('ask + moderate 非类别工具 → 仍签 token（R2-2 delegated trust 保留）', () => {
    const { coord } = makeCoordinator('ask');
    const r = coord.checkAndIssueSimple({ agentName: 'code', sessionId: 's', toolName: 'memory_query', toolInput: '{}', dangerLevel: 'moderate' });
    expect(r.allowed).toBe(true);
    expect(r.tokenId).toBeTruthy();
  });

  it('allow-all + write_file（危险类别）→ 仍拒绝（危险类别在任何模式下都需审核）', () => {
    const { coord } = makeCoordinator('allow-all');
    const r = coord.checkAndIssueSimple({ agentName: 'code', sessionId: 's', toolName: 'write_file', toolInput: '{}', dangerLevel: 'safe' });
    expect(r.allowed).toBe(false);
  });
});

/**
 * 15.0 R4「委派即授权」(active_scope.allowTools) —— D5-1 CRITICAL 修复的安全网。
 *
 * 背景：13.0 起 write_file/edit_code/run_command 被划入危险工具类别，checkPermission 在 mode
 * 判断前早返回 requiresReview。Code Agent 经 permission.request（同步、无 Brain 路由）拿到的就是
 * {allowed:false, requiresReview:true}，tool-caller 判定权限被拒绝 → 写文件静默失败。
 * 15.0 R4 用 active_scope.allowTools 解决：委派时写 allowTools:['*']，evaluateScope 返回 grant，
 * 直接签 token 放行。本组钉死这套语义，防止回归。
 */
describe('active_scope 委派即授权 (15.0 R4，D5-1 修复)', () => {
  it('委派 allowTools:["*"] → edit_code（危险类别）放行 + tokenId', () => {
    const { coord } = makeCoordinator('allow-all', true);
    coord.setActiveScope('t1', { allowTools: ['*'] });
    const r = coord.checkAndIssue({ agentName: 'code', sessionId: 's', toolName: 'edit_code', toolInput: '{}', dangerLevel: 'moderate', taskId: 't1' });
    expect(r.allowed).toBe(true);
    expect(r.tokenId).toBeTruthy();
  });

  it('委派 allowTools:["*"] → write_file / run_command 放行', () => {
    const { coord } = makeCoordinator('allow-all', true);
    coord.setActiveScope('t1', { allowTools: ['*'] });
    const w = coord.checkAndIssue({ agentName: 'code', sessionId: 's', toolName: 'write_file', toolInput: '{}', dangerLevel: 'safe', taskId: 't1' });
    expect(w.allowed).toBe(true);
    const rc = coord.checkAndIssue({ agentName: 'code', sessionId: 's', toolName: 'run_command', toolInput: 'ls -la', dangerLevel: 'moderate', taskId: 't1' });
    expect(rc.allowed).toBe(true);
  });

  it('委派授权 + run_command blocklist（rm -rf）→ fail-closed 不被绕过', () => {
    const { coord } = makeCoordinator('allow-all', true);
    coord.setActiveScope('t1', { allowTools: ['*'] });
    const r = coord.checkAndIssue({ agentName: 'code', sessionId: 's', toolName: 'run_command', toolInput: 'rm -rf /', dangerLevel: 'moderate', taskId: 't1' });
    expect(r.allowed).toBe(false);
    // blocklist 命中原因（即使授权也不放行不可逆危险命令）
    expect(r.reason).toContain('根目录');
  });

  it('block 优先于 allow：委派授权后再 blockTools edit_code → 仍拒绝', () => {
    const { coord } = makeCoordinator('allow-all', true);
    coord.setActiveScope('t1', { allowTools: ['*'], blockTools: ['edit_code'] });
    const blocked = coord.checkAndIssue({ agentName: 'code', sessionId: 's', toolName: 'edit_code', toolInput: '{}', dangerLevel: 'moderate', taskId: 't1' });
    expect(blocked.allowed).toBe(false);
    // write_file 未被 block → 仍放行
    const allowed = coord.checkAndIssue({ agentName: 'code', sessionId: 's', toolName: 'write_file', toolInput: '{}', dangerLevel: 'safe', taskId: 't1' });
    expect(allowed.allowed).toBe(true);
  });

  it('checkAndIssueSimple 同样尊重委派授权（module agent 同步路径）', () => {
    const { coord } = makeCoordinator('ask', true);
    coord.setActiveScope('t1', { allowTools: ['*'] });
    const r = coord.checkAndIssueSimple({ agentName: 'code', sessionId: 's', toolName: 'edit_code', toolInput: '{}', dangerLevel: 'moderate', taskId: 't1' });
    expect(r.allowed).toBe(true);
    expect(r.tokenId).toBeTruthy();
  });

  it('setActiveScope 合并语义：纠偏 blockTools 写入不丢失委派 allowTools', () => {
    const { coord } = makeCoordinator('allow-all', true);
    // 模拟真实流程：委派先写 allowTools，随后 CorrectionFlow 纠偏并入 blockTools
    coord.setActiveScope('t1', { allowTools: ['*'] });
    coord.setActiveScope('t1', { blockTools: ['edit_code'] });
    // write_file 仍应放行（allowTools 未被覆盖丢失）
    const w = coord.checkAndIssue({ agentName: 'code', sessionId: 's', toolName: 'write_file', toolInput: '{}', dangerLevel: 'safe', taskId: 't1' });
    expect(w.allowed).toBe(true);
    // edit_code 被 block 收窄（block 优先）
    const e = coord.checkAndIssue({ agentName: 'code', sessionId: 's', toolName: 'edit_code', toolInput: '{}', dangerLevel: 'moderate', taskId: 't1' });
    expect(e.allowed).toBe(false);
  });

  it('clearActiveScope 后委派授权失效 → 危险类别回到 requiresReview', () => {
    const { coord } = makeCoordinator('allow-all', true);
    // 用 dtask_ 前缀 taskId：createRequest 会过滤掉它（ephemeral taskId 不入库），避免 FK；
    // evaluateScope 仍按原 taskId 读 scope。
    coord.setActiveScope('dtask_x', { allowTools: ['*'] });
    coord.clearActiveScope('dtask_x');
    const r = coord.checkAndIssue({ agentName: 'code', sessionId: 's', toolName: 'edit_code', toolInput: '{}', dangerLevel: 'moderate', taskId: 'dtask_x' });
    expect(r.allowed).toBe(false);
    expect(r.requiresReview).toBe(true);
  });

  it('未注入 StateCache（默认）→ 委派场景退化为 requiresReview（无 scope 可读）', () => {
    // 不带 withCache，stateCache 为 null → evaluateScope 永远返回 null
    const { coord } = makeCoordinator('allow-all');
    const r = coord.checkAndIssue({ agentName: 'code', sessionId: 's', toolName: 'edit_code', toolInput: '{}', dangerLevel: 'moderate', taskId: 'dtask_x' });
    expect(r.allowed).toBe(false);
    expect(r.requiresReview).toBe(true);
  });
});

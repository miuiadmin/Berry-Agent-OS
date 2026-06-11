import { createHash } from 'node:crypto';
import type { PermissionEngine, TokenIssuer, ApprovalManager, RiskLevel } from '../safety/index.js';
import type { PermissionResultPayload } from '../contracts/permissions.js';
import type { DangerLevel } from '../utils/types.js';
import type { StateCache } from './state-cache.js';

/** 13.0 §3.8 第二层: 硬约束 scope（Brain 纠偏时写入，permission 检查时强制） */
export interface ActiveScope {
  /** 禁止访问的路径模式（glob / 精确路径前缀） */
  blockPaths?: string[];
  /** 禁止使用的工具 */
  blockTools?: string[];
}

export interface CheckAndIssueParams {
  agentName: string;
  sessionId: string;
  toolName: string;
  toolInput: string;
  dangerLevel: DangerLevel;
  taskId?: string;
  correlationId?: string;
}

export class PermissionCoordinator {
  private engine: PermissionEngine;
  private tokenIssuer: TokenIssuer;
  private approvalManager: ApprovalManager;
  /** 13.0 §3.8 第二层: StateCache 注入，用于读取 active_scope */
  private stateCache: StateCache | null = null;

  constructor(deps: {
    engine: PermissionEngine;
    tokenIssuer: TokenIssuer;
    approvalManager: ApprovalManager;
    /** 可选：注入 StateCache 以支持硬约束 scope 拦截（§3.8 第二层） */
    stateCache?: StateCache;
  }) {
    this.engine = deps.engine;
    this.tokenIssuer = deps.tokenIssuer;
    this.approvalManager = deps.approvalManager;
    this.stateCache = deps.stateCache ?? null;
  }

  /**
   * 注入 StateCache（延迟注入，兼容 bootstrap 顺序）。
   * 13.0 §3.8 第二层：Brain 纠偏写入 active_scope 后，permission 检查必须强制拦截。
   */
  setStateCache(stateCache: StateCache): void {
    this.stateCache = stateCache;
  }

  /** 引擎热更新（permission mode 切换时调用） */
  updateEngine(engine: PermissionEngine): void {
    this.engine = engine;
  }

  /** 审批管理器热更新（admin 改 approval policy 时调用） */
  updateApprovalManager(approvalManager: ApprovalManager): void {
    this.approvalManager = approvalManager;
  }

  /**
   * 13.0 §3.8 第二层: 检查 active_scope 是否禁止当前 toolName / path。
   *
   * @param taskId - delegation / agent_task ID（active_scope 的 key）
   * @param toolName - 当前要执行的工具名
   * @param toolInput - 工具输入（用于检查 blockPaths）
   * @returns null 表示通过；否则返回拒绝原因
   */
  checkActiveScope(taskId: string | undefined, toolName: string, toolInput: string): string | null {
    if (!this.stateCache || !taskId) return null;
    const scope = this.stateCache.get<ActiveScope>('active_scope', taskId);
    if (!scope) return null;

    // ① blockTools 命中
    if (scope.blockTools && scope.blockTools.length > 0) {
      if (scope.blockTools.includes(toolName)) {
        return `active_scope 禁止工具: ${toolName}`;
      }
    }

    // ② blockPaths 命中（从 toolInput 里抓所有 path 类字符串字段粗略匹配）
    if (scope.blockPaths && scope.blockPaths.length > 0) {
      const inputStr = toolInput ?? '';
      for (const blockPath of scope.blockPaths) {
        if (inputStr.includes(blockPath)) {
          return `active_scope 禁止访问路径: ${blockPath}`;
        }
      }
    }

    return null;
  }

  /**
   * 写入 active_scope（由 CorrectionFlow 调用）。
   * 13.0 §3.8 第二层：Brain 纠偏的 scopeUpdate 强制生效。
   *
   * @param taskId - delegation ID（与 checkActiveScope 的 key 对应）
   * @param scope - 硬约束 scope
   */
  setActiveScope(taskId: string, scope: ActiveScope): void {
    if (!this.stateCache) return;
    this.stateCache.set('active_scope', taskId, scope);
  }

  /**
   * 清除 task 的 active_scope（task 结束 / 重置时调用）。
   */
  clearActiveScope(taskId: string): void {
    if (!this.stateCache) return;
    this.stateCache.delete('active_scope', taskId);
  }

  checkAndIssue(params: CheckAndIssueParams): PermissionResultPayload {
    // 13.0 §3.8 第二层: 先做 active_scope 硬拦截（在 engine.checkPermission 之前，fail-closed）
    const scopeBlock = this.checkActiveScope(params.taskId, params.toolName, params.toolInput);
    if (scopeBlock) {
      return { allowed: false, reason: scopeBlock };
    }

    const blockResult = this.engine.checkPermission(
      params.toolName,
      params.toolInput,
      params.dangerLevel,
    );
    if (!blockResult.allowed && !blockResult.requiresReview) {
      return { allowed: false, reason: blockResult.reason };
    }
    if (blockResult.requiresReview) {
      return { allowed: false, requiresReview: true, reason: blockResult.reason };
    }

    const inputHash = createHash('sha256').update(params.toolInput).digest('hex').slice(0, 16);
    const riskMap: Record<string, RiskLevel> = { safe: 'low', moderate: 'medium', dangerous: 'high' };
    const riskLevel = riskMap[params.dangerLevel] ?? 'medium';

    const request = this.approvalManager.createRequest({
      sessionId: params.sessionId,
      // ephemeral taskId（dtask_xxx）是 dialogue 模式下的临时 ID，不存在于 agent_tasks 表，
      // 传入会触发 FK 约束失败，因此过滤掉
      taskId: params.taskId?.startsWith('dtask_') ? undefined : params.taskId,
      correlationId: params.correlationId ?? params.sessionId,
      kind: 'tool',
      requester: params.agentName,
      riskLevel,
      requestPayload: { toolName: params.toolName, toolInput: params.toolInput, dangerLevel: params.dangerLevel },
      bindingPayload: { agentName: params.agentName, toolName: params.toolName, inputHash },
    });

    const token = this.approvalManager.autoDecide(request);

    if (token) {
      return { allowed: true, tokenId: token.id };
    }
    // autoDecide returned null → needs Brain judge or user confirmation
    return { allowed: false, requiresReview: true, reason: '需要 Brain 审批', requestId: request.id };
  }

  /**
   * 简化版权限检查（模块 Agent 用）。
   *
   * 13.0 修复：与 checkAndIssue() 对齐，增加 active_scope 硬拦截。
   * 之前 checkAndIssueSimple() 跳过了 checkActiveScope()，导致 Brain 纠偏
   * 设置的 forbiddenTools 对模块 Agent 的工具调用没有硬强制。
   *
   * @param params.agentName Agent 名称
   * @param params.sessionId 会话 ID
   * @param params.toolName 工具名称
   * @param params.toolInput 工具输入
   * @param params.dangerLevel 危险等级
   * @param params.taskId 可选任务 ID（用于 active_scope 检查，§3.8 第二层）
   */
  checkAndIssueSimple(params: { agentName: string; sessionId: string; toolName: string; toolInput: string; dangerLevel: DangerLevel; taskId?: string }): PermissionResultPayload {
    // 13.0 §3.8 第二层: active_scope 硬拦截（与 checkAndIssue 对齐，fail-closed）
    const scopeBlock = this.checkActiveScope(params.taskId, params.toolName, params.toolInput);
    if (scopeBlock) {
      return { allowed: false, reason: scopeBlock };
    }

    const blockResult = this.engine.checkPermission(
      params.toolName,
      params.toolInput,
      params.dangerLevel,
    );
    if (!blockResult.allowed) {
      return { allowed: false, reason: blockResult.reason };
    }

    const inputHash = createHash('sha256').update(params.toolInput).digest('hex').slice(0, 16);
    const token = this.tokenIssuer.issue({ sessionId: params.sessionId, agentName: params.agentName, toolName: params.toolName, inputHash });
    return { allowed: true, tokenId: token.id };
  }

  validate(params: { tokenId: string; sessionId: string; agentName: string; toolName: string; toolInput: string }): PermissionResultPayload {
    const inputHash = createHash('sha256').update(params.toolInput).digest('hex').slice(0, 16);
    const result = this.tokenIssuer.validate(params.tokenId, {
      sessionId: params.sessionId,
      agentName: params.agentName,
      toolName: params.toolName,
      inputHash,
    });
    return result.valid
      ? { allowed: true }
      : { allowed: false, reason: result.reason };
  }

  acquire(params: CheckAndIssueParams): PermissionResultPayload {
    const issued = this.checkAndIssue(params);
    if (!issued.allowed && !issued.requiresReview) return issued;
    if (issued.requiresReview) return issued;
    if (!issued.tokenId) return issued;

    const inputHash = createHash('sha256').update(params.toolInput).digest('hex').slice(0, 16);
    const validation = this.tokenIssuer.validate(issued.tokenId, {
      sessionId: params.sessionId,
      agentName: params.agentName,
      toolName: params.toolName,
      inputHash,
    });
    if (!validation.valid) {
      return { allowed: false, reason: validation.reason };
    }

    return { allowed: true, tokenId: issued.tokenId };
  }

  consume(tokenId: string): PermissionResultPayload {
    const consumed = this.tokenIssuer.consume(tokenId);
    return consumed
      ? { allowed: true }
      : { allowed: false, reason: 'permission token 消费失败' };
  }

  getPending(sessionId?: string) {
    return this.approvalManager.getPending(sessionId);
  }

  resolve(requestId: string, decision: Parameters<ApprovalManager['resolve']>[1]) {
    return this.approvalManager.resolve(requestId, decision);
  }

  cancel(requestId: string) {
    return this.approvalManager.cancel(requestId);
  }
}

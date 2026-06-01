import { createHash } from 'node:crypto';
import type { PermissionEngine, TokenIssuer, ApprovalManager, RiskLevel } from '../safety/index.js';
import type { PermissionResultPayload } from '../contracts/permissions.js';
import type { DangerLevel } from '../utils/types.js';

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

  constructor(deps: {
    engine: PermissionEngine;
    tokenIssuer: TokenIssuer;
    approvalManager: ApprovalManager;
  }) {
    this.engine = deps.engine;
    this.tokenIssuer = deps.tokenIssuer;
    this.approvalManager = deps.approvalManager;
  }

  updateEngine(engine: PermissionEngine): void {
    this.engine = engine;
  }

  updateApprovalManager(approvalManager: ApprovalManager): void {
    this.approvalManager = approvalManager;
  }

  checkAndIssue(params: CheckAndIssueParams): PermissionResultPayload {
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
      taskId: params.taskId,
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

  checkAndIssueSimple(params: { agentName: string; sessionId: string; toolName: string; toolInput: string; dangerLevel: DangerLevel }): PermissionResultPayload {
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

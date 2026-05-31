import type { AgentManager } from '../agent-manager.js';
import type { AgentRegistry } from '../agent-registry.js';
import type { DelegationManager } from '../delegation-manager.js';
import type { AgentHierarchy } from '../../workspaces/agent-hierarchy.js';
import type { TrustManager } from '../../workspaces/trust-manager.js';
import type { IpcMessage, IpcMessageType } from '../types.js';
import type { SuperiorReviewRequest, SuperiorReviewResult } from '../../contracts/superior-review.js';
import type { TurnRecord } from '../../contracts/review.js';
import { genId } from '../../utils/id.js';
import { getLogger } from '../../utils/logger.js';
import { BrainDecisionRecorder } from '../brain-decision-recorder.js';
import { getToolByName } from '../../tools/index.js';
import type Database from 'better-sqlite3';

const logger = getLogger('superior-review-flow');

const REVIEW_TIMEOUT_MS = 15_000;
const MAX_CHAIN_DEPTH = 10;

interface AgentIpc {
  onMessage: (type: IpcMessageType, handler: (msg: IpcMessage) => void) => void;
  send: (type: IpcMessageType, to: string, payload: unknown, correlationId?: string) => boolean;
}

export interface SuperiorReviewFlowDeps {
  readonly db: Database.Database;
  readonly agentManager: AgentManager;
  readonly registry: AgentRegistry;
  readonly delegationManager: DelegationManager;
  readonly agentHierarchy: AgentHierarchy;
  readonly trustManager: TrustManager;
}

interface PendingReview {
  delegationId: string;
  originalCorrelationId: string;
  currentSuperiorId: string;
  currentSuperiorName: string;
  workspaceId: string;
  turn: TurnRecord;
  chainDepth: number;
  timeoutId: ReturnType<typeof setTimeout>;
  modifiedResponse?: string;
}

export class SuperiorReviewFlow {
  private pendingReviews = new Map<string, PendingReview>();
  private onChainCompleted: ((correlationId: string, modifiedResponse?: string) => void) | null = null;
  private onChainRejected: ((correlationId: string, reason: string) => void) | null = null;

  constructor(private readonly ctx: SuperiorReviewFlowDeps) {}

  setup(reviewerIpc: AgentIpc): void {
    reviewerIpc.onMessage('superior.review.result', (msg: IpcMessage) => {
      this.handleReviewResult(msg);
    });
  }

  setCallbacks(callbacks: {
    onCompleted: (correlationId: string, modifiedResponse?: string) => void;
    onRejected: (correlationId: string, reason: string) => void;
  }): void {
    this.onChainCompleted = callbacks.onCompleted;
    this.onChainRejected = callbacks.onRejected;
  }

  interceptForSuperiorReview(
    correlationId: string,
    targetAgentName: string,
    workspaceId: string | undefined,
    turn: TurnRecord,
    delegationId?: string,
  ): boolean {
    if (!workspaceId) return false;

    const binding = this.ctx.db.prepare(`
      SELECT id, superior_id FROM workspace_agents
      WHERE workspace_id = ? AND agent_name = ? AND enabled = 1 LIMIT 1
    `).get(workspaceId, targetAgentName) as { id: string; superior_id: string | null } | undefined;

    if (!binding || !binding.superior_id) return false;

    const toolCallInfo = turn.toolCalls.map(tc => ({
      name: tc.name,
      dangerLevel: this.lookupToolDanger(tc.name),
    }));

    const autoApprove = this.ctx.trustManager.shouldAutoApprove(
      binding.id,
      turn.draftResponse,
      toolCallInfo,
    );

    if (autoApprove.autoApprove) {
      logger.debug({ agentName: targetAgentName, reason: autoApprove.reason }, 'Auto-approved, skipping superior review');
      this.ctx.trustManager.recordApproval(binding.id);
      return false;
    }

    const superior = this.ctx.agentHierarchy.getSuperior(binding.id);
    if (!superior) return false;

    this.sendToSuperior({
      correlationId,
      delegationId: delegationId ?? correlationId,
      workspaceId,
      turn,
      superiorId: superior.agentId,
      superiorName: superior.agentName,
      agentId: binding.id,
      agentName: targetAgentName,
      chainDepth: 0,
    });

    return true;
  }

  private sendToSuperior(params: {
    correlationId: string;
    delegationId: string;
    workspaceId: string;
    turn: TurnRecord;
    superiorId: string;
    superiorName: string;
    agentId: string;
    agentName: string;
    chainDepth: number;
    modifiedResponse?: string;
  }): void {
    if (params.chainDepth >= MAX_CHAIN_DEPTH) {
      logger.warn({ correlationId: params.correlationId }, 'Max review chain depth reached, completing');
      this.onChainCompleted?.(params.correlationId, params.modifiedResponse);
      return;
    }

    const reviewCorrelationId = genId('sr');
    const trustLevel = this.ctx.trustManager.getTrustLevel(params.agentId);

    const request: SuperiorReviewRequest = {
      delegationId: params.delegationId,
      correlationId: reviewCorrelationId,
      agentId: params.agentId,
      agentName: params.agentName,
      superiorId: params.superiorId,
      superiorName: params.superiorName,
      workspaceId: params.workspaceId,
      userMessage: params.turn.userMessage,
      draftResponse: params.modifiedResponse ?? params.turn.draftResponse,
      toolCalls: params.turn.toolCalls,
      trustLevel,
      chainDepth: params.chainDepth,
    };

    const timeoutId = setTimeout(() => {
      this.pendingReviews.delete(reviewCorrelationId);
      logger.warn({ correlationId: params.correlationId, superiorName: params.superiorName }, 'Superior review timed out, falling through to Brain');
      this.onChainCompleted?.(params.correlationId, params.modifiedResponse);
    }, REVIEW_TIMEOUT_MS);

    this.pendingReviews.set(reviewCorrelationId, {
      delegationId: params.delegationId,
      originalCorrelationId: params.correlationId,
      currentSuperiorId: params.superiorId,
      currentSuperiorName: params.superiorName,
      workspaceId: params.workspaceId,
      turn: params.turn,
      chainDepth: params.chainDepth,
      timeoutId,
      modifiedResponse: params.modifiedResponse,
    });

    const reviewerAgent = this.ctx.registry.requireRole('reviewer');
    const brain = this.ctx.agentManager.getAgent(reviewerAgent.manifest.name);
    if (!brain) {
      clearTimeout(timeoutId);
      this.pendingReviews.delete(reviewCorrelationId);
      logger.warn('Brain not available for superior review, completing chain');
      this.onChainCompleted?.(params.correlationId, params.modifiedResponse);
      return;
    }

    brain.ipc.send('superior.review.request', reviewerAgent.manifest.name, request, reviewCorrelationId);
    logger.info({ superiorName: params.superiorName, agentName: params.agentName, chainDepth: params.chainDepth }, 'Superior review request sent');
  }

  private handleReviewResult(msg: IpcMessage): void {
    const result = msg.payload as SuperiorReviewResult;
    const reviewCorrelationId = msg.correlationId;
    if (!reviewCorrelationId) return;

    const pending = this.pendingReviews.get(reviewCorrelationId);
    if (!pending) {
      logger.debug({ reviewCorrelationId }, 'Review result for unknown/expired review');
      return;
    }

    // Record superior review decision for evolution
    const recorder = new BrainDecisionRecorder(this.ctx.db);
    recorder.recordReviewDecision(
      pending.workspaceId,
      `superior-review:${pending.currentSuperiorName} depth:${pending.chainDepth}`,
      result as any,
    );

    clearTimeout(pending.timeoutId);
    this.pendingReviews.delete(reviewCorrelationId);

    const agentBinding = this.ctx.db.prepare(
      'SELECT id FROM workspace_agents WHERE workspace_id = ? AND agent_name = ? AND enabled = 1 LIMIT 1',
    ).get(pending.workspaceId, pending.turn.userMessage ? undefined : undefined) as { id: string } | undefined;

    const agentId = this.findAgentIdByDelegation(pending);

    switch (result.verdict) {
      case 'approve': {
        if (agentId) this.ctx.trustManager.recordApproval(agentId);
        this.escalateOrComplete(pending, result.modifiedResponse);
        break;
      }
      case 'modify': {
        if (agentId) this.ctx.trustManager.recordApproval(agentId);
        this.escalateOrComplete(pending, result.modifiedResponse ?? pending.modifiedResponse);
        break;
      }
      case 'reject': {
        if (agentId) this.ctx.trustManager.recordRejection(agentId);
        logger.info({ superiorName: pending.currentSuperiorName, reason: result.reason }, 'Superior rejected output');
        this.onChainRejected?.(pending.originalCorrelationId, result.reason ?? 'Superior rejected');
        break;
      }
    }
  }

  private escalateOrComplete(pending: PendingReview, modifiedResponse?: string): void {
    const nextSuperior = this.ctx.agentHierarchy.getSuperior(pending.currentSuperiorId);

    if (!nextSuperior) {
      logger.debug({ correlationId: pending.originalCorrelationId }, 'Review chain complete (top-level reached)');
      this.onChainCompleted?.(pending.originalCorrelationId, modifiedResponse);
      return;
    }

    const toolCallInfo = pending.turn.toolCalls.map(tc => ({
      name: tc.name,
      dangerLevel: this.lookupToolDanger(tc.name),
    }));
    const autoApprove = this.ctx.trustManager.shouldAutoApprove(
      pending.currentSuperiorId,
      modifiedResponse ?? pending.turn.draftResponse,
      toolCallInfo,
    );

    if (autoApprove.autoApprove) {
      this.ctx.trustManager.recordApproval(pending.currentSuperiorId);
      this.onChainCompleted?.(pending.originalCorrelationId, modifiedResponse);
      return;
    }

    this.sendToSuperior({
      correlationId: pending.originalCorrelationId,
      delegationId: pending.delegationId,
      workspaceId: pending.workspaceId,
      turn: pending.turn,
      superiorId: nextSuperior.agentId,
      superiorName: nextSuperior.agentName,
      agentId: pending.currentSuperiorId,
      agentName: pending.currentSuperiorName,
      chainDepth: pending.chainDepth + 1,
      modifiedResponse,
    });
  }

  private findAgentIdByDelegation(pending: PendingReview): string | null {
    const entry = this.ctx.delegationManager.get(pending.delegationId);
    if (!entry) return null;

    const row = this.ctx.db.prepare(
      'SELECT id FROM workspace_agents WHERE workspace_id = ? AND agent_name = ? AND enabled = 1 LIMIT 1',
    ).get(pending.workspaceId, entry.targetAgent) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private lookupToolDanger(toolName: string): 'safe' | 'moderate' | 'dangerous' {
    const toolDef = getToolByName(toolName);
    return toolDef?.dangerLevel ?? 'safe';
  }

  cancelPending(correlationId: string): void {
    for (const [key, pending] of this.pendingReviews) {
      if (pending.originalCorrelationId === correlationId) {
        clearTimeout(pending.timeoutId);
        this.pendingReviews.delete(key);
      }
    }
  }
}

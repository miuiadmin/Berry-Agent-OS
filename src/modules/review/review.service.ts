import { genId } from '../../utils/id.js';
import type { AppEvents } from '../../lib/event-bus.js';
import type { ExecutionService } from '../execution/execution.service.js';
import type { AgentService } from '../agent/agent.service.js';
import type { ReviewAction, ReviewDecision } from '../../db/schema/executions.js';
export type { ReviewAction, ReviewDecision };

export class ReviewService {
  constructor(
    private executionService: ExecutionService,
    private agentService: AgentService,
    private events: AppEvents,
  ) {}

  requestReview(executionId: string, reviewerId: string): void {
    this.executionService.updatePhase(executionId, 'reviewing');
    const execution = this.executionService.getById(executionId);
    if (!execution) return;

    this.executionService.updateExecution(executionId, { reviewedBy: reviewerId, reviewStatus: 'pending' });

    this.events.emit('review.requested', { executionId, reviewerId });
  }

  submitDecision(executionId: string, decision: ReviewDecision): void {
    const execution = this.executionService.getById(executionId);
    if (!execution) return;

    const update = (data: Parameters<typeof this.executionService.updateExecution>[1]) =>
      this.executionService.updateExecution(executionId, data);

    switch (decision.action) {
      case 'approve':
        update({
          reviewStatus: 'approved',
          reviewNote: decision.note ?? null,
          reviewActionData: decision,
        });
        this.agentService.recordApproval(execution.agentId);
        break;

      case 'modify':
        update({
          reviewStatus: 'modified',
          output: decision.modifiedContent ?? execution.output,
          reviewNote: decision.note ?? null,
          reviewActionData: decision,
        });
        this.agentService.recordApproval(execution.agentId);
        break;

      case 'reject':
        update({
          reviewStatus: 'rejected',
          reviewNote: decision.note ?? null,
          reviewGuidance: { guidance: decision.guidance, suggestions: decision.suggestions },
          reviewActionData: decision,
          redoCount: (execution.redoCount ?? 0) + 1,
        });
        this.agentService.recordRejection(execution.agentId);
        break;

      case 'reassign':
        update({
          reviewStatus: 'reassigned',
          reviewNote: decision.note ?? null,
          reviewActionData: decision,
        });
        break;

      case 'supplement':
        update({
          reviewStatus: 'supplemented',
          reviewNote: decision.note ?? null,
          reviewActionData: decision,
        });
        break;

      case 'suspend':
        update({
          reviewStatus: 'suspended',
          reviewNote: decision.note ?? null,
          reviewActionData: decision,
        });
        break;

      case 'change_and_route':
        update({
          reviewStatus: 'approved',
          reviewNote: decision.note ?? null,
          reviewActionData: decision,
        });
        break;
    }

    this.events.emit('review.decided', {
      executionId,
      action: decision.action,
      reviewerId: execution.reviewedBy!,
    });
  }

  shouldAutoApprove(agentId: string, executionId: string): boolean {
    const agent = this.agentService.getById(agentId);
    if (!agent) return false;

    if (agent.trustLevel === 'autonomous') return true;
    if (agent.trustLevel !== 'trusted') return false;

    const execution = this.executionService.getById(executionId);
    if (!execution) return false;

    const isLowRisk = (execution.toolCalls ?? 0) === 0 &&
      (execution.output?.length ?? 0) < 2000;
    return isLowRisk;
  }

  getReviewChain(agentId: string): string[] {
    const chain: string[] = [];
    let current = this.agentService.getById(agentId);
    while (current?.superiorId) {
      chain.push(current.superiorId);
      current = this.agentService.getById(current.superiorId);
    }
    return chain;
  }
}

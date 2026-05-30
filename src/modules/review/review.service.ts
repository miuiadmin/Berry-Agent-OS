import { genId } from '../../utils/id.js';
import type { AppEvents } from '../../lib/event-bus.js';
import type { ExecutionService } from '../execution/execution.service.js';
import type { AgentService } from '../agent/agent.service.js';

export type ReviewAction = 'approve' | 'modify' | 'reject' | 'reassign' | 'supplement' | 'suspend' | 'change_and_route';

export interface ReviewDecision {
  action: ReviewAction;
  note?: string;
  modifiedContent?: string;
  guidance?: string;
  suggestions?: string[];
  reassignToAgentId?: string;
  supplementInfo?: string;
  taskChanges?: {
    priority?: string;
    dueDate?: number;
    columnId?: string;
    labelsAdd?: string[];
    labelsRemove?: string[];
    descriptionAppend?: string;
  };
  nextAction?: 'reject' | 'reassign' | 'suspend';
}

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

    const repo = (this.executionService as any).repo;
    repo.update(executionId, { reviewedBy: reviewerId, reviewStatus: 'pending' });

    this.events.emit('review.requested', { executionId, reviewerId });
  }

  submitDecision(executionId: string, decision: ReviewDecision): void {
    const execution = this.executionService.getById(executionId);
    if (!execution) return;

    const repo = (this.executionService as any).repo;

    switch (decision.action) {
      case 'approve':
        repo.update(executionId, {
          reviewStatus: 'approved',
          reviewNote: decision.note ?? null,
          reviewActionData: decision as any,
        });
        this.agentService.recordApproval(execution.agentId);
        break;

      case 'modify':
        repo.update(executionId, {
          reviewStatus: 'modified',
          output: decision.modifiedContent ?? execution.output,
          reviewNote: decision.note ?? null,
          reviewActionData: decision as any,
        });
        this.agentService.recordApproval(execution.agentId);
        break;

      case 'reject':
        repo.update(executionId, {
          reviewStatus: 'rejected',
          reviewNote: decision.note ?? null,
          reviewGuidance: { guidance: decision.guidance, suggestions: decision.suggestions } as any,
          reviewActionData: decision as any,
          redoCount: (execution.redoCount ?? 0) + 1,
        });
        this.agentService.recordRejection(execution.agentId);
        break;

      case 'reassign':
        repo.update(executionId, {
          reviewStatus: 'reassigned',
          reviewNote: decision.note ?? null,
          reviewActionData: decision as any,
        });
        break;

      case 'supplement':
        repo.update(executionId, {
          reviewStatus: 'supplemented',
          reviewNote: decision.note ?? null,
          reviewActionData: decision as any,
        });
        break;

      case 'suspend':
        repo.update(executionId, {
          reviewStatus: 'suspended',
          reviewNote: decision.note ?? null,
          reviewActionData: decision as any,
        });
        break;

      case 'change_and_route':
        repo.update(executionId, {
          reviewStatus: 'approved',
          reviewNote: decision.note ?? null,
          reviewActionData: decision as any,
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

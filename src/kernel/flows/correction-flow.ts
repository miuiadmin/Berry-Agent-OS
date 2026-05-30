import type { CorrectionFlowDeps } from '../delegation-orchestrator.js';
import { getEventBus } from '../event-bus.js';
import { genId } from '../../utils/id.js';
import { getLogger } from '../../utils/logger.js';
import type { IpcMessage, IpcMessageType } from '../types.js';
import type {
  TurnCheckpointPayload,
  TurnCorrectionPayload,
  CheckpointTrigger,
} from '../../contracts/delegation.js';
import { isDelegationTerminal, CORRECTION_LIMITS } from '../../contracts/delegation.js';
import type { RouteRequestPayload } from '../../contracts/routing.js';
import { buildAvailableAgentsList } from '../agent-registry.js';

const logger = getLogger('correction-flow');

const CORRECTION_TIMEOUT_MS = 15_000;

interface AgentIpc {
  onMessage: (type: IpcMessageType, handler: (msg: IpcMessage) => void) => void;
  send: (type: IpcMessageType, to: string, payload: unknown, correlationId?: string) => boolean;
}

export class CorrectionFlow {
  private pendingCheckpoints = new Map<string, { correlationId: string; timeoutId: ReturnType<typeof setTimeout> }>();
  private ctx: CorrectionFlowDeps;

  constructor(ctx: CorrectionFlowDeps) {
    this.ctx = ctx;
  }

  setup(reviewerIpc: AgentIpc): void {
    getEventBus().on('delegation.checkpoint_needed', (payload) => {
      this.handleCheckpointNeeded(payload.delegationId, payload.trigger as CheckpointTrigger);
    });

    reviewerIpc.onMessage('checkpoint.evaluate.result', (msg: IpcMessage) => {
      this.handleCorrectionResult(msg);
    });

    getEventBus().on('delegation.completed', ({ delegationId }) => {
      this.cancelPending(delegationId);
    });
    getEventBus().on('delegation.failed', ({ delegationId }) => {
      this.cancelPending(delegationId);
    });
  }

  private handleCheckpointNeeded(delegationId: string, trigger: CheckpointTrigger): void {
    const entry = this.ctx.delegationManager.get(delegationId);
    if (!entry || isDelegationTerminal(entry.state)) return;

    if (this.pendingCheckpoints.has(delegationId)) {
      logger.debug({ delegationId }, 'Checkpoint already pending, skipping');
      return;
    }

    const orchestrator = this.ctx.registry.requireRole('orchestrator');
    const brain = this.ctx.agentManager.getAgent(orchestrator.manifest.name);
    if (!brain) {
      logger.warn({ delegationId }, 'Brain not available for checkpoint evaluation');
      return;
    }

    const context = this.ctx.delegationManager.buildCorrectionContext(delegationId);
    if (!context) return;

    const correlationId = genId('chkpt');
    const payload: TurnCheckpointPayload = {
      delegationId,
      trigger,
      context,
    };

    const timeoutId = setTimeout(() => {
      this.pendingCheckpoints.delete(delegationId);
      logger.debug({ delegationId }, 'Checkpoint evaluation timed out, continuing');
    }, CORRECTION_TIMEOUT_MS);

    this.pendingCheckpoints.set(delegationId, { correlationId, timeoutId });

    brain.ipc.send('checkpoint.evaluate', orchestrator.manifest.name, payload, correlationId);
    logger.info({ delegationId, trigger, correlationId }, 'Checkpoint sent to Brain for evaluation');
  }

  private handleCorrectionResult(msg: IpcMessage): void {
    const correction = msg.payload as TurnCorrectionPayload;
    const correlationId = msg.correlationId;
    if (!correlationId) return;

    const pending = this.findPendingByCorrelation(correlationId);
    if (!pending) {
      logger.debug({ correlationId }, 'Correction result for unknown/expired checkpoint');
      return;
    }

    const { delegationId, timeoutId } = pending;
    clearTimeout(timeoutId);
    this.pendingCheckpoints.delete(delegationId);

    const entry = this.ctx.delegationManager.get(delegationId);
    if (!entry || isDelegationTerminal(entry.state)) {
      logger.debug({ delegationId, action: correction.action }, 'Delegation already terminal, discarding correction');
      return;
    }

    logger.info({ delegationId, action: correction.action }, 'Applying correction');
    this.applyCorrection(delegationId, correction);
  }

  private applyCorrection(delegationId: string, correction: TurnCorrectionPayload): void {
    switch (correction.action) {
      case 'continue':
        break;

      case 'adjust':
        this.applyAdjust(delegationId, correction);
        break;

      case 'stop':
        this.applyStop(delegationId, correction);
        break;

      case 'restart':
        this.applyRestart(delegationId, correction);
        break;
    }
  }

  private applyAdjust(delegationId: string, correction: TurnCorrectionPayload): void {
    if (correction.newConstraints) {
      this.ctx.delegationManager.applyConstraints(delegationId, correction.newConstraints);
    }

    const entry = this.ctx.delegationManager.get(delegationId);
    if (!entry) return;

    if (entry.targetKind === 'daemon') {
      if (this.ctx.daemonBridge?.isAvailable) {
        this.ctx.daemonBridge.deliverCorrection(
          delegationId,
          'adjust',
          correction.instruction,
          correction.newConstraints,
        );
        logger.debug({ delegationId }, 'Correction sent to daemon');
      }
      return;
    }

    const agent = this.ctx.agentManager.getAgent(entry.targetAgent);
    if (agent) {
      agent.ipc.send('turn.correction', entry.targetAgent, correction, genId('corr'));
      logger.debug({ delegationId, targetAgent: entry.targetAgent }, 'Correction sent to agent');
    }
  }

  private applyStop(delegationId: string, correction: TurnCorrectionPayload): void {
    const entry = this.ctx.delegationManager.get(delegationId);
    if (!entry) return;

    if (entry.targetKind === 'daemon' && this.ctx.daemonBridge?.isAvailable) {
      this.ctx.daemonBridge.deliverCorrection(delegationId, 'stop', correction.instruction);
    }

    const partialResponse = correction.instruction
      ?? entry.finalResponse
      ?? this.buildPartialResponse(entry);

    this.ctx.delegationManager.submitForReview(delegationId, {
      delegationId,
      response: partialResponse,
    });
  }

  private applyRestart(delegationId: string, correction: TurnCorrectionPayload): void {
    const entry = this.ctx.delegationManager.get(delegationId);
    if (!entry) return;

    if (entry.reRouteDepth >= entry.budget.maxReRouteDepth) {
      logger.warn({ delegationId, depth: entry.reRouteDepth }, 'Max re-route depth reached, stopping instead');
      this.applyStop(delegationId, correction);
      return;
    }

    this.ctx.delegationManager.fail(delegationId, 'Brain correction: restart');

    const pending = this.ctx.sessionManager.getPending(entry.correlationId);
    if (pending) {
      const availableAgents = buildAvailableAgentsList(this.ctx.registry);
      const routePayload: RouteRequestPayload = {
        sessionId: entry.sessionId,
        message: entry.userMessage,
        taskId: pending.taskId ?? delegationId,
        availableAgents,
        sessionContext: undefined,
      };
      this.ctx.sendRouteRequest(routePayload, entry.correlationId);
      logger.info({ delegationId, correlationId: entry.correlationId }, 'Re-routing after restart correction');
    }
  }

  private buildPartialResponse(entry: { outputs: Array<{ kind: string; data: unknown }> }): string {
    const textParts: string[] = [];
    for (const out of entry.outputs) {
      if (out.kind === 'text_delta') {
        const d = out.data as { text?: string };
        if (d.text) textParts.push(d.text);
      }
    }
    return textParts.join('') || '[任务已被纠偏系统终止]';
  }

  private cancelPending(delegationId: string): void {
    const pending = this.pendingCheckpoints.get(delegationId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingCheckpoints.delete(delegationId);
    }
  }

  private findPendingByCorrelation(correlationId: string): { delegationId: string; timeoutId: ReturnType<typeof setTimeout> } | undefined {
    for (const [delegationId, pending] of this.pendingCheckpoints) {
      if (pending.correlationId === correlationId) {
        return { delegationId, timeoutId: pending.timeoutId };
      }
    }
    return undefined;
  }
}

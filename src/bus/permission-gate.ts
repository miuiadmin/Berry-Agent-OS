import type {
  IPermissionGate,
  PermissionGateDecision,
  CapabilityDescriptor,
  InvokeContext,
} from './contract.js';

export interface BrainJudgeAdapter {
  requestJudge(input: {
    sessionId: string;
    agentName: string;
    capabilityName: string;
    dangerLevel: string;
    input: unknown;
    callChain: string[];
    taskContext?: string;
  }): Promise<{ allowed: boolean; reason: string }>;
}

export class PermissionGate implements IPermissionGate {
  private brainJudge: BrainJudgeAdapter | null = null;

  setBrainJudge(judge: BrainJudgeAdapter): void {
    this.brainJudge = judge;
  }

  async check(
    capability: CapabilityDescriptor,
    input: unknown,
    ctx: InvokeContext,
  ): Promise<PermissionGateDecision> {
    if (capability.dangerLevel === 'safe') {
      return { allowed: true, reason: 'safe capability', source: 'auto' };
    }

    if (!this.brainJudge) {
      if (capability.dangerLevel === 'moderate') {
        return { allowed: true, reason: 'no brain judge configured, moderate auto-approved', source: 'auto' };
      }
      return { allowed: false, reason: 'dangerous capability requires Brain judge but none configured', source: 'auto' };
    }

    const judgment = await this.brainJudge.requestJudge({
      sessionId: ctx.sessionId,
      agentName: ctx.callerAgent ?? 'unknown',
      capabilityName: capability.name,
      dangerLevel: capability.dangerLevel,
      input,
      callChain: ctx.callChain,
    });

    return {
      allowed: judgment.allowed,
      reason: judgment.reason,
      source: 'brain',
    };
  }
}

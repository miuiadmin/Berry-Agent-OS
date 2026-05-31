import type {
  IPermissionGate,
  PermissionGateDecision,
  CapabilityDescriptor,
  InvokeContext,
} from './contract.js';
import { ScopeChecker, type PermissionScope } from './permission-scope.js';
import type { DangerLevel } from '../utils/types.js';

export interface BrainJudgeAdapter {
  requestJudge(input: {
    sessionId: string;
    agentName: string;
    capabilityName: string;
    dangerLevel: DangerLevel;
    input: unknown;
    callChain: string[];
    taskContext?: string;
  }): Promise<{ allowed: boolean; reason: string }>;
}

export class PermissionGate implements IPermissionGate {
  private brainJudge: BrainJudgeAdapter | null = null;
  private activeScopeCheckers = new Map<string, ScopeChecker>();

  setBrainJudge(judge: BrainJudgeAdapter): void {
    this.brainJudge = judge;
  }

  setScope(sessionId: string, scope: PermissionScope): void {
    this.activeScopeCheckers.set(sessionId, new ScopeChecker(scope));
  }

  clearScope(sessionId: string): void {
    this.activeScopeCheckers.delete(sessionId);
  }

  async check(
    capability: CapabilityDescriptor,
    input: unknown,
    ctx: InvokeContext,
  ): Promise<PermissionGateDecision> {
    if (capability.dangerLevel === 'safe') {
      return { allowed: true, reason: 'safe capability', source: 'auto' };
    }

    // Check PermissionScope first — in-scope operations pass without Brain judge
    const scopeChecker = this.activeScopeCheckers.get(ctx.sessionId);
    if (scopeChecker) {
      const scopeResult = scopeChecker.check(capability.name, capability.dangerLevel, input);
      if (scopeResult.inScope) {
        return { allowed: true, reason: `in scope: ${capability.name}`, source: 'auto' };
      }
    }

    if (!this.brainJudge) {
      if (capability.dangerLevel === 'moderate') {
        return { allowed: true, reason: 'no brain judge configured, moderate auto-approved', source: 'auto' };
      }
      return { allowed: false, reason: 'dangerous capability requires Brain judge but none configured', source: 'auto' };
    }

    try {
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
    } catch (err) {
      return {
        allowed: false,
        reason: `Brain judge unavailable: ${err instanceof Error ? err.message : String(err)}`,
        source: 'auto',
      };
    }
  }
}

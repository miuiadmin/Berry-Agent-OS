import type {
  IPermissionGate,
  PermissionGateDecision,
  CapabilityDescriptor,
  InvokeContext,
} from './contract.js';
import { ScopeChecker, type PermissionScope } from './permission-scope.js';
import type { DangerLevel } from '../utils/types.js';
import type { PermissionMode } from '../safety/permissions.js';

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
  /** 15.0 机制 A §2.5：读取当前权限模式，让 capability 路径与 IPC 路径一致尊重 mode */
  private getMode: (() => PermissionMode) | null = null;
  private activeScopeCheckers = new Map<string, ScopeChecker>();

  setBrainJudge(judge: BrainJudgeAdapter): void {
    this.brainJudge = judge;
  }

  /** 注入权限模式读取器（返回当前 ask/allow-all/deny-all/yolo） */
  setMode(getMode: () => PermissionMode): void {
    this.getMode = getMode;
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

    // 15.0 机制 A §2.5：尊重权限模式，与 IPC 权限路径（permission-flow）保持一致。
    // 此前 gate 完全忽略 mode —— 默认 allow-all 下 capability 仍走 Brain judge（可能拒绝），
    // 与工具路径（allow-all 自动放行）不一致。
    const mode = this.getMode?.() ?? 'ask';
    if (mode === 'allow-all') {
      return { allowed: true, reason: '权限模式 allow-all', source: 'auto' };
    }
    if (mode === 'deny-all') {
      return { allowed: false, reason: '权限模式 deny-all', source: 'auto' };
    }
    // ask / yolo → Brain judge（moderate→Brain 与机制 A L2→Brain 一致；yolo 全→Brain 一致）。

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

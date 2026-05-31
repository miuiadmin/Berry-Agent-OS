import type { DangerLevel } from './contract.js';

export interface PermissionScope {
  capabilities: string[];
  constraints?: {
    pathPattern?: string;
    maxDangerLevel?: DangerLevel;
    maxInvocations?: number;
    ttlMs?: number;
  };
  issuedAt: number;
}

export class ScopeChecker {
  private invocationCounts = new Map<string, number>();

  constructor(private readonly scope: PermissionScope) {}

  check(capabilityName: string, dangerLevel: DangerLevel, input?: unknown): { inScope: boolean; reason?: string } {
    if (!this.scope.capabilities.includes(capabilityName)) {
      return { inScope: false, reason: `capability "${capabilityName}" not in scope` };
    }

    const constraints = this.scope.constraints;
    if (!constraints) return { inScope: true };

    if (constraints.ttlMs) {
      const elapsed = Date.now() - this.scope.issuedAt;
      if (elapsed > constraints.ttlMs) {
        return { inScope: false, reason: `scope expired (${elapsed}ms > ${constraints.ttlMs}ms)` };
      }
    }

    if (constraints.maxDangerLevel) {
      const order: Record<DangerLevel, number> = { safe: 0, moderate: 1, dangerous: 2 };
      if (order[dangerLevel] > order[constraints.maxDangerLevel]) {
        return { inScope: false, reason: `danger level "${dangerLevel}" exceeds scope max "${constraints.maxDangerLevel}"` };
      }
    }

    if (constraints.maxInvocations) {
      const count = this.invocationCounts.get(capabilityName) ?? 0;
      if (count >= constraints.maxInvocations) {
        return { inScope: false, reason: `invocation limit reached (${count}/${constraints.maxInvocations})` };
      }
    }

    if (constraints.pathPattern && input) {
      const path = (input as any)?.path ?? (input as any)?.file_path ?? '';
      if (path && !matchGlob(constraints.pathPattern, path)) {
        return { inScope: false, reason: `path "${path}" outside scope "${constraints.pathPattern}"` };
      }
    }

    this.invocationCounts.set(capabilityName, (this.invocationCounts.get(capabilityName) ?? 0) + 1);
    return { inScope: true };
  }
}

function matchGlob(pattern: string, path: string): boolean {
  const regex = new RegExp('^' + pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
  return regex.test(path);
}

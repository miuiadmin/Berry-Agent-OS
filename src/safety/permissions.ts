import type { DangerLevel } from '../utils/types.js';
import type { IPermissionEngine, PermissionCheckResult } from './contract.js';
import { checkBlocklist } from './blocklist.js';

export type PermissionMode = 'ask' | 'allow-all' | 'deny-all';

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

export class PermissionEngine implements IPermissionEngine {
  private mode: PermissionMode;

  constructor(mode: PermissionMode) {
    this.mode = mode;
  }

  checkPermission(toolName: string, toolInput: string, dangerLevel: DangerLevel): PermissionCheckResult {
    if (toolName === 'run_command') {
      const blockResult = checkBlocklist(toolInput);
      if (blockResult.blocked) {
        return { allowed: false, reason: blockResult.reason };
      }
    }

    switch (this.mode) {
      case 'deny-all':
        return { allowed: false, reason: '权限模式为 deny-all，所有工具调用被拒绝' };

      case 'allow-all':
        return { allowed: true };

      case 'ask':
        if (dangerLevel === 'safe') {
          return { allowed: true };
        }
        return { allowed: false, requiresReview: true, reason: 'ask 模式需要 Brain 审核' };
    }
  }

  getMode(): PermissionMode {
    return this.mode;
  }
}

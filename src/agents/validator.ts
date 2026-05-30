import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { AgentManifest } from './manifest.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateAgentDir(manifestPath: string, manifest: AgentManifest): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dir = dirname(manifestPath);

  const entryPath = resolve(dir, manifest.entry);
  if (!existsSync(entryPath)) {
    errors.push(`入口文件不存在: ${entryPath}`);
  }

  if (manifest.kind === 'resident' && manifest.ipcProtocol === 'module-agent') {
    warnings.push(`Resident Agent "${manifest.name}" 使用 module-agent 协议，通常 resident 需要 custom 协议`);
  }

  if (manifest.roles.length > 0 && manifest.kind !== 'resident') {
    warnings.push(`Agent "${manifest.name}" 声明了系统角色但不是 resident，角色通常需要常驻 Agent 承担`);
  }

  if (manifest.taskTypes.length === 0) {
    errors.push(`Agent "${manifest.name}" 必须声明至少一个 taskType`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

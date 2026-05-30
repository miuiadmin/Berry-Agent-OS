import type { PatchPlan } from './types.js';
import type { CodeWorkspace, ValidationResult } from './workspace.js';
import { validateFilePath } from './workspace.js';

export interface PatchStep {
  file: string;
  action: 'create' | 'edit' | 'delete';
  description: string;
  oldContent?: string;
  newContent?: string;
  priority: number;
  group?: string;
}

export interface PatchGroup {
  name: string;
  description: string;
  stepIndices: number[];
  rollbackOnFailure: boolean;
}

export interface PatchPlanV2 {
  version: 2;
  description: string;
  steps: PatchStep[];
  groups: PatchGroup[];
  metadata: {
    createdAt: number;
    estimatedFiles: number;
    requiresTest: boolean;
    testCommand?: string;
  };
}

export interface PlanValidationResult {
  valid: boolean;
  errors: Array<{ stepIndex: number; message: string }>;
  warnings: Array<{ stepIndex: number; message: string }>;
}

export function buildPatchPlan(raw: PatchPlan, workspace: CodeWorkspace, options?: { testCommand?: string }): PatchPlanV2 {
  const steps: PatchStep[] = raw.steps.map((s, i) => ({
    file: s.file,
    action: s.action,
    description: s.description,
    priority: i,
  }));

  const groups = groupSteps(steps);
  const uniqueFiles = new Set(steps.map(s => s.file));

  return {
    version: 2,
    description: raw.description,
    steps,
    groups,
    metadata: {
      createdAt: Date.now(),
      estimatedFiles: uniqueFiles.size,
      requiresTest: steps.some(s => s.action !== 'create' || s.file.includes('test')),
      testCommand: options?.testCommand,
    },
  };
}

export function validatePatchPlan(plan: PatchPlanV2, workspace: CodeWorkspace): PlanValidationResult {
  const errors: Array<{ stepIndex: number; message: string }> = [];
  const warnings: Array<{ stepIndex: number; message: string }> = [];
  const fileActions = new Map<string, Array<{ index: number; action: string }>>();

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];

    const validation: ValidationResult = validateFilePath(workspace, step.file, step.action === 'create' || step.action === 'edit' ? 'write' : 'write');
    if (!validation.allowed) {
      errors.push({ stepIndex: i, message: validation.reason! });
    }

    const actions = fileActions.get(step.file) ?? [];
    actions.push({ index: i, action: step.action });
    fileActions.set(step.file, actions);
  }

  for (const [file, actions] of fileActions) {
    if (actions.length < 2) continue;

    const deleteIdx = actions.findIndex(a => a.action === 'delete');
    if (deleteIdx >= 0) {
      const afterDelete = actions.slice(deleteIdx + 1);
      for (const a of afterDelete) {
        if (a.action === 'edit') {
          errors.push({ stepIndex: a.index, message: `文件 ${file} 在 step ${actions[deleteIdx].index} 中被删除后不能再编辑` });
        }
      }
    }

    const createIndices = actions.filter(a => a.action === 'create');
    if (createIndices.length > 1) {
      for (const a of createIndices.slice(1)) {
        warnings.push({ stepIndex: a.index, message: `文件 ${file} 被重复创建` });
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function groupSteps(steps: PatchStep[]): PatchGroup[] {
  const dirMap = new Map<string, number[]>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const dir = step.group ?? getDirectory(step.file);
    const indices = dirMap.get(dir) ?? [];
    indices.push(i);
    dirMap.set(dir, indices);
  }

  const groups: PatchGroup[] = [];
  for (const [dir, indices] of dirMap) {
    if (indices.length === 0) continue;
    groups.push({
      name: dir,
      description: `${dir} 目录下的变更`,
      stepIndices: indices,
      rollbackOnFailure: true,
    });
  }

  return groups;
}

export function buildRollbackPlan(executedSteps: PatchStep[]): PatchStep[] {
  const rollbackSteps: PatchStep[] = [];

  for (let i = executedSteps.length - 1; i >= 0; i--) {
    const step = executedSteps[i];
    switch (step.action) {
      case 'create':
        rollbackSteps.push({
          file: step.file,
          action: 'delete',
          description: `回滚: 删除创建的文件 ${step.file}`,
          priority: rollbackSteps.length,
        });
        break;
      case 'edit':
        if (step.oldContent !== undefined) {
          rollbackSteps.push({
            file: step.file,
            action: 'edit',
            description: `回滚: 恢复 ${step.file} 的原始内容`,
            oldContent: step.newContent,
            newContent: step.oldContent,
            priority: rollbackSteps.length,
          });
        }
        break;
      case 'delete':
        if (step.oldContent !== undefined) {
          rollbackSteps.push({
            file: step.file,
            action: 'create',
            description: `回滚: 重建被删除的文件 ${step.file}`,
            newContent: step.oldContent,
            priority: rollbackSteps.length,
          });
        }
        break;
    }
  }

  return rollbackSteps;
}

export function serializePlan(plan: PatchPlanV2): string {
  return JSON.stringify(plan, null, 2);
}

export function deserializePlan(json: string): PatchPlanV2 {
  const parsed = JSON.parse(json);
  if (parsed.version !== 2) {
    throw new Error(`不支持的 PatchPlan 版本: ${parsed.version}`);
  }
  return parsed as PatchPlanV2;
}

function getDirectory(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  return lastSlash >= 0 ? filePath.slice(0, lastSlash) : '.';
}

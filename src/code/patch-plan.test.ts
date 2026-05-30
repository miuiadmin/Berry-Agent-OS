import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPatchPlan, validatePatchPlan, groupSteps, buildRollbackPlan, serializePlan, deserializePlan } from './patch-plan.js';
import type { PatchStep, PatchPlanV2 } from './patch-plan.js';
import { detectWorkspace } from './workspace.js';
import type { CodeWorkspace } from './workspace.js';
import type { PatchPlan } from './types.js';

let tempDir: string;
let gitRepo: string;
let workspace: CodeWorkspace;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'berry-patch-'));
  gitRepo = join(tempDir, 'repo');
  mkdirSync(gitRepo);
  execSync('git init', { cwd: gitRepo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: gitRepo, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: gitRepo, stdio: 'pipe' });
  mkdirSync(join(gitRepo, 'src'));
  writeFileSync(join(gitRepo, 'src/index.ts'), 'export {}');
  writeFileSync(join(gitRepo, 'README.md'), '# Test');
  execSync('git add . && git commit -m "init"', { cwd: gitRepo, stdio: 'pipe' });
  workspace = (await detectWorkspace(gitRepo))!;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('buildPatchPlan', () => {
  it('从原始 PatchPlan 构建 V2', () => {
    const raw: PatchPlan = {
      description: '添加新功能',
      steps: [
        { file: 'src/feature.ts', action: 'create', description: '创建功能文件' },
        { file: 'src/index.ts', action: 'edit', description: '添加导出' },
      ],
    };

    const plan = buildPatchPlan(raw, workspace);
    expect(plan.version).toBe(2);
    expect(plan.description).toBe('添加新功能');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].priority).toBe(0);
    expect(plan.steps[1].priority).toBe(1);
    expect(plan.metadata.estimatedFiles).toBe(2);
    expect(plan.groups.length).toBeGreaterThan(0);
  });

  it('设置 testCommand', () => {
    const raw: PatchPlan = {
      description: '修复 bug',
      steps: [{ file: 'src/fix.ts', action: 'edit', description: '修复' }],
    };
    const plan = buildPatchPlan(raw, workspace, { testCommand: 'npm test' });
    expect(plan.metadata.testCommand).toBe('npm test');
  });
});

describe('validatePatchPlan', () => {
  it('有效计划返回 valid: true', () => {
    const plan: PatchPlanV2 = {
      version: 2,
      description: 'test',
      steps: [
        { file: 'src/new.ts', action: 'create', description: '新文件', priority: 0 },
      ],
      groups: [],
      metadata: { createdAt: Date.now(), estimatedFiles: 1, requiresTest: false },
    };
    const result = validatePatchPlan(plan, workspace);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('路径越界时返回错误', () => {
    const plan: PatchPlanV2 = {
      version: 2,
      description: 'test',
      steps: [
        { file: '../../etc/passwd', action: 'edit', description: '越界', priority: 0 },
      ],
      groups: [],
      metadata: { createdAt: Date.now(), estimatedFiles: 1, requiresTest: false },
    };
    const result = validatePatchPlan(plan, workspace);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('路径越界');
  });

  it('excluded 路径返回错误', () => {
    const plan: PatchPlanV2 = {
      version: 2,
      description: 'test',
      steps: [
        { file: '.env', action: 'edit', description: '修改环境变量', priority: 0 },
      ],
      groups: [],
      metadata: { createdAt: Date.now(), estimatedFiles: 1, requiresTest: false },
    };
    const result = validatePatchPlan(plan, workspace);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('路径被排除');
  });

  it('检测 delete 后 edit 冲突', () => {
    const plan: PatchPlanV2 = {
      version: 2,
      description: 'test',
      steps: [
        { file: 'src/index.ts', action: 'delete', description: '删除', priority: 0 },
        { file: 'src/index.ts', action: 'edit', description: '编辑', priority: 1 },
      ],
      groups: [],
      metadata: { createdAt: Date.now(), estimatedFiles: 1, requiresTest: false },
    };
    const result = validatePatchPlan(plan, workspace);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('被删除后不能再编辑'))).toBe(true);
  });

  it('检测重复创建警告', () => {
    const plan: PatchPlanV2 = {
      version: 2,
      description: 'test',
      steps: [
        { file: 'src/new.ts', action: 'create', description: '创建1', priority: 0 },
        { file: 'src/new.ts', action: 'create', description: '创建2', priority: 1 },
      ],
      groups: [],
      metadata: { createdAt: Date.now(), estimatedFiles: 1, requiresTest: false },
    };
    const result = validatePatchPlan(plan, workspace);
    expect(result.warnings.some(w => w.message.includes('重复创建'))).toBe(true);
  });
});

describe('groupSteps', () => {
  it('按目录分组', () => {
    const steps: PatchStep[] = [
      { file: 'src/a.ts', action: 'edit', description: 'a', priority: 0 },
      { file: 'src/b.ts', action: 'edit', description: 'b', priority: 1 },
      { file: 'lib/c.ts', action: 'create', description: 'c', priority: 2 },
    ];
    const groups = groupSteps(steps);
    expect(groups).toHaveLength(2);
    const srcGroup = groups.find(g => g.name === 'src');
    const libGroup = groups.find(g => g.name === 'lib');
    expect(srcGroup).toBeDefined();
    expect(srcGroup!.stepIndices).toEqual([0, 1]);
    expect(libGroup).toBeDefined();
    expect(libGroup!.stepIndices).toEqual([2]);
  });

  it('所有组默认 rollbackOnFailure', () => {
    const steps: PatchStep[] = [
      { file: 'src/a.ts', action: 'edit', description: 'a', priority: 0 },
    ];
    const groups = groupSteps(steps);
    expect(groups[0].rollbackOnFailure).toBe(true);
  });

  it('尊重 step.group 自定义分组', () => {
    const steps: PatchStep[] = [
      { file: 'src/a.ts', action: 'edit', description: 'a', priority: 0, group: 'auth' },
      { file: 'lib/b.ts', action: 'edit', description: 'b', priority: 1, group: 'auth' },
    ];
    const groups = groupSteps(steps);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('auth');
    expect(groups[0].stepIndices).toEqual([0, 1]);
  });
});

describe('buildRollbackPlan', () => {
  it('create → delete 回滚', () => {
    const executed: PatchStep[] = [
      { file: 'src/new.ts', action: 'create', description: '创建', priority: 0, newContent: 'export {}' },
    ];
    const rollback = buildRollbackPlan(executed);
    expect(rollback).toHaveLength(1);
    expect(rollback[0].action).toBe('delete');
    expect(rollback[0].file).toBe('src/new.ts');
  });

  it('edit → 反向 edit 回滚', () => {
    const executed: PatchStep[] = [
      { file: 'src/a.ts', action: 'edit', description: '修改', priority: 0, oldContent: 'old', newContent: 'new' },
    ];
    const rollback = buildRollbackPlan(executed);
    expect(rollback).toHaveLength(1);
    expect(rollback[0].action).toBe('edit');
    expect(rollback[0].oldContent).toBe('new');
    expect(rollback[0].newContent).toBe('old');
  });

  it('delete → create 回滚（有 oldContent）', () => {
    const executed: PatchStep[] = [
      { file: 'src/old.ts', action: 'delete', description: '删除', priority: 0, oldContent: 'content' },
    ];
    const rollback = buildRollbackPlan(executed);
    expect(rollback).toHaveLength(1);
    expect(rollback[0].action).toBe('create');
    expect(rollback[0].newContent).toBe('content');
  });

  it('无 oldContent 的 edit 不生成回滚步骤', () => {
    const executed: PatchStep[] = [
      { file: 'src/a.ts', action: 'edit', description: '修改', priority: 0 },
    ];
    const rollback = buildRollbackPlan(executed);
    expect(rollback).toHaveLength(0);
  });

  it('逆序生成回滚步骤', () => {
    const executed: PatchStep[] = [
      { file: 'src/a.ts', action: 'create', description: '创建a', priority: 0 },
      { file: 'src/b.ts', action: 'create', description: '创建b', priority: 1 },
    ];
    const rollback = buildRollbackPlan(executed);
    expect(rollback[0].file).toBe('src/b.ts');
    expect(rollback[1].file).toBe('src/a.ts');
  });
});

describe('serializePlan / deserializePlan', () => {
  it('往返一致', () => {
    const plan: PatchPlanV2 = {
      version: 2,
      description: '测试计划',
      steps: [
        { file: 'src/a.ts', action: 'edit', description: '修改', priority: 0, oldContent: 'old', newContent: 'new' },
      ],
      groups: [{ name: 'src', description: 'src 目录下的变更', stepIndices: [0], rollbackOnFailure: true }],
      metadata: { createdAt: 1000, estimatedFiles: 1, requiresTest: true, testCommand: 'npm test' },
    };
    const json = serializePlan(plan);
    const restored = deserializePlan(json);
    expect(restored).toEqual(plan);
  });

  it('不支持的版本抛出错误', () => {
    const json = JSON.stringify({ version: 99, description: 'bad' });
    expect(() => deserializePlan(json)).toThrow('不支持的 PatchPlan 版本');
  });
});

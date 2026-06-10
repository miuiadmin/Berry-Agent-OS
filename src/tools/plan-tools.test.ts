/**
 * plan tool 单元测试。
 *
 * 注意：plan tool 依赖全局的 managerRef（由 initMissionTools 设置），
 * 所以测试在 beforeEach 中注入一个真实的 MissionManager 实例。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAppHome, getAppHome } from '../utils/paths.js';
import { planTool, initMissionTools } from './plan-tools.js';
import { MissionManager } from '../kernel/mission-manager.js';

let originalHome: string;
let testDir: string;

beforeEach(() => {
  originalHome = getAppHome();
  testDir = mkdtempSync(join(tmpdir(), 'plan-tool-test-'));
  setAppHome(testDir);
  // 注入真实的 MissionManager
  initMissionTools(new MissionManager());
});

afterEach(() => {
  setAppHome(originalHome);
  rmSync(testDir, { recursive: true, force: true });
});

/** 创建一个 mission 并返回 missionId */
function createTestMission(): string {
  // 通过 plan tool 间接创建
  // 实际我们直接用 manager 创建，因为 plan tool 本身只读/更新
  const mgr = new MissionManager();
  const plan = mgr.createMission('test goal', 'test context', [
    { what: 'T1', who: 'code' },
  ], 'brain');
  return plan.mission.id;
}

describe('plan tool — read', () => {
  it('读取不存在的 mission 返回错误', async () => {
    const result = await planTool.execute({ action: 'read', mission_id: 'm_does_not_exist' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('不存在');
  });

  it('读取存在的 mission 返回格式化摘要', async () => {
    const missionId = createTestMission();
    const result = await planTool.execute({ action: 'read', mission_id: missionId });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('test goal');
    expect(result.content).toContain('T1');
  });
});

describe('plan tool — update', () => {
  it('update 缺少 updates 字段返回错误', async () => {
    const missionId = createTestMission();
    const result = await planTool.execute({ action: 'update', mission_id: missionId });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('updates');
  });

  it('修改任务状态成功', async () => {
    const missionId = createTestMission();
    // 读 plan 找到 t-1
    const readResult = await planTool.execute({ action: 'read', mission_id: missionId });
    expect(readResult.content).toContain('t-1');

    const result = await planTool.execute({
      action: 'update',
      mission_id: missionId,
      updates: { task_id: 't-1', status: 'working' },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('t-1');
    expect(result.content).toContain('working');
  });

  it('追加新任务', async () => {
    const missionId = createTestMission();
    const result = await planTool.execute({
      action: 'update',
      mission_id: missionId,
      updates: { new_task: { what: 'T2', who: 'skills', depends_on: ['t-1'] } },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('T2');
    expect(result.content).toContain('skills');
  });

  it('记录决策', async () => {
    const missionId = createTestMission();
    const result = await planTool.execute({
      action: 'update',
      mission_id: missionId,
      updates: { decision: { thought: '先做 X 后做 Y' } },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('先做 X 后做 Y');
  });

  it('添加备注', async () => {
    const missionId = createTestMission();
    const result = await planTool.execute({
      action: 'update',
      mission_id: missionId,
      updates: { note: '这是备注' },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('这是备注');
  });

  it('不存在的 mission 返回错误', async () => {
    const result = await planTool.execute({
      action: 'update',
      mission_id: 'm_nonexistent',
      updates: { task_id: 't-1', status: 'working' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('不存在');
  });
});

describe('plan tool — schema 校验', () => {
  it('拒绝无效的 action', async () => {
    await expect(
      planTool.execute({ action: 'invalid_action', mission_id: 'm_xx' })
    ).rejects.toThrow();
  });

  it('拒绝缺少 mission_id', async () => {
    await expect(
      planTool.execute({ action: 'read' })
    ).rejects.toThrow();
  });
});

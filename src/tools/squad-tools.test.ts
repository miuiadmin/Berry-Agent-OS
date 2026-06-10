/**
 * squad tool 单元测试。
 *
 * 与 plan-tools.test.ts 共享同一个 initMissionTools + MissionManager 注入模式。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAppHome, getAppHome } from '../utils/paths.js';
import { squadTool } from './squad-tools.js';
import { initMissionTools } from './plan-tools.js';
import { MissionManager } from '../kernel/mission-manager.js';

let originalHome: string;
let testDir: string;
let missionId: string;

beforeEach(() => {
  originalHome = getAppHome();
  testDir = mkdtempSync(join(tmpdir(), 'squad-tool-test-'));
  setAppHome(testDir);
  const mgr = new MissionManager();
  initMissionTools(mgr);
  // 创建一个测试 mission
  const plan = mgr.createMission('测试目标', 'ctx', [], 'brain');
  missionId = plan.mission.id;
});

afterEach(() => {
  setAppHome(originalHome);
  rmSync(testDir, { recursive: true, force: true });
});

describe('squad tool — read', () => {
  it('无 squad 时返回提示信息', async () => {
    const result = await squadTool.execute({ action: 'read', mission_id: missionId });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('没有');
  });

  it('不存在的 mission 返回错误', async () => {
    const result = await squadTool.execute({ action: 'read', mission_id: 'm_nonexistent' });
    expect(result.isError).toBe(true);
  });
});

describe('squad tool — create_squad', () => {
  it('创建顶层 squad', async () => {
    const result = await squadTool.execute({
      action: 'create_squad',
      mission_id: missionId,
      squad: { name: '开发组', goal: '写代码', leader: 'code' },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('开发组');
    expect(result.content).toContain('code');
  });

  it('创建带成员的 squad', async () => {
    const result = await squadTool.execute({
      action: 'create_squad',
      mission_id: missionId,
      squad: {
        name: '测试组',
        goal: '写测试',
        leader: 'code',
        members: [
          { agent: 'code-1', role: 'work', on: '单元测试' },
          { agent: 'code-2', role: 'check', on: '代码审查' },
        ],
      },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('测试组');
    expect(result.content).toContain('code-1');
    expect(result.content).toContain('check');
  });

  it('缺少 squad 参数返回错误', async () => {
    const result = await squadTool.execute({ action: 'create_squad', mission_id: missionId });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('squad');
  });

  it('深度超限返回错误', async () => {
    // L1
    await squadTool.execute({
      action: 'create_squad', mission_id: missionId,
      squad: { name: 'L1', goal: 'g', leader: 'a' },
    });
    const mgr = new MissionManager();
    const s1 = mgr.readSquad(missionId)!.org.squads[0];
    // L2
    await squadTool.execute({
      action: 'create_squad', mission_id: missionId,
      squad: { name: 'L2', goal: 'g', leader: 'a', parent_squad_id: s1.id },
    });
    const s2 = mgr.readSquad(missionId)!.org.squads[0].squads![0];
    // L3
    await squadTool.execute({
      action: 'create_squad', mission_id: missionId,
      squad: { name: 'L3', goal: 'g', leader: 'a', parent_squad_id: s2.id },
    });
    const s3 = mgr.readSquad(missionId)!.org.squads[0].squads![0].squads![0];
    // L4 应该失败
    const result = await squadTool.execute({
      action: 'create_squad', mission_id: missionId,
      squad: { name: 'L4', goal: 'g', leader: 'a', parent_squad_id: s3.id },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('depth');
  });
});

describe('squad tool — update_member', () => {
  it('更新成员状态', async () => {
    // 先创建一个带成员的 squad
    await squadTool.execute({
      action: 'create_squad', mission_id: missionId,
      squad: {
        name: 'S', goal: 'g', leader: 'code',
        members: [{ agent: 'code-1', role: 'work', on: '干活' }],
      },
    });
    const mgr = new MissionManager();
    const sid = mgr.readSquad(missionId)!.org.squads[0].id;

    const result = await squadTool.execute({
      action: 'update_member', mission_id: missionId,
      member_update: { squad_id: sid, agent: 'code-1', status: 'working' },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('working');
  });

  it('缺少 member_update 返回错误', async () => {
    const result = await squadTool.execute({ action: 'update_member', mission_id: missionId });
    expect(result.isError).toBe(true);
  });
});

describe('squad tool — signal', () => {
  it('发送 blocker 信号', async () => {
    await squadTool.execute({
      action: 'create_squad', mission_id: missionId,
      squad: { name: 'S', goal: 'g', leader: 'code' },
    });
    const mgr = new MissionManager();
    const sid = mgr.readSquad(missionId)!.org.squads[0].id;

    const result = await squadTool.execute({
      action: 'signal', mission_id: missionId,
      signal: { squad_id: sid, type: 'blocker', msg: '遇到阻碍' },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('blocker');
    expect(result.content).toContain('遇到阻碍');
  });

  it('缺少 signal 参数返回错误', async () => {
    const result = await squadTool.execute({ action: 'signal', mission_id: missionId });
    expect(result.isError).toBe(true);
  });
});

describe('squad tool — handoff', () => {
  it('执行交接', async () => {
    await squadTool.execute({
      action: 'create_squad', mission_id: missionId,
      squad: { name: 'A', goal: 'g', leader: 'a' },
    });
    await squadTool.execute({
      action: 'create_squad', mission_id: missionId,
      squad: { name: 'B', goal: 'g', leader: 'b' },
    });
    const mgr = new MissionManager();
    const squad = mgr.readSquad(missionId)!;
    const sA = squad.org.squads[0].id;
    const sB = squad.org.squads[1].id;

    const result = await squadTool.execute({
      action: 'handoff', mission_id: missionId,
      handoff_data: { from_squad: sA, to_squad: sB, what: '交接内容' },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('交接完成');
  });

  it('缺少 handoff_data 返回错误', async () => {
    const result = await squadTool.execute({ action: 'handoff', mission_id: missionId });
    expect(result.isError).toBe(true);
  });
});

describe('squad tool — read after mutations', () => {
  it('创建 squad 后 read 显示组织图', async () => {
    await squadTool.execute({
      action: 'create_squad', mission_id: missionId,
      squad: { name: '开发组', goal: '开发功能', leader: 'code' },
    });
    const result = await squadTool.execute({ action: 'read', mission_id: missionId });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('开发组');
    expect(result.content).toContain('开发功能');
  });
});

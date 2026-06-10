/**
 * FS plan template squads 字段支持（§11/P11）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAppHome, getAppHome } from '../utils/paths.js';
import { MissionManager } from './mission-manager.js';

let originalHome: string;
let testDir: string;
let mgr: MissionManager;

beforeEach(() => {
  originalHome = getAppHome();
  testDir = mkdtempSync(join(tmpdir(), 'fs-template-squads-test-'));
  setAppHome(testDir);
  mgr = new MissionManager();
});

afterEach(() => {
  setAppHome(originalHome);
  if (testDir) rmSync(testDir, { recursive: true, force: true});
});

describe('FS plan template 支持 squads 字段', () => {
  it('FS plan.json 包含 squads 字段 → createFromTemplate 自动 initSquad', () => {
    // 写入 FS 模板：含 squads 字段
    const templatesDir = join(testDir, 'templates', 'mission');
    mkdirSync(templatesDir, {recursive: true});
    const planWithSquads = {
      mission: {
        id: 'tpl-fs-1',
        goal: 'FS 模板测试',
        created_by: 'human',
        created_at: new Date().toISOString(),
        status: 'pending',
      },
      tasks: [
        {id: 't-1', what: '任务 1', who: 'code', status: 'waiting', depends_on: []},
      ],
      squads: [
        {
          name: 'FS-组',
          goal: 'FS 模板 squad 目标',
          leader: 'code',
          members: [
            {agent: 'learning', role: 'work', on: '查文档'},
            {agent: 'memory', role: 'check', on: '验证'},
          ],
        },
      ],
    };
    writeFileSync(join(templatesDir, 'with-squads.json'), JSON.stringify(planWithSquads));

    // 从 FS 模板创建 mission
    const plan = mgr.createFromTemplate('with-squads', '实际目标', '实际上下文');
    expect(plan).not.toBeNull();
    const missionId = plan!.mission.id;

    // 验证 squad.json 被自动创建
    const squadFile = mgr.readSquad(missionId);
    expect(squadFile).not.toBeNull();
    expect(squadFile!.org.squads).toHaveLength(1);
    expect(squadFile!.org.squads[0].name).toBe('FS-组');
    expect(squadFile!.org.squads[0].leader).toBe('code');
    expect(squadFile!.org.squads[0].members).toHaveLength(2);
  });

  it('FS plan.json 不含 squads 字段 → 不创建 squad（兼容旧模板）', () => {
    const templatesDir = join(testDir, 'templates', 'mission');
    mkdirSync(templatesDir, {recursive: true});
    const planWithoutSquads = {
      mission: {
        id: 'tpl-fs-2',
        goal: '无 squads 模板',
        created_by: 'human',
        created_at: new Date().toISOString(),
        status: 'pending',
      },
      tasks: [
        {id: 't-1', what: '任务 1', who: 'code', status: 'waiting', depends_on: []},
      ],
      // 没有 squads 字段
    };
    writeFileSync(join(templatesDir, 'no-squads.json'), JSON.stringify(planWithoutSquads));

    const plan = mgr.createFromTemplate('no-squads', '实际', '实际');
    expect(plan).not.toBeNull();

    const squadFile = mgr.readSquad(plan!.mission.id);
    expect(squadFile).toBeNull();  // 没有 squads 字段 → 不创建
  });

  it('FS 模板 squads 优先级：overrides > FS squads > BUILTIN squads', () => {
    const templatesDir = join(testDir, 'templates', 'mission');
    mkdirSync(templatesDir, {recursive: true});
    const planWithSquads = {
      mission: {id: 't', goal: 'g', created_by: 'h', created_at: new Date().toISOString(), status: 'pending'},
      tasks: [{id: 't-1', what: 'task', who: 'code', status: 'waiting', depends_on: []}],
      squads: [{name: 'FS-squad', goal: 'g', leader: 'code'}],
    };
    writeFileSync(join(templatesDir, 'priority-test.json'), JSON.stringify(planWithSquads));

    // 用 overrides 覆盖
    const plan = mgr.createFromTemplate('priority-test', 'g', 'c', {
      squads: [{name: 'OVERRIDE-squad', goal: 'override-g', leader: 'over'}],
    });
    const squadFile = mgr.readSquad(plan!.mission.id)!;
    expect(squadFile.org.squads).toHaveLength(1);
    expect(squadFile.org.squads[0].name).toBe('OVERRIDE-squad');
  });
});
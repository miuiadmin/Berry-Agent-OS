/**
 * /api/missions/:id/signal 类型校验测试（§11.5）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAppHome, getAppHome } from '../utils/paths.js';
import { MissionManager } from './mission-manager.js';

let originalHome: string;
let testDir: string;
let mgr: MissionManager;

beforeEach(() => {
  originalHome = getAppHome();
  testDir = mkdtempSync(join(tmpdir(), 'signal-validation-test-'));
  setAppHome(testDir);
  mgr = new MissionManager();
});

afterEach(() => {
  setAppHome(originalHome);
  if (testDir) rmSync(testDir, {recursive: true, force: true});
});

/**
 * 模拟 mission-api.ts 的类型校验逻辑（同样的 validTypes check）。
 * 这里抽出来便于单测。
 */
function validateAndSend(mgr: MissionManager, missionId: string, squadId: string, from: string, type: string, msg: string): { ok: boolean; error?: string } {
  const validTypes = ['progress', 'done', 'blocker', 'question'] as const;
  if (!validTypes.includes(type as typeof validTypes[number])) {
    return { ok: false, error: `Invalid signal type: ${type}. Must be one of: ${validTypes.join(', ')}` };
  }
  try {
    mgr.sendSignal(missionId, squadId, from, type as typeof validTypes[number], msg);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message };
  }
}

describe('signal 类型校验（§11.5）', () => {
  let plan: ReturnType<MissionManager['createMission']>;

  beforeEach(() => {
    plan = mgr.createMission('m', 'c', [{ what: 't', who: 'code' }]);
    mgr.createSquad(plan.mission.id, { name: 'A', goal: 'g', leader: 'code' });
  });

  it('合法 type（progress/done/blocker/question）通过', () => {
    const squad = mgr.readSquad(plan.mission.id)!.org.squads[0];
    for (const t of ['progress', 'done', 'blocker', 'question']) {
      const result = validateAndSend(mgr, plan.mission.id, squad.id, 'code', t, 'test');
      expect(result.ok).toBe(true);
    }
  });

  it('非法 type → 400 错误（不调用 sendSignal）', () => {
    const squad = mgr.readSquad(plan.mission.id)!.org.squads[0];
    const result = validateAndSend(mgr, plan.mission.id, squad.id, 'code', 'invalid_type', 'test');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid signal type');
    // squad 没有新增 signal
    expect(mgr.readSquad(plan.mission.id)!.org.squads[0].signals).toHaveLength(0);
  });

  it('空 type → 拒绝', () => {
    const squad = mgr.readSquad(plan.mission.id)!.org.squads[0];
    const result = validateAndSend(mgr, plan.mission.id, squad.id, 'code', '', 'test');
    expect(result.ok).toBe(false);
  });
});
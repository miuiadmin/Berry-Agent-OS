import { describe, it, expect } from 'vitest';
import { PermissionGate } from './permission-gate.js';
import type { CapabilityDescriptor, InvokeContext } from './contract.js';
import type { PermissionMode } from '../safety/permissions.js';

/**
 * 15.0 机制 A §2.5：PermissionGate（capability 路径）尊重权限模式测试。
 *
 * 验证 capability 路径与 IPC 路径（permission-flow）一致尊重 mode：
 * - allow-all → 非 safe capability 自动放行（修复前 gate 忽略 mode，仍走 Brain judge）
 * - deny-all → 拒绝
 * - ask/yolo → Brain judge
 * - safe / in-scope 不受 mode 影响
 */
function capability(dangerLevel: 'safe' | 'moderate' | 'dangerous'): CapabilityDescriptor {
  return { name: `cap_${dangerLevel}`, dangerLevel, description: 'test', provider: { type: 'builtin', name: 'test' } } as unknown as CapabilityDescriptor;
}
const ctx: InvokeContext = { sessionId: 's1', callerAgent: 'agent' } as unknown as InvokeContext;

function makeGate(mode: PermissionMode, brainAllowed = true): PermissionGate {
  const gate = new PermissionGate();
  let currentMode = mode;
  gate.setMode(() => currentMode);
  gate.setBrainJudge({
    requestJudge: async () => ({ allowed: brainAllowed, reason: 'brain' }),
  });
  return gate;
}

describe('PermissionGate mode 尊重 (15.0 机制 A §2.5)', () => {
  it('safe capability → 任意模式自动放行', async () => {
    for (const m of ['ask', 'allow-all', 'deny-all', 'yolo'] as PermissionMode[]) {
      const r = await makeGate(m).check(capability('safe'), {}, ctx);
      expect(r.allowed).toBe(true);
      expect(r.source).toBe('auto');
    }
  });

  it('allow-all → 非 safe capability 自动放行（不再走 Brain judge）', async () => {
    const gate = makeGate('allow-all', /*brainAllowed=*/false); // Brain 会拒绝，但 allow-all 应先放行
    const moderate = await gate.check(capability('moderate'), {}, ctx);
    const dangerous = await gate.check(capability('dangerous'), {}, ctx);
    expect(moderate.allowed).toBe(true);
    expect(moderate.source).toBe('auto');
    expect(dangerous.allowed).toBe(true);
    expect(dangerous.source).toBe('auto');
  });

  it('deny-all → 非 safe capability 拒绝', async () => {
    const gate = makeGate('deny-all', /*brainAllowed=*/true); // Brain 会批准，但 deny-all 应先拒绝
    const moderate = await gate.check(capability('moderate'), {}, ctx);
    const dangerous = await gate.check(capability('dangerous'), {}, ctx);
    expect(moderate.allowed).toBe(false);
    expect(dangerous.allowed).toBe(false);
  });

  it('ask → 非 safe capability 走 Brain judge', async () => {
    const gate = makeGate('ask', true);
    const moderate = await gate.check(capability('moderate'), {}, ctx);
    const dangerous = await gate.check(capability('dangerous'), {}, ctx);
    expect(moderate.allowed).toBe(true);
    expect(moderate.source).toBe('brain');
    expect(dangerous.source).toBe('brain');
  });

  it('yolo → 非 safe capability 走 Brain judge', async () => {
    const gate = makeGate('yolo', true);
    const r = await gate.check(capability('dangerous'), {}, ctx);
    expect(r.allowed).toBe(true);
    expect(r.source).toBe('brain');
  });

  it('ask + Brain judge 拒绝 → capability 被拒', async () => {
    const gate = makeGate('ask', false);
    const r = await gate.check(capability('moderate'), {}, ctx);
    expect(r.allowed).toBe(false);
  });

  it('运行时切换 mode 生效（getMode 是活的）', async () => {
    let mode: PermissionMode = 'allow-all';
    const gate = new PermissionGate();
    gate.setMode(() => mode);
    gate.setBrainJudge({ requestJudge: async () => ({ allowed: false, reason: 'no' }) });
    expect((await gate.check(capability('moderate'), {}, ctx)).allowed).toBe(true); // allow-all
    mode = 'deny-all';
    expect((await gate.check(capability('moderate'), {}, ctx)).allowed).toBe(false); // deny-all
  });
});

describe('PermissionGate 无 Brain judge fail-closed (15.0 mechA A-2)', () => {
  it('ask 无 judge → moderate/dangerous 均 fail-closed 拒绝（与 IPC 一致，不再 auto-approve moderate）', async () => {
    const gate = new PermissionGate();
    gate.setMode(() => 'ask');
    // 不调 setBrainJudge —— 模拟 Brain judge 未配置
    const moderate = await gate.check(capability('moderate'), {}, ctx);
    const dangerous = await gate.check(capability('dangerous'), {}, ctx);
    expect(moderate.allowed).toBe(false);
    expect(dangerous.allowed).toBe(false);
    expect(moderate.reason).toContain('fail-closed');
  });

  it('allow-all 无 judge 仍放行（mode 检查在 judge 之前）', async () => {
    const gate = new PermissionGate();
    gate.setMode(() => 'allow-all');
    expect((await gate.check(capability('moderate'), {}, ctx)).allowed).toBe(true);
  });
});

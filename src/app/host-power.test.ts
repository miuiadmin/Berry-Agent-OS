/**
 * app — 关停/重启编舞测试（第八十五批批 D，骨架篇 §1.3 恒杀全家条）。
 *
 * 测法 = deps 全注入（探针/信号序/spawn/自退全假面）：确认门（缺确认拒退 2
 * + 单源确认语在场）/ client 形态（shutdown 直走信号序；reboot 无 daemon 诚实
 * 退 0、有 daemon stop→start 序）/ in-process 形态（shutdown 只自退零 spawn；
 * reboot 先 spawn 接力后自退、spawn 失败不退）/ CLI --yes 门与一实现两入口
 * （两入口同一 runPowerAction——deps 调用物证）。
 */
import { describe, expect, it, vi } from 'vitest';
import { powerCliMain, POWER_KILL_FAMILY_TEXT, runPowerAction, type PowerDeps } from './host-power.js';

/** 全记录 deps 假面（调用序物证——order 数组按发生序记账） */
function makeDeps(overrides: Partial<PowerDeps> = {}): { deps: PowerDeps; order: string[] } {
  const order: string[] = [];
  const deps: PowerDeps = {
    detectDaemon: async () => {
      order.push('detect');
      return { port: 7860 };
    },
    stopDaemon: async () => {
      order.push('stop');
      return 0;
    },
    startDaemon: async () => {
      order.push('start');
      return 0;
    },
    spawnRelaunch: () => {
      order.push('spawn');
      return {} as never; // 注入面：defaultSpawnRelaunch 不参与（unref/child 形态由缺省面单测不了——序在此验）
    },
    selfExit: () => {
      order.push('exit');
    },
    ...overrides,
  };
  return { deps, order };
}

describe('host-power：确认门', () => {
  it('未过确认门：refused + 退 2 + 单源恒杀全家确认语在场', async () => {
    const result = await runPowerAction('shutdown', { confirmed: false, form: 'client' });
    expect(result.outcome).toBe('refused');
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain(POWER_KILL_FAMILY_TEXT);
    expect(POWER_KILL_FAMILY_TEXT).toContain('在飞 run、后台 Job、子进程树全收场'); // 确认语明示恒杀语义
  });
});

describe('host-power：client 形态（CLI 对 daemon）', () => {
  it('shutdown：直走 stop 信号序（单次）——不起机、不探针、不自退', async () => {
    const { deps, order } = makeDeps();
    const result = await runPowerAction('shutdown', { confirmed: true, form: 'client', deps });
    expect(result.outcome).toBe('daemon-signalled');
    expect(result.exitCode).toBe(0);
    expect(order).toEqual(['stop']);
  });

  it('reboot 无活 daemon：诚实退 0（no-daemon）——不 stop 不 start（不凭空起）', async () => {
    let detectCalled = false; // override 不带缺省记账——自记探针达否
    const { deps, order } = makeDeps({
      detectDaemon: async () => {
        detectCalled = true;
        return undefined; // 无活 daemon
      },
    });
    const result = await runPowerAction('reboot', { confirmed: true, form: 'client', deps });
    expect(result.outcome).toBe('no-daemon');
    expect(result.exitCode).toBe(0);
    expect(detectCalled).toBe(true); // 探针确达（判活后才诚实退）
    expect(order).toEqual([]); // 其后零动作（不 stop 不 start——不凭空起机）
  });

  it('reboot 有活 daemon：先 detect → stop → start（重启接力序）', async () => {
    const { deps, order } = makeDeps();
    const result = await runPowerAction('reboot', { confirmed: true, form: 'client', deps });
    expect(result.outcome).toBe('daemon-signalled');
    expect(result.exitCode).toBe(0);
    expect(order).toEqual(['detect', 'stop', 'start']);
  });

  it('信号序非零码透传（stop 失败不谎报成）', async () => {
    const { deps } = makeDeps({ stopDaemon: async () => 1 });
    const result = await runPowerAction('shutdown', { confirmed: true, form: 'client', deps });
    expect(result.exitCode).toBe(1);
  });
});

describe('host-power：in-process 形态（桌面对本进程）', () => {
  it('shutdown：只自退（selfExit）——零 spawn 零 daemon 动作（收口自退 = 优雅退出序列在宿主）', async () => {
    const { deps, order } = makeDeps();
    const result = await runPowerAction('shutdown', { confirmed: true, form: 'in-process', deps });
    expect(result.outcome).toBe('self-exiting');
    expect(result.exitCode).toBe(0);
    expect(order).toEqual(['exit']);
  });

  it('reboot 成功：先 spawn 接力后自退（序物证——spawn 先于 exit）', async () => {
    const { deps, order } = makeDeps();
    const result = await runPowerAction('reboot', { confirmed: true, form: 'in-process', deps });
    expect(result.outcome).toBe('relaunching');
    expect(result.exitCode).toBe(0);
    expect(order).toEqual(['spawn', 'exit']);
  });

  it('reboot spawn 失败：诚实 spawn-failed 退 1——进程不退（可重试）', async () => {
    const { deps, order } = makeDeps({
      spawnRelaunch: () => {
        throw new Error('spawn 炸了');
      },
    });
    const result = await runPowerAction('reboot', { confirmed: true, form: 'in-process', deps });
    expect(result.outcome).toBe('spawn-failed');
    expect(result.exitCode).toBe(1);
    expect(order).toEqual([]); // 未自退（exit 不在）
  });
});

describe('host-power：CLI 入口（powerCliMain）', () => {
  it('缺 --yes：stderr 拒因 + 指路 --yes + 退 2（fail-loud——恒杀全家不默认执行）', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await powerCliMain('shutdown', { yes: false });
      expect(code).toBe(2);
      const text = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(text).toContain('拒绝执行 shutdown');
      expect(text).toContain(POWER_KILL_FAMILY_TEXT);
      expect(text).toContain('--yes');
    } finally {
      stderr.mockRestore();
    }
  });

  it('--yes + client 形态：结果文案落 stdout + 信号序退出码', async () => {
    const { deps, order } = makeDeps();
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((t) => {
      writes.push(String(t));
      return true;
    });
    try {
      const code = await powerCliMain('shutdown', { yes: true, write: (t) => writes.push(t), deps });
      expect(code).toBe(0);
      expect(order).toEqual(['stop']);
      expect(writes.join('')).toContain('信号序');
    } finally {
      stdout.mockRestore();
    }
  });

  it('一实现两入口物证：CLI 腿与桌面腿同一编舞（同 deps 双入口 = 同调用序）', async () => {
    // CLI 入口二（--yes → client 形态）
    const cliMade = makeDeps();
    await powerCliMain('shutdown', { yes: true, write: () => undefined, deps: cliMade.deps });
    // 桌面入口一（UI 确认在前 confirmed:true → in-process 形态——宿主 desktop-main 同款接法）
    const desktopMade = makeDeps();
    const result = await runPowerAction('shutdown', { confirmed: true, form: 'in-process', deps: desktopMade.deps });
    // 两入口都不各自实现编舞——全路由进 runPowerAction 的 deps 面（调用形状一致：
    // CLI 腿消费 stop 信号序 / 桌面腿消费 selfExit，同一 PowerResult 契约面）
    expect(cliMade.order).toEqual(['stop']);
    expect(desktopMade.order).toEqual(['exit']);
    expect(result.outcome).toBe('self-exiting');
  });
});

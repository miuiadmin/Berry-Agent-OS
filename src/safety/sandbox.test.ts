/**
 * L3 safety 测试 — 沙箱服务（confine fail-closed / 后端链仲裁）、三级 fold、
 * 升权词汇（骨架篇 §7.1–§7.4）+ Seatbelt / bwrap 后端纯函数生成与功能性探测。
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AppError,
  SANDBOX_ESCALATION_INVALID,
  SANDBOX_MODE_INVALID,
  SANDBOX_UNAVAILABLE,
} from '../contracts/errors.js';
import type { SandboxBackend } from './types.js';
import { bwrapArgs, createBwrapBackend } from './bwrap.js';
import { seatbeltProfile, seatbeltReadOnlyProfile, createSeatbeltBackend } from './seatbelt.js';
import {
  ESCALATION_TARGETS,
  WIDER_MODES,
  createDefaultBackends,
  createSandboxService,
  escalationHintMarker,
  isSandboxMode,
  requestEscalation,
  resolveEffectiveMode,
  sandboxDenialMarker,
  validateEscalationArgs,
  type SandboxPolicy,
} from './sandbox.js';

/** 同步抛错断言（thunk 包装——直接调用会让错误穿透成未处理异常） */
function expectThrow(fn: () => unknown, code: string): AppError {
  try {
    fn();
  } catch (err) {
    const e = err as AppError;
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe(code);
    return e;
  }
  expect.unreachable(`期望抛 ${code} 但未抛出`);
}

/** 测试用假后端（wrap 加前缀；probe 可注入，供仲裁/缓存断言） */
function fakeBackend(id: string, probeResult?: () => boolean): SandboxBackend {
  return {
    id,
    enforcement: 'full',
    denialSignatures: [`[${id} denied]`],
    runnerFailureRules: [{ fatalSignatures: [`${id}: `] }],
    wrap: (argv) => [`runner-${id}`, ...argv],
    ...(probeResult
      ? {
          probe: () => probeResult(),
        }
      : {}),
  };
}

const WS_POLICY: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/ws' };

describe('resolveEffectiveMode（三级 fold）', () => {
  it('空事件序列 → 部署默认（read-only fail-safe）', () => {
    expect(resolveEffectiveMode([])).toBe('read-only');
    expect(resolveEffectiveMode([], 'workspace-write')).toBe('workspace-write');
  });

  it('fold：最后一条胜出', () => {
    expect(resolveEffectiveMode([{ mode: 'read-only' }, { mode: 'workspace-write' }])).toBe('workspace-write');
    expect(resolveEffectiveMode([{ mode: 'danger-full-access' }, { mode: 'read-only' }])).toBe('read-only');
  });

  it('载荷不在三档词汇内 → fail-loud（静默跳过是 fail-open）', () => {
    expectThrow(() => resolveEffectiveMode([{ mode: 'workspace-write' }, { mode: 'nope' }]), SANDBOX_MODE_INVALID);
  });

  it('isSandboxMode 三档守卫', () => {
    expect(isSandboxMode('read-only')).toBe(true);
    expect(isSandboxMode('workspace-write')).toBe(true);
    expect(isSandboxMode('danger-full-access')).toBe(true);
    expect(isSandboxMode('read_only')).toBe(false);
  });
});

describe('createSandboxService（confine fail-closed）', () => {
  it('空链 → SANDBOX_UNAVAILABLE，绝不裸跑', () => {
    const service = createSandboxService({ backends: [] });
    expectThrow(() => service.confine(['ls'], WS_POLICY), SANDBOX_UNAVAILABLE);
  });

  it('单候选直接使用不预探测（探测仲裁，不重复验证唯一候选）', () => {
    const backend = fakeBackend('solo');
    const service = createSandboxService({ backends: [backend] });
    const confined = service.confine(['ls', '-la'], { mode: 'workspace-write', workspaceRoot: '/ws' });
    expect(confined.argv).toEqual(['runner-solo', 'ls', '-la']);
    expect(confined.enforcement).toBe('full');
    expect(confined.denialSignatures).toEqual(['[solo denied]']);
    expect(confined.runnerFailureRules).toEqual([{ fatalSignatures: ['solo: '] }]);
  });

  it('多候选按 probe 仲裁：首个失败者跳过、结果缓存（每后端只探一次）', () => {
    let badProbes = 0;
    let goodProbes = 0;
    const bad = fakeBackend('bad', () => {
      badProbes += 1;
      return false;
    });
    const good = fakeBackend('good', () => {
      goodProbes += 1;
      return true;
    });
    const service = createSandboxService({ backends: [bad, good] });
    const first = service.confine(['ls'], WS_POLICY);
    expect(first.argv[0]).toBe('runner-good');
    const second = service.confine(['ls'], WS_POLICY);
    expect(second.argv[0]).toBe('runner-good');
    expect(badProbes).toBe(1); // 缓存后不再重试坏候选
    expect(goodProbes).toBe(1); // 好候选也只探一次
  });

  it('多候选全部探测失败 → SANDBOX_UNAVAILABLE', () => {
    const service = createSandboxService({
      backends: [fakeBackend('a', () => false), fakeBackend('b', () => false)],
    });
    expectThrow(() => service.confine(['ls'], WS_POLICY), SANDBOX_UNAVAILABLE);
  });

  it('registerBackend 追加链尾；注销器摘除且幂等', () => {
    const service = createSandboxService({ backends: [] });
    const dispose = service.registerBackend(fakeBackend('one'));
    expect(service.listBackends().map((b) => b.id)).toEqual(['one']);
    dispose();
    dispose(); // 幂等
    expect(service.listBackends()).toHaveLength(0);
    expectThrow(() => service.confine(['ls'], WS_POLICY), SANDBOX_UNAVAILABLE);
  });

  it('createDefaultBackends：平台链形态（darwin=seatbelt / linux=bwrap / 其余空链）', () => {
    const backends = createDefaultBackends();
    if (process.platform === 'darwin') expect(backends.map((b) => b.id)).toEqual(['seatbelt']);
    else if (process.platform === 'linux') expect(backends.map((b) => b.id)).toEqual(['bwrap']);
    else expect(backends).toEqual([]);
  });
});

describe('升权词汇（骨架篇 §7.4）', () => {
  it('WIDER_MODES 严格变宽阶梯 + ESCALATION_TARGETS 形态', () => {
    expect(WIDER_MODES['read-only']).toEqual(['workspace-write', 'danger-full-access']);
    expect(WIDER_MODES['workspace-write']).toEqual(['danger-full-access']);
    expect(WIDER_MODES['danger-full-access']).toEqual([]);
    expect(ESCALATION_TARGETS).toEqual(['workspace-write', 'danger-full-access']);
  });

  it('validateEscalationArgs：两者全缺 → 拒（不进审批）', () => {
    expectThrow(
      () => validateEscalationArgs({ current: 'read-only', sandboxPermissions: undefined, justification: undefined }),
      SANDBOX_ESCALATION_INVALID,
    );
  });

  it('validateEscalationArgs：残缺成对（只有一边）→ 拒', () => {
    expectThrow(
      () =>
        validateEscalationArgs({
          current: 'read-only',
          sandboxPermissions: 'workspace-write',
          justification: undefined,
        }),
      SANDBOX_ESCALATION_INVALID,
    );
    expectThrow(
      () => validateEscalationArgs({ current: 'read-only', sandboxPermissions: undefined, justification: '因为需要' }),
      SANDBOX_ESCALATION_INVALID,
    );
  });

  it('validateEscalationArgs：空句 justification（纯空白）等同缺失 → 拒', () => {
    expectThrow(
      () =>
        validateEscalationArgs({ current: 'read-only', sandboxPermissions: 'workspace-write', justification: '   ' }),
      SANDBOX_ESCALATION_INVALID,
    );
  });

  it('validateEscalationArgs：目标档非法（read-only 不是升权目标）→ 拒', () => {
    expectThrow(
      () =>
        validateEscalationArgs({
          current: 'workspace-write',
          sandboxPermissions: 'read-only',
          justification: '想变窄',
        }),
      SANDBOX_ESCALATION_INVALID,
    );
  });

  it('validateEscalationArgs：非严格变宽（同档重试 / 变窄绕行）→ 不弹窗直接拒', () => {
    // 同档：workspace-write → workspace-write
    expectThrow(
      () =>
        validateEscalationArgs({
          current: 'workspace-write',
          sandboxPermissions: 'workspace-write',
          justification: '再试一次',
        }),
      SANDBOX_ESCALATION_INVALID,
    );
    // 变窄：danger-full-access → workspace-write
    expectThrow(
      () =>
        validateEscalationArgs({
          current: 'danger-full-access',
          sandboxPermissions: 'workspace-write',
          justification: '想收窄',
        }),
      SANDBOX_ESCALATION_INVALID,
    );
  });

  it('validateEscalationArgs：合法升宽通过并返回 trim 后的产物', () => {
    expect(
      validateEscalationArgs({
        current: 'read-only',
        sandboxPermissions: ' workspace-write ',
        justification: ' 需要写测试产物 ',
      }),
    ).toEqual({
      target: 'workspace-write',
      justification: '需要写测试产物',
    });
    expect(
      validateEscalationArgs({ current: 'read-only', sandboxPermissions: 'danger-full-access', justification: 'x' })
        .target,
    ).toBe('danger-full-access');
    expect(
      validateEscalationArgs({
        current: 'workspace-write',
        sandboxPermissions: 'danger-full-access',
        justification: 'x',
      }).target,
    ).toBe('danger-full-access');
  });

  it('sandboxDenialMarker / escalationHintMarker 固定文案（§7.4 统一拒绝与提示）', () => {
    expect(sandboxDenialMarker('read-only')).toBe('[sandbox: file access denied under read-only]');
    expect(sandboxDenialMarker('workspace-write')).toBe('[sandbox: file access denied under workspace-write]');
    const hint = escalationHintMarker();
    expect(hint).toContain('sandbox_permissions');
    expect(hint).toContain('justification');
    expect(hint).toContain('不许绕路');
  });

  it('requestEscalation：ask 载荷注明目标档与理由，outcome 原样返回', async () => {
    const asks: unknown[] = [];
    const approval = {
      ask: async (req: { summary: string; reason?: string }) => {
        asks.push(req);
        return 'allowed-once' as const;
      },
    };
    const outcome = await requestEscalation(approval, {
      current: 'read-only',
      target: 'workspace-write',
      justification: '构建产物需要落盘',
      toolName: 'bash',
      toolCallId: 'call-1',
    });
    expect(outcome).toBe('allowed-once');
    expect(asks[0]).toMatchObject({
      summary: '沙箱升权 read-only → workspace-write',
      reason: '目标档 workspace-write；理由：构建产物需要落盘',
      toolName: 'bash',
      toolCallId: 'call-1',
    });
  });
});

describe('Seatbelt 后端（纯函数 profile 生成）', () => {
  it('read-only：全默认放行 + 拒写 + /dev/null 例外', () => {
    const profile = seatbeltReadOnlyProfile();
    expect(profile).toContain('(version 1)');
    expect(profile).toContain('(allow default)');
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('(allow file-write* (literal "/dev/null"))');
  });

  it('workspace-write：逐根追加 subpath 放行（显式根直用，不走推导）', () => {
    const profile = seatbeltProfile({
      mode: 'workspace-write',
      workspaceRoot: '/ws',
      writableRoots: ['/ws', '/var/tmp/extra'],
    });
    expect(profile).toContain('(allow file-write* (subpath "/ws"))');
    expect(profile).toContain('(allow file-write* (subpath "/var/tmp/extra"))');
    // read-only 基础面保留
    expect(profile).toContain('(deny file-write*)');
  });

  it('read-only + 显式根（e1 宿主形态）：刚需根照常放行；缺省 read-only 字节不变', () => {
    // 字段覆盖契约恢复生效：修复前 mode 分支吃不到显式根——宿主 read-only 档
    // 数据目录建库被拒（真机冒烟实证 SQLITE_CANTOPEN）
    const rooted = seatbeltProfile({
      mode: 'read-only',
      workspaceRoot: '/ws',
      writableRoots: ['/data/.berry'],
    });
    expect(rooted).toContain('(allow file-write* (subpath "/data/.berry"))');
    expect(rooted).toContain('(deny file-write*)'); // 基座拒写保留（其余全拒）
    // 子进程缺省 read-only（无显式根）＝ 纯拒写基座——统一前后零漂移回归锚
    expect(seatbeltProfile({ mode: 'read-only', workspaceRoot: '/ws' })).toBe(seatbeltReadOnlyProfile());
  });

  it('SBPL 字符串转义：根路径含引号与反斜杠不破语法', () => {
    const profile = seatbeltProfile({
      mode: 'workspace-write',
      workspaceRoot: '/ws',
      writableRoots: ['/tmp/a"b\\c'],
    });
    expect(profile).toContain('(allow file-write* (subpath "/tmp/a\\"b\\\\c"))');
  });

  it('wrap：sandbox-exec 前缀 + profile 透传', () => {
    const backend = createSeatbeltBackend();
    const argv = backend.wrap(['git', 'status'], { mode: 'read-only', workspaceRoot: '/ws' });
    expect(argv[0]).toBe('sandbox-exec');
    expect(argv[1]).toBe('-p');
    expect(argv[2]).toBe(seatbeltReadOnlyProfile());
    expect(argv.at(-3)).toBe('--');
    expect(argv.at(-2)).toBe('git');
    expect(argv.at(-1)).toBe('status');
    // 后端差异数据化下发
    expect(backend.denialSignatures).toEqual(['operation not permitted']);
    expect(backend.runnerFailureRules).toEqual([{ fatalSignatures: ['sandbox-exec: '] }]);
  });

  it('probe：功能性探测（仅在本机 darwin + sandbox-exec 存在时执行）', () => {
    const backend = createSeatbeltBackend();
    if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
      expect(backend.probe?.(5_000)).toBe(true);
    } else {
      expect(backend.probe).toBeDefined(); // 非 darwin 环境不判真值，只验形态
    }
  });
});

describe('bwrap 后端（纯函数参数生成）', () => {
  it('read-only 缺省（无显式根）：只读根视图 + 虚拟设备 + tmpfs /tmp——统一前后字节不变', () => {
    // 子进程 read-only 档缺省推导空根——形态与统一前的 bwrapReadOnlyArgs 全同
    //（两档统一消费 resolvePolicyRoots 的回归锚：子进程既有行为零漂移）
    const args = bwrapArgs({ mode: 'read-only', workspaceRoot: '/ws' });
    expect(args).toEqual([
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--unshare-pid',
      '--die-with-parent',
      '--tmpfs',
      '/tmp',
    ]);
  });

  it('read-only + 显式根（e1 宿主形态）：刚需根真实 bind（字段覆盖契约恢复生效）', () => {
    // 修复前 mode 分支吃不到显式根——宿主 read-only 档数据目录建库被拒（真机
    // 冒烟实证）；统一后两档同等消费 writableRoots
    const args = bwrapArgs({ mode: 'read-only', workspaceRoot: '/ws', writableRoots: ['/data/.berry', '/db/dir'] });
    const bindTargets = args.filter((_, i) => args[i - 1] === '--bind');
    expect(bindTargets).toEqual(['/data/.berry', '/db/dir']); // 刚需根照常放行
    expect(args).toContain('--tmpfs'); // /tmp 恒 tmpfs（临时面不留痕不变式）
  });

  it('workspace-write：非 /tmp 根真实 bind；/tmp 保持 tmpfs（不真实 bind）', () => {
    const args = bwrapArgs({ mode: 'workspace-write', workspaceRoot: '/ws', writableRoots: ['/ws', '/tmp'] });
    const bindTargets = args.filter((_, i) => args[i - 1] === '--bind');
    expect(bindTargets).toEqual(['/ws']); // 只有 /ws 被真实 bind
    expect(args).toContain('--tmpfs');
    expect(args).toContain('/tmp');
  });

  it('wrap：bwrap 前缀 + -- 分隔消费方 argv', () => {
    const backend = createBwrapBackend();
    const argv = backend.wrap(['ls', '-la'], { mode: 'read-only', workspaceRoot: '/ws' });
    expect(argv[0]).toBe('bwrap');
    expect(argv.at(-3)).toBe('--');
    expect(argv.at(-2)).toBe('ls');
    expect(argv.at(-1)).toBe('-la');
    // 后端差异数据化下发
    expect(backend.denialSignatures).toEqual(['read-only file system']);
    expect(backend.runnerFailureRules).toEqual([{ fatalSignatures: ['bwrap: '] }]);
  });

  it('probe：功能性探测（仅在本机 linux + bwrap 存在时执行）', () => {
    const backend = createBwrapBackend();
    if (process.platform === 'linux' && existsSync('/usr/bin/bwrap')) {
      expect(backend.probe?.(5_000)).toBe(true);
    } else {
      expect(backend.probe).toBeDefined();
    }
  });
});

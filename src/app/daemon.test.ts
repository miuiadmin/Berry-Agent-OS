/**
 * L5 app — daemon 状态半边 + 命令族单元测试（契约篇 §6.8 常驻执行体条·刀一）。
 *
 * 覆盖三面：
 * ① daemon.json 生命周期（O_EXCL 单实例仲裁 / 判活探针 / 清扫 / 释放 /
 *    heldSessions 形状）+ token 文件（0600 / 复用 / 空文件重造 / 读时收紧）；
 * ② 命令族 start/stop/status（依赖注入假面：spawn/probeHttp/探针/预算全可换
 *    ——stop 判活路用真子进程 + 平台真探针，信号序实证不 mock）；
 * ③ 平台缺省探针（darwin/linux 前缀 + 不存在 pid = undefined）。
 *
 * 纪律：dataRoot 全部显式注入临时目录（G1 教训——测试不污染真实 ~/.berry）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, DAEMON_ALREADY_RUNNING, DAEMON_START_TIMEOUT } from '../contracts/errors.js';
import {
  acquireDaemonState,
  daemonStatePath,
  daemonTokenPath,
  defaultProcessProbe,
  ensureDaemonToken,
  isDaemonAlive,
  readDaemonState,
  releaseDaemonState,
  sweepStaleDaemonState,
  updateDaemonState,
  type DaemonState,
  type ProcessProbe,
} from './daemon-state.js';
import { daemonCommandMain } from './daemon.js';

/** 文件级数据目录钉扎（防任何缺省路径腿渗漏到真实 ~/.berry） */
const dataRoot = mkdtempSync(join(realpathSync(tmpdir()), 'daemon-unit-data-'));
process.env['APP_DATA_DIR'] = dataRoot;

/** 造一份合法持有态（测试常量形状——pid/processStartId 由用例注入） */
function makeState(pid: number, processStartId: string, heldSessions: string[] = []): DaemonState {
  return { pid, processStartId, bootId: 'boot-0001', port: 7860, heldSessions };
}

/** 退出登记（真子进程统一收口：exit 监听使 libuv 及时收割——僵尸态会骗过 ps 判活） */
const children: ChildProcess[] = [];
/** 起一个长睡真子进程（SIGTERM 默认致死形态；exit 事件翻旗可选） */
function spawnSleeper(script = 'setInterval(() => {}, 1e9)'): ChildProcess {
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  // spawn 即挂空监听：libuv 方会及时收割——否则死后僵尸态被 ps 判活，stop 轮询拖满预算
  child.once('exit', () => undefined);
  children.push(child);
  return child;
}
/** 等子进程退出（SIGKILL 收尾兜底——防挂具） */
function waitExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    // 信号致死：exitCode 恒 null、signalCode 才有值；且 exit 事件不回放——
    // 已死者必须当场判，否则新挂的 once('exit') 永不触发（本用例实证）
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
  });
}
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(join(dataRoot, 'daemon'), { recursive: true, force: true });
});

describe('daemon-state：daemon.json 生命周期 + token 文件', () => {
  it('acquire O_EXCL 首建：0600 落盘 + 内容 round-trip', () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-st-'));
    const state = makeState(4321, 'darwin:Mon Aug 30 10:24:15 2026', ['s-1', 's-2']);
    acquireDaemonState(root, state, { startId: () => undefined });
    const path = daemonStatePath(root);
    expect(existsSync(path)).toBe(true);
    // 0600：umask 022 与 0600 无交集位——权限位不受 umask 削
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readDaemonState(root)).toEqual(state);
    rmSync(root, { recursive: true, force: true });
  });

  it('acquire 撞活持有者：DAEMON_ALREADY_RUNNING 响亮失败 + 文件不动', () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-st-'));
    const holder = makeState(1111, 'live-id');
    acquireDaemonState(root, holder, { startId: () => undefined });
    // 探针恒答持有者起始标识 = 判活
    const aliveProbe: ProcessProbe = { startId: (pid) => (pid === 1111 ? 'live-id' : undefined) };
    expect(() => acquireDaemonState(root, makeState(2222, 'new-id'), aliveProbe)).toThrowError(AppError);
    try {
      acquireDaemonState(root, makeState(2222, 'new-id'), aliveProbe);
    } catch (err) {
      expect((err as AppError).code).toBe(DAEMON_ALREADY_RUNNING);
    }
    // 活 daemon 的态不许碰——内容仍是持有者的
    expect(readDaemonState(root)?.pid).toBe(1111);
    rmSync(root, { recursive: true, force: true });
  });

  it('acquire 撞死持有者：判死清扫 + 删重建（M6 动作钉）', () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-st-'));
    acquireDaemonState(root, makeState(1111, 'stale-id'), { startId: () => undefined });
    // 探针答 undefined = 原持有进程已死 → 撞文件路径自检后删重建
    acquireDaemonState(root, makeState(2222, 'fresh-id'), { startId: () => undefined });
    expect(readDaemonState(root)?.pid).toBe(2222);
    rmSync(root, { recursive: true, force: true });
  });

  it('release 双匹配才删：身份不符保留（闭 PID 复用窗）', () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-st-'));
    acquireDaemonState(root, makeState(3333, 'my-start'), { startId: () => undefined });
    // pid 相同但起始标识不同（同 pid 新进程）→ 新 daemon 的文件不被误删
    releaseDaemonState(root, { pid: 3333, processStartId: 'other-start' });
    expect(existsSync(daemonStatePath(root))).toBe(true);
    releaseDaemonState(root, { pid: 3333, processStartId: 'my-start' });
    expect(existsSync(daemonStatePath(root))).toBe(false);
    // 缺席幂等
    releaseDaemonState(root, { pid: 3333, processStartId: 'my-start' });
    rmSync(root, { recursive: true, force: true });
  });

  it('sweep：判死删文件返 true / 判活不动返 false / 缺席 false', () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-st-'));
    expect(sweepStaleDaemonState(root, { startId: () => undefined })).toBe(false); // 缺席
    acquireDaemonState(root, makeState(4444, 'alive-id'), { startId: () => undefined });
    expect(sweepStaleDaemonState(root, { startId: (pid) => (pid === 4444 ? 'alive-id' : undefined) })).toBe(false);
    expect(existsSync(daemonStatePath(root))).toBe(true);
    expect(sweepStaleDaemonState(root, { startId: () => undefined })).toBe(true);
    expect(existsSync(daemonStatePath(root))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('readDaemonState：损坏 JSON / 形状不符 = undefined（视同陈旧可清扫）', () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-st-'));
    mkdirSync(join(root, 'daemon'), { recursive: true });
    writeFileSync(daemonStatePath(root), '{broken json');
    expect(readDaemonState(root)).toBeUndefined();
    // heldSessions 混入非串成员：形状校验过滤为空（字段级容错——其余键合法即收）
    writeFileSync(
      daemonStatePath(root),
      JSON.stringify({ pid: 1, processStartId: 'x', bootId: 'b', port: 1, heldSessions: ['ok', 42, null] }),
    );
    expect(readDaemonState(root)?.heldSessions).toEqual(['ok']);
    // 缺必需键 = undefined
    writeFileSync(daemonStatePath(root), JSON.stringify({ pid: 1 }));
    expect(readDaemonState(root)).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it('update 原子重写（heldSessions 刷新路）+ isDaemonAlive 判据单源', () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-st-'));
    const state = makeState(5555, 'probe-id');
    acquireDaemonState(root, state, { startId: () => undefined });
    updateDaemonState(root, { ...state, heldSessions: ['s-9'] });
    expect(readDaemonState(root)?.heldSessions).toEqual(['s-9']);
    expect(statSync(daemonStatePath(root)).mode & 0o777).toBe(0o600);
    const probe: ProcessProbe = { startId: (pid) => (pid === 5555 ? 'probe-id' : undefined) };
    expect(isDaemonAlive(readDaemonState(root)!, probe)).toBe(true);
    expect(isDaemonAlive(readDaemonState(root)!, { startId: () => 'different' })).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('ensureDaemonToken：首造 64hex 0600 / 复用同值 / 空文件重造 / 读时收紧', () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-st-'));
    const token = ensureDaemonToken(root);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(daemonTokenPath(root)).mode & 0o777).toBe(0o600);
    // 二读同值（两进程 gate 握手与鉴权共用同一份的物证）
    expect(ensureDaemonToken(root)).toBe(token);
    // 空文件 = 缺失等价 → 重造新值
    writeFileSync(daemonTokenPath(root), '');
    const regenerated = ensureDaemonToken(root);
    expect(regenerated).toMatch(/^[0-9a-f]{64}$/);
    expect(regenerated).not.toBe(token);
    // 历史宽权限文件：读到即收 0600（boot 收紧面）
    writeFileSync(daemonTokenPath(root), 'manual-token');
    chmodSync(daemonTokenPath(root), 0o644);
    expect(ensureDaemonToken(root)).toBe('manual-token');
    expect(statSync(daemonTokenPath(root)).mode & 0o777).toBe(0o600);
    rmSync(root, { recursive: true, force: true });
  });

  it('平台缺省探针：本 pid 平台前缀 / 不存在 pid = undefined', () => {
    const own = defaultProcessProbe.startId(process.pid);
    expect(own).toMatch(/^(darwin:|linux:|alive:)/);
    // 超出 pid 上限的进程号：三平台路径（/proc 缺席 / ps 空输出 / kill ESRCH）殊途 undefined
    expect(defaultProcessProbe.startId(1_000_000)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 命令族（start/stop/status）——stop 判活路真子进程实证                 */
/* ------------------------------------------------------------------ */

/** 假子进程（start 路不真 spawn——exitCode/kill 面可控） */
function fakeChild(exitCode: number | null): { child: ChildProcess; killed: () => boolean } {
  let killed = false;
  const child = {
    exitCode,
    unref: () => undefined,
    kill: () => {
      killed = true;
      return true;
    },
  } as unknown as ChildProcess;
  return { child, killed: () => killed };
}

/** stdout 捕获（命令面输出 = 产品契约，断言其词面） */
function captureStdout(): string[] {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return chunks;
}

describe('daemon 命令族：start（gate/清扫/超时）', () => {
  it('start 成功：spawn detached + --foreground --port、gate 真握手 200 → exit 0 + 就绪词面', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-cmd-'));
    const out = captureStdout();
    const { child } = fakeChild(null);
    const spawnArgs: { cmd: string; args: readonly string[]; opts: { detached: boolean } }[] = [];
    const code = await daemonCommandMain('start', 7860, {
      dataRoot: root,
      spawnFn: (cmd, args, opts) => {
        spawnArgs.push({ cmd, args, opts });
        return child;
      },
      probeHttp: async () => ({ status: 200, body: '[]' }),
      probe: { startId: () => undefined },
    });
    expect(code).toBe(0);
    // 子进程命令行：解释器 + 脚本 + daemon --foreground --port N（三形态统一）
    expect(spawnArgs.length).toBe(1);
    expect(spawnArgs[0]!.args).toContain('daemon');
    expect(spawnArgs[0]!.args).toContain('--foreground');
    expect(spawnArgs[0]!.args.slice(-2)).toEqual(['--port', '7860']);
    expect(spawnArgs[0]!.opts.detached).toBe(true);
    // token 先于 spawn 已落盘（父 gate 与子鉴权同一份）
    expect(existsSync(daemonTokenPath(root))).toBe(true);
    expect(out.join('')).toContain('daemon 就绪');
    rmSync(root, { recursive: true, force: true });
  });

  it('start 前清扫判死残留 daemon.json（M6 时点钉之一）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-cmd-'));
    captureStdout();
    acquireDaemonState(root, makeState(999, 'stale'), { startId: () => undefined });
    const { child } = fakeChild(null);
    await daemonCommandMain('start', 7860, {
      dataRoot: root,
      spawnFn: () => child,
      probeHttp: async () => ({ status: 200, body: '[]' }),
      probe: { startId: () => undefined }, // 原持有者判死 → 清扫
    });
    // 假子进程不写真身——清扫后无人在写 = 文件缺席
    expect(existsSync(daemonStatePath(root))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('start 超时：gate 预算内未达真握手 → 杀子 + DAEMON_START_TIMEOUT', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-cmd-'));
    const { child, killed } = fakeChild(null);
    await expect(
      daemonCommandMain('start', 7860, {
        dataRoot: root,
        spawnFn: () => child,
        probeHttp: async () => undefined, // 永不握手成功
        probe: { startId: () => undefined },
        startGateBudgetMs: 150,
        pollIntervalMs: 40,
      }),
    ).rejects.toMatchObject({ code: DAEMON_START_TIMEOUT });
    expect(killed()).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('start 子进程启动即退：响亮失败带日志路径', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-cmd-'));
    const { child } = fakeChild(1); // 已退（exit 1）
    await expect(
      daemonCommandMain('start', 7860, {
        dataRoot: root,
        spawnFn: () => child,
        probeHttp: async () => undefined,
        probe: { startId: () => undefined },
      }),
    ).rejects.toThrowError(/启动即退/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('daemon 命令族：stop / status（真子进程 + 平台真探针）', () => {
  it('stop 无 daemon.json：幂等成功 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-cmd-'));
    const out = captureStdout();
    const code = await daemonCommandMain('stop', 7860, { dataRoot: root });
    expect(code).toBe(0);
    expect(out.join('')).toContain('未运行');
    rmSync(root, { recursive: true, force: true });
  });

  it('stop 判死残留：清扫即收场 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-cmd-'));
    const out = captureStdout();
    acquireDaemonState(root, makeState(999, 'gone'), { startId: () => undefined });
    const code = await daemonCommandMain('stop', 7860, { dataRoot: root });
    expect(code).toBe(0);
    expect(out.join('')).toContain('已死亡');
    expect(existsSync(daemonStatePath(root))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('stop 真子进程：SIGTERM 优雅退出 → 轮询判死 → 清 daemon.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-cmd-'));
    const out = captureStdout();
    const holder = spawnSleeper(); // 默认 SIGTERM 致死形态
    const startId = defaultProcessProbe.startId(holder.pid!)!;
    acquireDaemonState(root, makeState(holder.pid!, startId), { startId: () => undefined });
    const code = await daemonCommandMain('stop', 7860, { dataRoot: root, pollIntervalMs: 50 });
    expect(code).toBe(0);
    expect(out.join('')).toContain('已停止');
    expect(existsSync(daemonStatePath(root))).toBe(false);
    await waitExit(holder);
    rmSync(root, { recursive: true, force: true });
  });

  it('stop SIGTERM 免疫子进程：预算耗尽升格 SIGKILL → 强停收场', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-cmd-'));
    const out = captureStdout();
    // 免疫 handler 安装就绪标记（argv[1] 传标记路径——防 SIGTERM 抢在 handler 安装前送达的启动竞速）
    const readyMarker = join(root, 'immune-ready');
    const holder = spawnSleeper(
      // 尾挂 interval 保活：信号监听不保 node 活——脚本一结束进程即退，测不到信号序
      `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(readyMarker)}, "1"); setInterval(() => {}, 1e9)`,
    );
    // 等 handler 真在（标记文件 = 安装完成的因果序）再测信号序
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (existsSync(readyMarker)) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    });
    const startId = defaultProcessProbe.startId(holder.pid!)!;
    acquireDaemonState(root, makeState(holder.pid!, startId), { startId: () => undefined });
    const code = await daemonCommandMain('stop', 7860, {
      dataRoot: root,
      stopBudgetMs: 200, // 优雅预算收短 → 快速升格 SIGKILL
      pollIntervalMs: 50,
    });
    expect(code).toBe(0);
    expect(out.join('')).toContain('SIGKILL 强停');
    expect(existsSync(daemonStatePath(root))).toBe(false);
    await waitExit(holder);
    rmSync(root, { recursive: true, force: true });
  });

  it('status 三态：缺席 3 / 判死残留 3 / 活 + 真握手披露 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-cmd-'));
    // ① 缺席
    let out = captureStdout();
    expect(await daemonCommandMain('status', 7860, { dataRoot: root })).toBe(3);
    expect(out.join('')).toContain('未运行');
    // ② 判死残留
    acquireDaemonState(root, makeState(999, 'gone'), { startId: () => undefined });
    out = captureStdout();
    expect(await daemonCommandMain('status', 7860, { dataRoot: root })).toBe(3);
    expect(out.join('')).toContain('残留');
    // ③ 活 + 握手 200（假探活——不真占端口；清单长度披露）
    const holder = spawnSleeper();
    const startId = defaultProcessProbe.startId(holder.pid!)!;
    acquireDaemonState(root, makeState(holder.pid!, startId, ['s-1', 's-2']), { startId: () => undefined });
    out = captureStdout();
    expect(
      await daemonCommandMain('status', 7860, {
        dataRoot: root,
        probeHttp: async () => ({ status: 200, body: JSON.stringify([{ id: 'a' }, { id: 'b' }]) }),
      }),
    ).toBe(0);
    const text = out.join('');
    expect(text).toContain(`pid ${holder.pid}`);
    expect(text).toContain('清单 2 条');
    expect(text).toContain('持有会话 2 个');
    // ④ 活但握手未达（token 轮换竞窗——401 同样不算活证）
    out = captureStdout();
    expect(
      await daemonCommandMain('status', 7860, {
        dataRoot: root,
        probeHttp: async () => ({ status: 401, body: '' }),
      }),
    ).toBe(0);
    expect(out.join('')).toContain('未达成');
    rmSync(root, { recursive: true, force: true });
  });
});

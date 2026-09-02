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
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
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
import {
  daemonCommandMain,
  daemonDoctorMain,
  daemonForegroundMain,
  detectDaemonHandshake,
  httpProbe,
  probeStatus,
} from './daemon.js';
import { VERSION } from './version.js';
import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';

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

/** 假子进程（start 路不真 spawn——exitCode/kill/pid/on 面可控；pid 缺省 424242） */
function fakeChild(exitCode: number | null, pid = 424_242): { child: ChildProcess; killed: () => boolean } {
  let killed = false;
  const child = {
    pid,
    exitCode,
    unref: () => undefined,
    kill: () => {
      killed = true;
      return true;
    },
    // daemon.ts 已监听 'error'（spawn 失败腿，20260901-c #3）——假面补齐 on，
    // 吞掉监听注册即可（现有用例无人 emit error）
    on: () => child,
  } as unknown as ChildProcess;
  return { child, killed: () => killed };
}

/**
 * 「子进程完成 boot」的探针桩（O-5 身份核验后 start 成功路的真时序）：首次
 * 探测时模拟 acquireDaemonState 写 daemon.json（假子 pid）→ 应答 200——真
 * 子进程是先 acquire 落盘后 listen 才有握手，握手 200 时 daemon.json 必已
 * 持本子进程 pid。
 */
function bootingProbe(root: string, pid: number) {
  let booted = false;
  return async (): Promise<{ status: number; body: string }> => {
    if (!booted) {
      booted = true;
      acquireDaemonState(root, makeState(pid, 'fake'), { startId: () => undefined });
    }
    return { status: 200, body: '[]' };
  };
}

/** stdout 捕获（命令面输出 = 产品契约，断言其词面） */
function captureStdout(): string[] {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
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
      probeHttp: bootingProbe(root, 424_242), // 子 boot（acquire 落盘）→ 200
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
    // 就绪词面披露的是本次子进程 pid（身份核验后 pidHint 即真身）
    expect(out.join('')).toContain('daemon 就绪：pid 424242');
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
      probeHttp: bootingProbe(root, 424_242), // 清扫后新子 acquire 落盘 → 200
      probe: { startId: () => undefined }, // 原持有者判死 → 清扫
    });
    // 清扫实证（更强形）：旧文件不在（pid 999 已清）+ 新子 acquire 成功落盘
    //（旧文件残留时 O_EXCL 会撞——能落盘即证清扫先行）
    expect(readDaemonState(root)?.pid).toBe(424_242);
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

  it('start 慢滴流占端者（遗漏大扫 20260902-b #6 ①）：真探针挂死不吞启动预算——gate 按剩余预算收口响亮超时（修前单次挂死探针使 30s 预算整体失效无限挂起）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-cmd-'));
    captureStdout();
    const { child, killed } = fakeChild(null);
    // 慢滴流应答器占住目标端口：写头后每 120ms 滴一字节、永不 end——
    // 旧形 httpProbe（socket idle）对此永挂；本测 probeHttp 不注入（用真码）
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const drip = setInterval(() => {
        // 守卫：探针 abort 摧毁连接后写已死 res 逃 EPIPE（竞速窗）
        if (res.destroyed) {
          clearInterval(drip);
          return;
        }
        res.write('x');
      }, 120);
      res.on('close', () => clearInterval(drip));
      // 吸收对端 abort 后的迟到写错（EPIPE 等）——滴流服务端无错可报
      res.on('error', () => clearInterval(drip));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const dripPort = (server.address() as { port: number }).port;
    try {
      const startedAt = Date.now();
      // 看门狗竞速：修前 gate await 挂死探针永不返回、看门狗先到即红
      const outcome = await Promise.race([
        daemonCommandMain('start', dripPort, {
          dataRoot: root,
          spawnFn: () => child,
          probe: { startId: () => undefined },
          startGateBudgetMs: 1_200,
          pollIntervalMs: 40,
        }).then(
          () => 'settled',
          (err: AppError) => `rejected:${err.code}`,
        ),
        new Promise<'WATCHDOG'>((resolve) => setTimeout(() => resolve('WATCHDOG'), 4_000)),
      ]);
      expect(outcome).toBe(`rejected:${DAEMON_START_TIMEOUT}`); // 预算内响亮收场
      expect(Date.now() - startedAt).toBeLessThan(3_500); // 非看门狗兜底（真预算收口）
      expect(killed()).toBe(true); // 超时杀子不留守
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 12_000);

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

  it('start 子进程 spawn 失败（20260901-c #3）：error 无伴随 exit → 循环内即查即败（修前无监听即 uncaughtException）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-cmd-'));
    // 真实 spawn 失败形态：Node 只发 'error' 不发 'exit'（没有进程可退），
    // exitCode/signalCode 双空、pid 未定义——EventEmitter 手工还原该事件面
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, { pid: undefined, exitCode: null, unref: () => undefined, kill: () => true });
    await expect(
      daemonCommandMain('start', 7860, {
        dataRoot: root,
        spawnFn: () => {
          queueMicrotask(() =>
            child.emit('error', Object.assign(new Error('spawn no-such-runner ENOENT'), { code: 'ENOENT' })),
          );
          return child as ChildProcess;
        },
        probeHttp: async () => undefined,
        probe: { startId: () => undefined },
      }),
    ).rejects.toMatchObject({
      code: DAEMON_START_TIMEOUT,
      message: expect.stringMatching(/拉起失败（spawn：spawn no-such-runner ENOENT）/),
    });
    rmSync(root, { recursive: true, force: true });
  });

  it('start 双开假绿修死（遗漏大扫 20260901 O-5）：端口应答者是旧 daemon（daemon.json pid ≠ 本次子进程）→ DAEMON_ALREADY_RUNNING 响亮失败 + 杀子', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-cmd-'));
    const out = captureStdout();
    // 旧 daemon 存活：daemon.json 已持 pid 999 且判活——start 的清扫不动它
    acquireDaemonState(root, makeState(999, 'old-live'), { startId: () => undefined });
    const { child, killed } = fakeChild(null, 424_243);
    // 竞窗形态：旧 daemon 毫秒级应答 200（新子进程尚未跑到 acquire 撞
    // O_EXCL 退 1——stdio 全入 daemon.log，响亮失败被静默吞）
    await expect(
      daemonCommandMain('start', 7860, {
        dataRoot: root,
        spawnFn: () => child,
        probeHttp: async () => ({ status: 200, body: '[]' }),
        probe: { startId: () => 'old-live' }, // 旧持有者判活 → 清扫不动
      }),
    ).rejects.toMatchObject({ code: DAEMON_ALREADY_RUNNING });
    // 修复前：resolve 0 + 打印「daemon 就绪：pid 999」——应答者身份未验的假绿
    expect(out.join('')).not.toContain('daemon 就绪');
    expect(killed()).toBe(true); // doomed 子进程即杀不留守（防真子进程迟到起双活）
    rmSync(root, { recursive: true, force: true });
  });

  it('start 代际轮转（基建大扫 #51）：daemon.log >10 MiB → 整替归档 daemon.log.1（单代）；帽下不轮转', async () => {
    // 大日志 + 旧代残留：轮转须发生且整替旧代（单代留存，不做 .1/.2/.3 链）
    const root = mkdtempSync(join(tmpdir(), 'daemon-cmd-'));
    captureStdout();
    mkdirSync(join(root, 'daemon'), { recursive: true });
    writeFileSync(join(root, 'daemon', 'daemon.log.1'), 'old-generation'); // 上轮轮转残留
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61); // 超轮转帽 1 字节
    writeFileSync(join(root, 'daemon', 'daemon.log'), big);
    const { child } = fakeChild(null);
    const code = await daemonCommandMain('start', 7860, {
      dataRoot: root,
      spawnFn: () => child,
      probeHttp: bootingProbe(root, 424_242),
      probe: { startId: () => undefined },
    });
    expect(code).toBe(0);
    // 轮转已发生：.1 = 旧大日志（sentinel 旧代被整替）；daemon.log 重生为空（新 fd 从零续尾）
    expect(statSync(join(root, 'daemon', 'daemon.log.1')).size).toBe(big.length);
    expect(statSync(join(root, 'daemon', 'daemon.log')).size).toBe(0);
    rmSync(root, { recursive: true, force: true });

    // 帽下（1 KiB）：不轮转——原文件原地续尾，.1 不造
    const root2 = mkdtempSync(join(tmpdir(), 'daemon-cmd-'));
    captureStdout();
    mkdirSync(join(root2, 'daemon'), { recursive: true });
    writeFileSync(join(root2, 'daemon', 'daemon.log'), 'x'.repeat(1024));
    const { child: child2 } = fakeChild(null);
    await daemonCommandMain('start', 7860, {
      dataRoot: root2,
      spawnFn: () => child2,
      probeHttp: bootingProbe(root2, 424_242),
      probe: { startId: () => undefined },
    });
    expect(statSync(join(root2, 'daemon', 'daemon.log')).size).toBe(1024); // 原文件原地
    expect(existsSync(join(root2, 'daemon', 'daemon.log.1'))).toBe(false); // 未造 .1
    rmSync(root2, { recursive: true, force: true });
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

  it('【回归锁 #54】stop 判活-kill 竞窗（daemon 恰自死）：SIGTERM 路 ESRCH 按已死收场 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-cmd-'));
    const out = captureStdout();
    // 真死 pid：起即杀——process.kill 对它必抛 ESRCH（竞窗内 daemon 自死的实证形状）
    const holder = spawnSleeper();
    const deadPid = holder.pid!;
    holder.kill('SIGKILL');
    await waitExit(holder);
    // 脚本探针复刻 TOCTOU 时序：首调（isDaemonAlive 判活）回匹配 startId =
    // 判活过；此后（kill 后轮询）回 undefined = 已死——精确踩进竞窗
    let calls = 0;
    const probe: ProcessProbe = {
      startId: (pid) => (pid === deadPid && calls++ === 0 ? 'window-id' : undefined),
    };
    acquireDaemonState(root, makeState(deadPid, 'window-id'), { startId: () => undefined });
    // 修复前：process.kill 抛 ESRCH 冒泡顶层「✖ 退 1」（停成功却报失败且不清
    // daemon.json）；修复后按已死落轮询 → 清扫收场
    const code = await daemonCommandMain('stop', 7860, { dataRoot: root, probe });
    expect(code).toBe(0);
    expect(out.join('')).toContain('已停止');
    expect(existsSync(daemonStatePath(root))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('【回归锁 #54】stop 同竞窗 SIGKILL 升格路：ESRCH 同兜 → SIGKILL 强停收场', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-cmd-'));
    const out = captureStdout();
    const holder = spawnSleeper();
    const deadPid = holder.pid!;
    holder.kill('SIGKILL');
    await waitExit(holder);
    // 前 5 调判活（isDaemonAlive + SIGTERM 轮询至期限 + 期限 if 判读）＝优雅
    // 预算内「活」满 → 升格 SIGKILL 撞 ESRCH；此后 undefined → kill 轮询即判死
    let calls = 0;
    const probe: ProcessProbe = {
      startId: (pid) => (pid === deadPid && calls++ < 5 ? 'window-id' : undefined),
    };
    acquireDaemonState(root, makeState(deadPid, 'window-id'), { startId: () => undefined });
    const code = await daemonCommandMain('stop', 7860, {
      dataRoot: root,
      probe,
      stopBudgetMs: 60, // 优雅预算收短 → 快速踩进升格路
      pollIntervalMs: 50,
    });
    expect(code).toBe(0);
    expect(out.join('')).toContain('SIGKILL 强停');
    expect(existsSync(daemonStatePath(root))).toBe(false);
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

describe('daemonForegroundMain 装配失败路（复盘 #55 回归锁）', () => {
  it('createRuntime 抛错：daemon.json 先释放再抛——不残留指向已死进程', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-fg-'));
    const prevDb = process.env['APP_DB_PATH'];
    // 库路径指到目录：SQLite 开库即炸——装配期抛错形状（官方行 refuseBoot 同类）
    process.env['APP_DB_PATH'] = root;
    try {
      await expect(daemonForegroundMain(7861, { dataRoot: root })).rejects.toThrow();
      // 修复前红：acquire 已写、常驻 try 域未进——态文件残留，窗口内 status/
      // attach 误报在场（下次 start 才靠 sweep 判死清扫自愈）
      expect(existsSync(daemonStatePath(root))).toBe(false);
    } finally {
      if (prevDb === undefined) delete process.env['APP_DB_PATH'];
      else process.env['APP_DB_PATH'] = prevDb;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* 裸 berry 检测（刀二——真握手为唯一正判；token 只读禁 ensure）          */
/* ------------------------------------------------------------------ */

describe('detectDaemonHandshake：daemon.json 在场才探 + 真握手正判', () => {
  it('无 daemon.json / token 缺失 → undefined，且**不造 token 文件**（只读律）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-detect-'));
    const probeStatusCalls: string[] = [];
    const spyProbe = async (url: string) => {
      probeStatusCalls.push(url);
      return 200;
    };
    // 无 daemon.json：零探测零副作用
    expect(await detectDaemonHandshake({ dataRoot: root, probeStatus: spyProbe })).toBeUndefined();
    expect(probeStatusCalls).toEqual([]);
    // 有 state 无 token：401 面非活证——仍 undefined，且不 ensure 造文件
    acquireDaemonState(root, makeState(111, 'det-a'), { startId: () => undefined });
    expect(await detectDaemonHandshake({ dataRoot: root, probeStatus: spyProbe })).toBeUndefined();
    expect(existsSync(daemonTokenPath(root))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('真握手 200 = 唯一正判（带只读 token）；401 / 探败 = undefined（照常起进程内形态）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-detect-'));
    // 注意 makeState 第三参是 heldSessions 非 port——port 覆盖须整对象直造
    acquireDaemonState(
      root,
      { pid: 222, processStartId: 'det-b', bootId: 'boot-b', port: 7777, heldSessions: [] },
      { startId: () => undefined },
    );
    writeFileSync(daemonTokenPath(root), 'det-token');
    let answer: number | undefined = 200;
    const seen: { url: string; headers: Readonly<Record<string, string>> }[] = [];
    const spyProbe = async (url: string, headers: Readonly<Record<string, string>>) => {
      seen.push({ url, headers });
      return answer;
    };
    expect(await detectDaemonHandshake({ dataRoot: root, probeStatus: spyProbe })).toEqual({ port: 7777 });
    // Bearer 只读 token 真随行（正判判据 = 真握手非裸探活）
    expect(seen[0]!.url).toBe('http://127.0.0.1:7777/api/sessions');
    expect(seen[0]!.headers['authorization']).toBe('Bearer det-token');
    answer = 401; // token 不符（轮换竞窗）——非活证
    expect(await detectDaemonHandshake({ dataRoot: root, probeStatus: spyProbe })).toBeUndefined();
    answer = undefined; // 连不上（stale/僵尸）——非活证
    expect(await detectDaemonHandshake({ dataRoot: root, probeStatus: spyProbe })).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/* probeStatus 实测：应答头即回（SSE 等长流不挂到超时）                  */
/* ------------------------------------------------------------------ */

describe('probeStatus：headers-arrive-immediate 探针（daemon.ts 实码）', () => {
  it('SSE 等长流端点（永不 end）→ 状态码即收、不断挂——远快于超时上帽', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ping\n\n'); // 写一帧即悬住——永不 end（等长流形态）
      // 故意不 end 不 close：本探针必须靠自己收场
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const startedAt = Date.now();
    const status = await probeStatus(`http://127.0.0.1:${port}/api/events`, {}, 2_000);
    const elapsed = Date.now() - startedAt;
    expect(status).toBe(200);
    expect(elapsed).toBeLessThan(1_500); // 应答头即回——不是等 2s 超时兜底
    // 连接已由探针自断（server 可干净关停）
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 10_000);

  it('端口无监听 → undefined（连接失败与探败同面）', async () => {
    // 先占后放一个端口，保证关闭后瞬时无人监听
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probeStatus(`http://127.0.0.1:${port}/api/events`, {}, 500)).toBeUndefined();
  });

  it('半截应答头慢滴流（TCP 级只写半行头即隔秒滴字节）→ 总 deadline 到点探败（遗漏大扫 20260902-b #6——修前 socket idle 恒被滴字节重置、response 事件永不至、探针永挂）', async () => {
    // 纯 TCP server 绕开 node:http 服务端解析：连接一建立就写半截状态行，
    // 之后每 120ms 滴一字节——客户端头块永不完整（\r\n\r\n 永不出现）
    // 在册 socket 集（net.Server 无 closeAllConnections——收尾手动销毁）
    const socks = new Set<import('node:net').Socket>();
    const server = createTcpServer((sock) => {
      socks.add(sock);
      sock.on('close', () => socks.delete(sock));
      sock.write('HTTP/1.1 200 OK\r\n');
      const drip = setInterval(() => {
        // 守卫：探针 abort 摧毁连接后 socket 已死——写已死 fd 逃 EPIPE（竞速窗）
        if (sock.destroyed) {
          clearInterval(drip);
          return;
        }
        sock.write('x');
      }, 120);
      sock.on('close', () => clearInterval(drip));
      // 吸收对端 abort 后的迟到写错（EPIPE 等）——滴流服务端无错可报
      sock.on('error', () => clearInterval(drip));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const startedAt = Date.now();
    // 看门狗竞速：修前探针永挂、看门狗先到即红（'WATCHDOG' 字面直证挂死）
    const out = await Promise.race([
      probeStatus(`http://127.0.0.1:${port}/api/events`, {}, 600),
      new Promise<'WATCHDOG'>((resolve) => setTimeout(() => resolve('WATCHDOG'), 3_000)),
    ]);
    expect(out).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(2_500); // 总 deadline ~600ms 收场非看门狗
    for (const sock of socks) sock.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 10_000);
});

describe('httpProbe：三腿探活（daemon.ts 实码——start/stop/doctor 三处生产缺省，复盘 #33）', () => {
  it('正常腿：200 收体（status + body 双值——start gate 的正判形状）', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]'); // 真形状：GET /api/sessions 裸数组直出
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const out = await httpProbe(`http://127.0.0.1:${port}/api/sessions`, { authorization: 'Bearer t' }, 2_000);
    expect(out).toEqual({ status: 200, body: '[]' });
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 10_000);

  it('超时腿：服务端悬住不应答 → 超时销毁收场 undefined（非即抛）', async () => {
    const server = createServer(() => {
      // 收下请求即悬住——不写头不应答（探针必须靠自身超时收场）
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const startedAt = Date.now();
    expect(await httpProbe(`http://127.0.0.1:${port}/api/sessions`, {}, 150)).toBeUndefined();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140); // 等满超时窗（毫秒抖动容差）
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 10_000);

  it('连接拒腿：端口无监听 → undefined（与超时同面——start 判死路）', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await httpProbe(`http://127.0.0.1:${port}/api/sessions`, {}, 500)).toBeUndefined();
  });

  it('慢滴流应答者（写头后隔秒滴字节、永不 end）→ 总 deadline 到点收场 undefined（遗漏大扫 20260902-b #6——修前 socket idle 恒被滴字节重置、超时永不至、探针永挂）', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // 每 120ms 滴一字节（< 600ms 超时）——idle 计时器恒重置；永不 end
      const drip = setInterval(() => {
        // 守卫：探针 abort 摧毁连接后写已死 res 逃 EPIPE（竞速窗）
        if (res.destroyed) {
          clearInterval(drip);
          return;
        }
        res.write('x');
      }, 120);
      res.on('close', () => clearInterval(drip));
      // 吸收对端 abort 后的迟到写错（EPIPE 等）——滴流服务端无错可报
      res.on('error', () => clearInterval(drip));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const startedAt = Date.now();
    // 看门狗竞速：修前探针永挂、看门狗先到即红（'WATCHDOG' 字面直证挂死）
    const out = await Promise.race([
      httpProbe(`http://127.0.0.1:${port}/api/sessions`, {}, 600),
      new Promise<'WATCHDOG'>((resolve) => setTimeout(() => resolve('WATCHDOG'), 3_000)),
    ]);
    expect(out).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(2_500); // 总 deadline ~600ms 收场非看门狗
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 10_000);
});

/* ------------------------------------------------------------------ */
/* doctor 十项体检（刀二——依赖注入假面；盘上事实真造真断）              */
/* ------------------------------------------------------------------ */

describe('daemon doctor：十项体检', () => {
  /** 体检前置盘面：活态 daemon.json + 0600 token + 真库文件（user_version 7） */
  function healthyRoot(): {
    root: string;
    dbFile: string;
    probe: ProcessProbe;
  } {
    const root = mkdtempSync(join(tmpdir(), 'daemon-doc-'));
    const dbFile = join(root, 'sessions.db');
    const db = new Database(dbFile);
    db.pragma('user_version = 7'); // 迁移链终点之外任意值——披露面断言锚
    db.close();
    ensureDaemonToken(root); // 0600 落盘（生产写方——doctor 只读）
    acquireDaemonState(root, makeState(777, 'doc-alive'), { startId: () => undefined });
    const probe: ProcessProbe = { startId: (pid) => (pid === 777 ? 'doc-alive' : undefined) };
    return { root, dbFile, probe };
  }

  /** 体检常用假探针：health 200 带 version、握手与 events 可脚本化 */
  function httpFaces(over: { healthBody?: string; handshake?: number; events?: number } = {}) {
    const healthBody = over.healthBody ?? JSON.stringify({ version: VERSION });
    return {
      probeHttp: async () => ({ status: 200, body: healthBody }),
      probeStatus: async (url: string) =>
        url.includes('/api/sessions') ? (over.handshake ?? 200) : (over.events ?? 200),
    };
  }

  it('无 daemon.json → 提示 + 1（不进体检）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-doc-'));
    const out = captureStdout();
    expect(await daemonDoctorMain({ dataRoot: root })).toBe(1);
    expect(out.join('')).toContain('daemon 未运行');
    rmSync(root, { recursive: true, force: true });
  });

  it('全绿：①-⑥ 全过 + 判活路不探端口 → 0；token 文件零触碰（doctor 只读）', async () => {
    const { root, dbFile, probe } = healthyRoot();
    let portProbed = 0;
    const out = captureStdout();
    const code = await daemonDoctorMain({
      dataRoot: root,
      dbFile,
      probe,
      ...httpFaces(),
      portProbe: async () => {
        portProbed += 1;
        return false;
      },
    });
    const text = out.join('');
    expect(code).toBe(0);
    expect(text).toContain('十项全绿');
    expect(text).toContain('pid 777 存活');
    expect(text).toContain('真握手 200');
    expect(text).toContain('user_version 7'); // ④ 披露迁移位
    expect(text).toContain(`对齐（运行 ${VERSION} = 磁上 ${VERSION}`); // ⑥ 对齐
    // ⑧ 键缺席形态（httpFaces 缺省不带 writeBehind）：如实注记不转红
    expect(text).toContain('⑧ 落盘闩态：health 未携带 writeBehind');
    // ⑩ 同款键缺席形态（缺省不带 memory）：旧版 daemon 注记不转红（基建大扫 #49）
    expect(text).toContain('⑩ 内存：health 未携带 memory');
    expect(portProbed).toBe(0); // 判活路不探端口（⑦ 仅判死路）
    expect(existsSync(daemonTokenPath(root))).toBe(true); // 零 ensure 重写
    rmSync(root, { recursive: true, force: true });
  });

  it('② 真握手 401 = token 不符专文案 + 处置指引（stop 后 start 重签发）', async () => {
    const { root, dbFile, probe } = healthyRoot();
    const out = captureStdout();
    const code = await daemonDoctorMain({
      dataRoot: root,
      dbFile,
      probe,
      ...httpFaces({ handshake: 401 }),
    });
    expect(code).toBe(1);
    const text = out.join('');
    expect(text).toContain('401——盘上 token 与运行中 daemon 持有不符');
    expect(text).toContain('重签发');
    rmSync(root, { recursive: true, force: true });
  });

  it('⑧ 落盘闩态：writeBehind.paused=true → ⑧ 红（瞬态文案）+ ⑨ 两数披露 + 退出 1（基建大扫 #27）', async () => {
    const { root, dbFile, probe } = healthyRoot();
    const out = captureStdout();
    const code = await daemonDoctorMain({
      dataRoot: root,
      dbFile,
      probe,
      ...httpFaces({
        healthBody: JSON.stringify({ version: VERSION, writeBehind: { paused: true, sessions: 2, events: 5 } }),
      }),
    });
    expect(code).toBe(1);
    const text = out.join('');
    expect(text).toContain('✗ ⑧ 落盘闩态：瞬态暂停');
    // ⑨ 积压两数绿披露（不转红）
    expect(text).toContain('⑨ 积压：待写会话 2 / 事件 5');
    rmSync(root, { recursive: true, force: true });
  });

  it('⑧×degraded 组合判读：两者并到 = 恒败中文案；仅 paused 无 degraded = 瞬态', async () => {
    // degraded（cordon 组合根闩）+ paused 并到 → 恒败中
    const { root, dbFile, probe } = healthyRoot();
    const both = captureStdout();
    await daemonDoctorMain({
      dataRoot: root,
      dbFile,
      probe,
      ...httpFaces({
        healthBody: JSON.stringify({
          version: VERSION,
          degraded: 'persistence',
          writeBehind: { paused: true, sessions: 1, events: 3 },
        }),
      }),
    });
    expect(both.join('')).toContain('恒败中（自动重试暂停且 cordon 已闩');
    rmSync(root, { recursive: true, force: true });
    // degraded 在场 + paused=false → 已复流但 cordon 仍闩（⑧ 绿——cordon 红在 ②）
    const { root: r2, dbFile: db2, probe: p2 } = healthyRoot();
    const recovered = captureStdout();
    await daemonDoctorMain({
      dataRoot: r2,
      dbFile: db2,
      probe: p2,
      ...httpFaces({
        healthBody: JSON.stringify({
          version: VERSION,
          degraded: 'persistence',
          writeBehind: { paused: false, sessions: 0, events: 0 },
        }),
      }),
    });
    const recText = recovered.join('');
    expect(recText).toContain('✓ ⑧ 落盘闩态：已复流但 cordon 仍闩');
    expect(recText).toContain('✗ ②'); // degraded 使 ② 红（cordon 本红位）
    rmSync(r2, { recursive: true, force: true });
  });

  it('② events 503 计红（基建大扫 #9）：帽满 = 服务面真实降级，不再「注记而全绿」', async () => {
    const { root, dbFile, probe } = healthyRoot();
    const out = captureStdout();
    const code = await daemonDoctorMain({
      dataRoot: root,
      dbFile,
      probe,
      ...httpFaces({ events: 503 }), // health/handshake 全 200、唯事件流帽满
    });
    expect(code).toBe(1); // 修前红：旧形 events 不参与 ok 判定 → code 0 假绿
    const text = out.join('');
    expect(text).toContain('16 连接帽满');
    expect(text).not.toContain('十项全绿'); // 总结行与注记不再自相矛盾
    rmSync(root, { recursive: true, force: true });
  });

  it('② health.degraded 在场 = 红项（基建大扫 #25 cordon）：降级如实报出带处置指引', async () => {
    const { root, dbFile, probe } = healthyRoot();
    const out = captureStdout();
    const code = await daemonDoctorMain({
      dataRoot: root,
      dbFile,
      probe,
      ...httpFaces({ healthBody: JSON.stringify({ version: VERSION, degraded: 'persistence' }) }),
    });
    expect(code).toBe(1); // 修前红：旧形 parse degraded 却零消费 → 全绿 0
    const text = out.join('');
    expect(text).toContain('persistence'); // 降级原因披露
    expect(text).toContain('cordon'); // 处置指引（stop 后 start / 查 daemon.log）
    rmSync(root, { recursive: true, force: true });
  });

  it('② obs.ingesting=false = 红项（成熟度扫描 20260901 P1-11）：观测停摄取判读 + 处置指引；键缺席不报红', async () => {
    const { root, dbFile, probe } = healthyRoot();
    const out = captureStdout();
    const code = await daemonDoctorMain({
      dataRoot: root,
      dbFile,
      probe,
      // 观测健康键（独立于 degraded——语义分立裁决：纯派生数据损失 ≠ 持久层闩死）
      ...httpFaces({
        healthBody: JSON.stringify({ version: VERSION, obs: { ingesting: false, lastFlushAt: 1_700_000_000_000 } }),
      }),
    });
    expect(code).toBe(1); // 修前红：旧形不消费 obs 键 → 全绿 0（daemon 常驻数日不察）
    const text = out.join('');
    expect(text).toContain('摄取已停'); // 停态判读
    expect(text).toContain('纯派生库'); // 处置指引（删 rollup.db 重建——warn 文案同源）
    rmSync(root, { recursive: true, force: true });
    // 键缺席（obs 行未装/重装窗）≠ 停摆——不报红（「无信息」不冒充判读）
    const out2 = captureStdout();
    const { root: root2, dbFile: dbFile2, probe: probe2 } = healthyRoot();
    const code2 = await daemonDoctorMain({
      dataRoot: root2,
      dbFile: dbFile2,
      probe: probe2,
      ...httpFaces(), // health 不带 obs 键
    });
    expect(code2).toBe(0);
    expect(out2.join('')).not.toContain('摄取已停');
    rmSync(root2, { recursive: true, force: true });
  });

  it('⑩ 内存披露（基建大扫 #49）：health 携带 memory 键 → MB 取整披露 + 不转红', async () => {
    const { root, dbFile, probe } = healthyRoot();
    const out = captureStdout();
    // rss 150 MiB / 堆 40 MiB / 存活 2 时 5 分——取整与时长人读化的断言锚
    const healthBody = JSON.stringify({
      version: VERSION,
      memory: { rss: 157_286_400, heapUsed: 41_943_040, uptimeMs: 7_500_000 },
    });
    const code = await daemonDoctorMain({
      dataRoot: root,
      dbFile,
      probe,
      ...httpFaces({ healthBody }),
    });
    expect(code).toBe(0); // 信息项恒 ok（与 ⑤log 大小同款非执法）
    const text = out.join('');
    expect(text).toContain('⑩ 内存：RSS 150 MB / 堆 40 MB（存活 2 时 5 分）');
    expect(text).toContain('十项全绿');
    rmSync(root, { recursive: true, force: true });
  });

  it('体检对象优先 daemon.json 记录值（基建大扫 #6）：dataRoot/dbPath 落账 → env 分叉不脱钩 + 对账披露', async () => {
    // 发现面 rootA：只有 daemon.json（带记录键）；记录面 rootB：真 token + 真库
    const rootA = mkdtempSync(join(tmpdir(), 'daemon-doc-'));
    const rootB = mkdtempSync(join(tmpdir(), 'daemon-doc-'));
    const dbFileB = join(rootB, 'sessions.db');
    const db = new Database(dbFileB);
    db.pragma('user_version = 7');
    db.close();
    ensureDaemonToken(rootB); // 0600 token 落在**记录面**——env 面 rootA 无 token
    acquireDaemonState(
      rootA,
      { ...makeState(777, 'rec-alive'), dataRoot: rootB, dbPath: dbFileB },
      { startId: () => undefined },
    );
    const probe: ProcessProbe = { startId: (pid) => (pid === 777 ? 'rec-alive' : undefined) };
    const out = captureStdout();
    const code = await daemonDoctorMain({ dataRoot: rootA, probe, ...httpFaces() });
    expect(code).toBe(0); // 修前红：旧形按 env 面体检 → ③ token 缺失 + ④ 库开不出 = 1
    const text = out.join('');
    expect(text).toContain('十项全绿');
    expect(text).toContain('按 daemon.json 记录值'); // 对账披露行（env 分叉如实报出）
    expect(text).toContain(rootB); // 记录值路径进披露
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  it('②′ 僵尸态：pid 活但 HTTP 面全无响应 → 专项红行', async () => {
    const { root, dbFile, probe } = healthyRoot();
    const out = captureStdout();
    const code = await daemonDoctorMain({
      dataRoot: root,
      dbFile,
      probe,
      probeHttp: async () => undefined, // health 无响应
      probeStatus: async () => undefined, // 握手/事件流全连不上
    });
    expect(code).toBe(1);
    expect(out.join('')).toContain('僵尸态嫌疑');
    rmSync(root, { recursive: true, force: true });
  });

  it('③ token 缺失 = 红且**不造文件**（判活时只读禁 ensure）；权限漂移 0644 = chmod 指引', async () => {
    const { root, dbFile, probe } = healthyRoot();
    rmSync(daemonTokenPath(root));
    let out = captureStdout();
    let code = await daemonDoctorMain({ dataRoot: root, dbFile, probe, ...httpFaces({ handshake: 401 }) });
    expect(code).toBe(1);
    expect(out.join('')).toContain('③ token：缺失');
    expect(existsSync(daemonTokenPath(root))).toBe(false); // doctor 不 ensure
    // 权限漂移面
    ensureDaemonToken(root);
    chmodSync(daemonTokenPath(root), 0o644);
    out = captureStdout();
    code = await daemonDoctorMain({ dataRoot: root, dbFile, probe, ...httpFaces() });
    expect(code).toBe(1);
    expect(out.join('')).toContain('chmod 600');
    rmSync(root, { recursive: true, force: true });
  });

  it('④ 会话库开不出来（路径不存在 readonly 拒造）= 红行', async () => {
    const { root, probe } = healthyRoot();
    const out = captureStdout();
    const code = await daemonDoctorMain({
      dataRoot: root,
      dbFile: join(root, 'no-such-dir', 'no-such.db'),
      probe,
      ...httpFaces(),
    });
    expect(code).toBe(1);
    expect(out.join('')).toContain('④ 会话库：readonly 开启失败');
    rmSync(root, { recursive: true, force: true });
  });

  it('⑥ 版本漂移（升级未重启）：health.version ≠ 磁上 CLI = 红行带换新指引', async () => {
    const { root, dbFile, probe } = healthyRoot();
    const out = captureStdout();
    const code = await daemonDoctorMain({
      dataRoot: root,
      dbFile,
      probe,
      ...httpFaces({ healthBody: JSON.stringify({ version: '0.0.0-old' }) }),
    });
    expect(code).toBe(1);
    const text = out.join('');
    expect(text).toContain('漂移（运行 0.0.0-old');
    expect(text).toContain('stop 后 start 换新');
    rmSync(root, { recursive: true, force: true });
  });

  it('⑦ 判死路：pid 死 + 端口有监听者 = 顶号红行；端口空闲 = 绿行一致收场', async () => {
    const { root, dbFile } = healthyRoot();
    const deadProbe: ProcessProbe = { startId: () => undefined }; // 持有者判死
    const out = captureStdout();
    const code = await daemonDoctorMain({
      dataRoot: root,
      dbFile,
      probe: deadProbe,
      ...httpFaces({ handshake: undefined }),
      portProbe: async (port) => port === 7860,
    });
    expect(code).toBe(1);
    const text = out.join('');
    expect(text).toContain('pid 777 已死');
    expect(text).toContain('7860 仍有监听者');
    expect(text).toContain('lsof -i :7860');
    // 端口空闲：⑦ 绿（① 仍红——两项红计数不影响本断言面）
    out.length = 0;
    await daemonDoctorMain({
      dataRoot: root,
      dbFile,
      probe: deadProbe,
      ...httpFaces({ handshake: undefined }),
      portProbe: async () => false,
    });
    expect(out.join('')).toContain('⑦ 端口：7860 无监听者');
    rmSync(root, { recursive: true, force: true });
  });

  it('⑤ 日志信息项：daemon.log 缺席恒绿不计红', async () => {
    const { root, dbFile, probe } = healthyRoot();
    const out = captureStdout();
    const code = await daemonDoctorMain({ dataRoot: root, dbFile, probe, ...httpFaces() });
    expect(code).toBe(0);
    expect(out.join('')).toContain('⑤ 日志：daemon.log 缺席（未 boot 过——信息项不计红）');
    rmSync(root, { recursive: true, force: true });
  });

  it('⑤ 日志体检帽（基建大扫 #51）：>50 MiB 转红带轮转指引；帽下绿披露（含轮转帽 10 MiB 之上、体检帽之下的中间带）', async () => {
    const { root, dbFile, probe } = healthyRoot();
    mkdirSync(join(root, 'daemon'), { recursive: true });
    // 超 50 MiB 体检帽 → 红行 + 处置指引（stop 后 start 触发轮转）
    writeFileSync(join(root, 'daemon', 'daemon.log'), Buffer.alloc(50 * 1024 * 1024 + 1, 0x61));
    let out = captureStdout();
    let code = await daemonDoctorMain({ dataRoot: root, dbFile, probe, ...httpFaces() });
    expect(code).toBe(1);
    expect(out.join('')).toContain('超 50 MiB 体检帽');
    expect(out.join('')).toContain('stop');
    // 中间带（10 MiB 轮转帽之上、50 MiB 体检帽之下）→ 绿披露（轮转只在 start 时点执法，体检不越权代转）
    writeFileSync(join(root, 'daemon', 'daemon.log'), Buffer.alloc(10 * 1024 * 1024, 0x61));
    out = captureStdout();
    code = await daemonDoctorMain({ dataRoot: root, dbFile, probe, ...httpFaces() });
    expect(code).toBe(0);
    expect(out.join('')).toContain('⑤ 日志：daemon.log 10.0 MiB');
    rmSync(root, { recursive: true, force: true });
  });
});

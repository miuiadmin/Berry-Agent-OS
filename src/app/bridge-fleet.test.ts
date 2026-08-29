/**
 * app — worker 域舰队端到端测试（契约篇 §1.7 K3-c，第二十七批刀二）。
 *
 * 真 worker_threads 子进程（同 bootstrap.test.ts 模式：execArgv [--import=tsx]
 * 直跑 TS 源）+ 真 ctx 作用域——不 mock bridge/fleet 任何内部，只对 fleet 消费
 * 的 markFailed 注入物用记录桩（AppsService 的结构面）。bootstrap.test.ts
 * 已覆盖机制面（桥协议/域死回卷/工具桥接）；本文件聚焦**装配编舞语义**：
 * 每行一域路由 / 装机计数 / reapUnapplied 防漏 / terminateAll 收编 /
 * 意外死亡结算（markFailed 回写 + app/failed 广播）/ 装载失败防漏。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContext } from '../context/context.js';
import type { ContextScope } from '../context/types.js';
import type { AppPlanRow } from '../contracts/app.js';
import {
  APP_LOAD_FAILED,
  BRIDGE_HANDLER_FAILED,
  BRIDGE_WORKER_EXITED,
  COMPOSITION_ROW_INVALID,
} from '../contracts/errors.js';
import type { SandboxService } from '../safety/index.js';
import { appDataDirOf } from './composition.js';
import { createBridgeFleet } from './bridge-fleet.js';

/* ---------------- 测试基建 ---------------- */

/** 真 worker 子进程入口：bridge 模块的 worker.ts（vitest 下 import.meta.url 指源文件） */
const WORKER_URL = new URL('../bridge/worker.ts', import.meta.url);

/** fleet fixture 应用：provide 一个 ping 服务（名按 config.slot 参数化防串扰）；
 * burn 真死循环（心跳 watchdog 用——事件循环冻结后结构性不可协作取消）；
 * config.crash 真 → apply 返还后异步抛 uncaught（worker 线程崩 = 自崩溃最真形态
 * ——fleet 不暴露域句柄，直杀不可达；uncaught 异步异常默认终结 worker 线程） */
const FX_PLUGIN = `
export const name = 'fleet-fx';
export default async function apply(ctx, config) {
  ctx.provide('fleet/taps-' + config.slot, {
    ping: () => 'pong',
    burn: () => { while (true) {} },
  });
  if (config.crash) setTimeout(() => { throw new Error('模拟 worker 自崩溃'); }, 10);
}
`;

/** apply 即抛 fixture（apply 失败防漏路：行进失败清单 + 域即刻刻意收尾不留孤儿） */
const FX_APPLY_THROW = `
export const name = 'fleet-fx-throw';
export default async function apply() { throw new Error('boom-on-purpose'); }
`;

/** 慢启 fixture：模块体同步占线 300ms（装载求值期占死 worker 事件循环——
 * pong 无应答即丢拍）。心跳监督只在装载成功后武装（boot 期超时归
 * loadTimeoutMs 司职）——本 fixture 即「boot 不武装」回归锁：慢装载
 * 不得被 watchdog 误杀（慢机杀好域，全量套件负载下实测翻车形态） */
const FX_SLOW_BOOT = `
export const name = 'fleet-slow-boot';
const busyUntil = Date.now() + 300;
while (Date.now() < busyUntil) {}
export default async function apply(ctx, config) {
  ctx.provide('fleet/taps-' + config.slot, { ping: () => 'pong' });
}
`;

/** OOM fixture（观测锚⑤ 回归锁）：grow 无界分配 V8 old-space——48MB 堆上限
 * 触顶即 worker 'error' 事件（"Worker terminated due to reaching memory
 * limit" 签名）+ exit code 1（probe-oom.mjs 实证：与普通崩溃同码，签名是
 * 唯一判据——归因面不得依赖 exit code） */
const FX_OOM = `
export const name = 'fleet-oom';
export default async function apply(ctx, config) {
  ctx.provide('fleet/taps-' + config.slot, {
    grow: () => {
      const junk = [];
      for (;;) junk.push(new Array(100_000).fill('x'));
    },
  });
}
`;

/** 轮询直到谓词为真（死亡结算等异步到达面的确定性等待；谓词可同步可异步） */
async function until(predicate: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect.unreachable(`轮询超时（${ms}ms）——异步面未到达`);
}

/** 起一次 fixture 环境（临时目录 + 应用文件 + 真 ctx/锚） */
function setupFixture(name: string): { root: ContextScope; anchor: ContextScope; fxEntry: string; dir: string } {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'fleet-')));
  const fxEntry = join(dir, 'fx-fleet.ts');
  writeFileSync(fxEntry, FX_PLUGIN);
  const root = createContext({ name });
  return { root, anchor: root.fork({ name: `${name}:anchor` }), fxEntry, dir };
}

/** 取 reject 的错误码（非带码 Error 抛原值让用例失败显形） */
async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  const err = (await promise.then(
    () => {
      throw new Error('预期 reject，实际 resolve');
    },
    (e: unknown) => e,
  )) as { code?: string };
  return typeof err?.code === 'string' ? err.code : 'NO_CODE';
}

/* ---------------- 用例 ---------------- */

describe('createBridgeFleet — 装配编舞（真 worker 子进程）', () => {
  it('terminateZone 谓词 = 独占该区：只收 apps 恰 [该 app] 的域——跨区行与系统相位行不动（D3 单区 reload 回归锁）', async () => {
    const { root, anchor, fxEntry, dir } = setupFixture('fleet-zone');
    const fleet = createBridgeFleet({
      root,
      anchor: () => anchor,
      workerUrl: WORKER_URL,
      execArgv: ['--import=tsx'],
    });
    // 三行三态：独占（apps:[a]）/ 跨区（apps:[a,b]——共享件）/ 系统相位（无 apps）
    const rows: AppPlanRow[] = [
      { id: 'solo', entry: fxEntry, apps: ['a'], sandbox: { carrier: 'worker' }, config: { slot: 'solo' } },
      { id: 'shared', entry: fxEntry, apps: ['a', 'b'], sandbox: { carrier: 'worker' }, config: { slot: 'shared' } },
      { id: 'sysrow', entry: fxEntry, sandbox: { carrier: 'worker' }, config: { slot: 'sysrow' } },
    ];
    for (const row of rows) {
      await fleet.loader.load(row);
      const scope = anchor.fork({ name: row.id, rowId: row.id, builtinRow: false });
      await fleet.loader.apply(row, scope);
    }
    expect(fleet.stats()).toMatchObject({ spawned: 3, live: 3 });
    const solo = root.get<Record<string, () => Promise<string>>>('fleet/taps-solo');
    const shared = root.get<Record<string, () => Promise<string>>>('fleet/taps-shared');
    const sysrow = root.get<Record<string, () => Promise<string>>>('fleet/taps-sysrow');

    // 单区收编 app:a：只收 solo（跨区 shared 与系统相位 sysrow 的 zone 列都不等）
    expect(fleet.terminateZone('app:a', '测试单区收编')).toBe(1);
    await until(() => root.tryGet('fleet/taps-solo') === undefined); // solo 域死回卷
    await expect(shared.ping!()).resolves.toBe('pong'); // 跨区行域活（不动它影响别人）
    await expect(sysrow.ping!()).resolves.toBe('pong'); // 系统相位行域活
    expect(fleet.stats()).toMatchObject({ live: 2, terminated: 1 });

    // 未知区收编 = 0（空区路径合法——该区无分域行）
    expect(fleet.terminateZone('app:nobody', '测试空区')).toBe(0);

    await fleet.terminateAll('测试收尾');
    await root.dispose().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('装载生命线：每行一域路由 + 装机计数 + reapUnapplied 只清未应用 + terminateAll 全收', async () => {
    const { root, anchor, fxEntry, dir } = setupFixture('fleet-life');
    const fleet = createBridgeFleet({
      root,
      anchor: () => anchor,
      workerUrl: WORKER_URL,
      execArgv: ['--import=tsx'],
    });
    // 行 r1：完整 load+apply（宿主物化 provide 服务）
    await fleet.loader.load({ id: 'r1', entry: fxEntry, sandbox: { carrier: 'worker' } });
    const scope1 = anchor.fork({ name: 'r1', rowId: 'r1', builtinRow: false });
    await fleet.loader.apply(
      { id: 'r1', entry: fxEntry, sandbox: { carrier: 'worker' }, config: { slot: 'a' } },
      scope1,
    );
    // 行 r2：只 load 不 apply（模拟 Kahn 零进展残留——孤儿域待清割）
    await fleet.loader.load({ id: 'r2', entry: fxEntry, sandbox: { carrier: 'worker' } });

    // 每行一域：两行两次 spawn、都在册
    expect(fleet.stats()).toMatchObject({ spawned: 2, live: 2 });
    // r1 服务真过桥（域活 + provide 物化）
    const taps = root.get<Record<string, () => Promise<string>>>('fleet/taps-a');
    await expect(taps.ping!()).resolves.toBe('pong');

    // 清割未应用域：r2 收编、r1 不动
    expect(fleet.reapUnapplied('测试清割')).toBe(1);
    expect(fleet.stats().live).toBe(1);
    await expect(taps.ping!()).resolves.toBe('pong'); // r1 域未受清割影响

    // 全域刻意收编：服务随域死不可达（BRIDGE_WORKER_EXITED 结算）
    expect(fleet.terminateAll('测试收尾')).toBe(1);
    await until(() => root.tryGet('fleet/taps-a') === undefined); // 域死回卷收走 provide
    expect(fleet.stats()).toMatchObject({ live: 0, terminated: 2 }); // r2 清割 + r1 收编
    await root.dispose().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('死亡结算与装载失败防漏：意外死亡 → markFailed 回写 + app/failed 广播；坏 entry → 域即刻收尾', async () => {
    const { root, anchor, fxEntry, dir } = setupFixture('fleet-death');
    /** markFailed 注入物记录桩（AppsService 结构面——状态回写语义的被测出口） */
    const marked: Array<{ id: string; code: string; message: string }> = [];
    /** app/failed 广播记录（anchor 上真 on 订阅——fleet 死亡结算的词汇面） */
    const broadcast: Array<{ id: string; code?: string; message?: string }> = [];
    anchor.on('app/failed', (payload: { id: string; code?: string; message?: string }) => broadcast.push(payload));
    const fleet = createBridgeFleet({
      root,
      anchor: () => anchor,
      workerUrl: WORKER_URL,
      execArgv: ['--import=tsx'],
      markFailed: (id, code, message) => marked.push({ id, code, message }),
    });
    // 行 w1 装载自崩应用（apply 返还后 uncaught 异步异常 → worker 线程自崩溃）
    await fleet.loader.load({ id: 'w1', entry: fxEntry, sandbox: { carrier: 'worker' } });
    const scope1 = anchor.fork({ name: 'w1', rowId: 'w1', builtinRow: false });
    await fleet.loader.apply(
      { id: 'w1', entry: fxEntry, sandbox: { carrier: 'worker' }, config: { slot: 'd', crash: true } },
      scope1,
    );

    // worker 自崩溃（意外死亡：非 terminate 编舞终点、非 kill 执法）
    await until(() => marked.length > 0 && broadcast.length > 0);
    // 状态回写：行 w1 以 BRIDGE_WORKER_EXITED 转 failed（fleet 的 markFailed 注入物）
    expect(marked[0]).toMatchObject({ id: 'w1', code: BRIDGE_WORKER_EXITED });
    // 广播词汇：与装载失败同一观测词汇（宁可死得响亮）
    expect(broadcast[0]).toMatchObject({ id: 'w1', code: BRIDGE_WORKER_EXITED });
    // 诊断面终点（契约篇 §1.7 结算消息携带 diagnostic）：自崩溃第一手异常
    // （fixture 抛「模拟 worker 自崩溃」→ worker error 存档 → onExit.diagnostic）
    // 缀入结算消息直达 operator 可见面——广播与回写同一字符串同源
    expect(marked[0]!.message).toContain('模拟 worker 自崩溃');
    expect(broadcast[0]!.message).toContain('模拟 worker 自崩溃');
    // 归因计数：自崩溃（无执法归因）→ crashed 计 1、心跳面不动
    expect(fleet.stats()).toMatchObject({ live: 0, crashed: 1, heartbeatFreezes: 0 });

    // 坏 entry 装载失败防漏：load reject + 域即刻刻意收尾（不留孤儿进程）
    const badRow: AppPlanRow = { id: 'bad', entry: join(dir, 'nope.ts'), sandbox: { carrier: 'worker' } };
    await expect(fleet.loader.load(badRow)).rejects.toBeTruthy();
    expect(fleet.stats()).toMatchObject({ live: 0, terminated: 1 }); // 装载失败即收、不入册
    await root.dispose().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('apply 失败防漏：worker 侧 apply 抛错 → 行失败保码 + 域即刻刻意收尾（live 归零）', async () => {
    const { root, anchor, dir } = setupFixture('fleet-apply-throw');
    const throwEntry = join(dir, 'fx-throw.ts');
    writeFileSync(throwEntry, FX_APPLY_THROW);
    const fleet = createBridgeFleet({
      root,
      anchor: () => anchor,
      workerUrl: WORKER_URL,
      execArgv: ['--import=tsx'],
    });
    await fleet.loader.load({ id: 'b1', entry: throwEntry, sandbox: { carrier: 'worker' } });
    const scope = anchor.fork({ name: 'b1', rowId: 'b1', builtinRow: false });
    // worker 侧非 AppError 抛错 → 信封归一 BRIDGE_HANDLER_FAILED 保码回宿主
    expect(
      await rejectionCode(fleet.loader.apply({ id: 'b1', entry: throwEntry, sandbox: { carrier: 'worker' } }, scope)),
    ).toBe(BRIDGE_HANDLER_FAILED);
    // 防漏：行已失败，域不留（apply 失败即收——非等 reap）
    expect(fleet.stats()).toMatchObject({ live: 0, terminated: 1 });
    await root.dispose().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('心跳 watchdog：同步死循环冻结 → kill → 在途结算 + 归因心跳缺失 + heartbeatFreezes 计数（动机用例）', async () => {
    const { root, anchor, fxEntry, dir } = setupFixture('fleet-heartbeat');
    const marked: Array<{ id: string; code: string; message: string }> = [];
    const broadcast: Array<{ id: string; code?: string; message?: string }> = [];
    anchor.on('app/failed', (payload: { id: string; code?: string; message?: string }) => broadcast.push(payload));
    // 50ms 节律 × 2 拍 ≈ 100ms 判冻——紧密同步循环结构性不可协作取消，watchdog 兜底
    const fleet = createBridgeFleet({
      root,
      anchor: () => anchor,
      workerUrl: WORKER_URL,
      execArgv: ['--import=tsx'],
      heartbeatMs: 50,
      heartbeatMissLimit: 2,
      markFailed: (id, code, message) => marked.push({ id, code, message }),
    });
    await fleet.loader.load({ id: 'hb', entry: fxEntry, sandbox: { carrier: 'worker' } });
    const scope = anchor.fork({ name: 'hb', rowId: 'hb', builtinRow: false });
    await fleet.loader.apply(
      { id: 'hb', entry: fxEntry, sandbox: { carrier: 'worker' }, config: { slot: 'w' } },
      scope,
    );
    const taps = root.get<Record<string, () => Promise<string>>>('fleet/taps-w');
    // 域活证明（先 ping 后烧——排除「域从未活过」的假冻结）
    await expect(taps.ping!()).resolves.toBe('pong');
    // 点燃死循环：worker 事件循环冻结，ping 无应答。catch 立即挂接——kill 时
    // 端点 dispose 结算在途调用，早于本用例的断言面（防未处理拒绝）
    const inflight = taps.burn!().catch((e: unknown) => e);
    await until(() => marked.length > 0 && broadcast.length > 0);
    // kill 执法归因随结算透出（观测锚⑨「心跳超时」打点数据源）
    expect(marked[0]).toMatchObject({ id: 'hb', code: BRIDGE_WORKER_EXITED });
    expect(marked[0]!.message).toContain('心跳缺失');
    expect(broadcast[0]).toMatchObject({ id: 'hb', code: BRIDGE_WORKER_EXITED });
    // 在途 burn 调用按域死结算（watchdog kill → 端点 dispose → WORKER_EXITED）
    expect(((await inflight) as { code?: string }).code).toBe(BRIDGE_WORKER_EXITED);
    // 归因计数：执法路径计心跳冻结、不计 crashed（防双计）
    expect(fleet.stats()).toMatchObject({ heartbeatFreezes: 1, crashed: 0, live: 0 });
    await root.dispose().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('boot 不武装：装载期事件循环被模块求值占死 300ms → 不误杀（心跳只在装载成功后武装）', async () => {
    const { root, anchor, dir } = setupFixture('fleet-slow-boot');
    const slowEntry = join(dir, 'fx-slow.ts');
    writeFileSync(slowEntry, FX_SLOW_BOOT);
    /** 死亡结算记录（若误杀即非空——断言恒空） */
    const marked: Array<{ id: string; code: string; message: string }> = [];
    // 节律 50ms × 2 拍：装载若被心跳监督覆盖，150ms 即判冻杀域（模块占线
    // 300ms > 150ms 判冻窗）——修复前本用例在 await load 处即 reject
    const fleet = createBridgeFleet({
      root,
      anchor: () => anchor,
      workerUrl: WORKER_URL,
      execArgv: ['--import=tsx'],
      heartbeatMs: 50,
      heartbeatMissLimit: 2,
      markFailed: (id, code, message) => marked.push({ id, code, message }),
    });
    // 慢装载成功返还（boot 期超时归 loadTimeoutMs 60s 司职——50/100/150ms 的
    // 丢拍不是冻结：事件循环尚未承诺应答）
    await fleet.loader.load({ id: 'sb', entry: slowEntry, sandbox: { carrier: 'worker' } });
    const scope = anchor.fork({ name: 'sb', rowId: 'sb', builtinRow: false });
    await fleet.loader.apply(
      { id: 'sb', entry: slowEntry, sandbox: { carrier: 'worker' }, config: { slot: 'sb' } },
      scope,
    );
    const taps = root.get<Record<string, () => Promise<string>>>('fleet/taps-sb');
    await expect(taps.ping!()).resolves.toBe('pong');
    // 武装后正常运行：零误杀、零死亡结算、域活
    expect(marked).toHaveLength(0);
    expect(fleet.stats()).toMatchObject({ live: 1, heartbeatFreezes: 0, crashed: 0 });
    await root.dispose().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('OOM 归因（观测锚⑤）：堆超限死 → worker/oom 事件携 diagnostic 签名 + ooms 归因计数（probe-oom 实证形态）', async () => {
    const { root, anchor, dir } = setupFixture('fleet-oom');
    const oomEntry = join(dir, 'fx-oom.ts');
    writeFileSync(oomEntry, FX_OOM);
    /** 死亡结算记录（markFailed 注入物——OOM 域死走意外死亡全流程） */
    const marked: Array<{ id: string; code: string; message: string }> = [];
    /** worker/oom 事件记录（观测锚⑤ 事件面——签名归因的广播词汇） */
    const oomEvents: Array<{ rowId: string; workerId: string; diagnostic: string }> = [];
    anchor.on('worker/oom', (p: { rowId: string; workerId: string; diagnostic: string }) => oomEvents.push(p));
    const fleet = createBridgeFleet({
      root,
      anchor: () => anchor,
      workerUrl: WORKER_URL,
      execArgv: ['--import=tsx'],
      // 48MB 堆上限（probe-oom.mjs 实证档位：增长面秒级触顶，不拖慢套件）
      resourceLimits: { maxOldGenerationSizeMb: 48 },
      markFailed: (id, code, message) => marked.push({ id, code, message }),
    });
    await fleet.loader.load({ id: 'oom', entry: oomEntry, sandbox: { carrier: 'worker' } });
    const scope = anchor.fork({ name: 'oom', rowId: 'oom', builtinRow: false });
    await fleet.loader.apply(
      { id: 'oom', entry: oomEntry, sandbox: { carrier: 'worker' }, config: { slot: 'oom' } },
      scope,
    );
    const taps = root.get<Record<string, () => Promise<unknown>>>('fleet/taps-oom');
    // 点燃堆增长：V8 old-space 触顶 → worker 'error' 事件（内存超限签名）→ exit
    // code 1（与普通崩溃同码——签名是唯一判据）。catch 立即挂接（域死时在途
    // 调用按 WORKER_EXITED 结算，早于断言面）
    const inflight = taps.grow!().catch((e: unknown) => e);
    await until(() => marked.length > 0 && oomEvents.length > 0);
    // 意外死亡结算：BRIDGE_WORKER_EXITED 保码（宁可死得响亮）
    expect(marked[0]).toMatchObject({ id: 'oom', code: BRIDGE_WORKER_EXITED });
    // 诊断面终点（契约篇 §1.7 结算消息携带 diagnostic）：内存超限签名同样
    // 缀入结算消息——markFailed 回写即 operator 可见（不只知 code 1）
    expect(marked[0]!.message).toContain('reaching memory limit');
    // 观测锚⑤：diagnostic = worker error 事件原始错误（构造名: 消息），
    // 签名串「reaching memory limit」命中即内存超限归因（probe-oom 实证）
    expect(oomEvents[0]).toMatchObject({ rowId: 'oom', workerId: 'w:oom' });
    expect(oomEvents[0]!.diagnostic).toContain('reaching memory limit');
    // 在途 grow 按域死结算（WORKER_EXITED——非超时非取消）
    expect(((await inflight) as { code?: string }).code).toBe(BRIDGE_WORKER_EXITED);
    // 归因计数：意外死亡 crashed=1 且 ooms=1（crashed 的内存超限归因子集，
    // 维度正交——既计 crashed 又计 ooms）；心跳面不动
    expect(fleet.stats()).toMatchObject({ live: 0, crashed: 1, ooms: 1, heartbeatFreezes: 0 });
    await root.dispose().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('行级资源限映射（第三纵切 budget.memoryMb）：rowResourceLimits 按行命中优先于全局——钩子值真达 spawn（Node 原生执法）', async () => {
    const { root, anchor, dir } = setupFixture('fleet-row-oom');
    const oomEntry = join(dir, 'fx-oom.ts');
    writeFileSync(oomEntry, FX_OOM);
    /** 死亡结算记录（行限 48MB 触顶走意外死亡全流程——与全局限同一条链） */
    const marked: Array<{ id: string; code: string; message: string }> = [];
    const oomEvents: Array<{ rowId: string; workerId: string; diagnostic: string }> = [];
    anchor.on('worker/oom', (p: { rowId: string; workerId: string; diagnostic: string }) => oomEvents.push(p));
    const fleet = createBridgeFleet({
      root,
      anchor: () => anchor,
      workerUrl: WORKER_URL,
      execArgv: ['--import=tsx'],
      // 全局缺省刻意宽（512MB）：本用例只有行钩子命中才收紧——OOM 发生本身
      // 即证明钩子值到达 spawn（否则按全局 512MB 增长面跑不完）
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      // 应用内存预算真实形态：清单 components 串（plugin 引用）→ 行限映射
      rowResourceLimits: (row) => (row.pkg === 'acme/oomy' ? { maxOldGenerationSizeMb: 48 } : undefined),
      markFailed: (id, code, message) => marked.push({ id, code, message }),
    });
    // 行携带 pkg 引用（AppPlanRow.pkg 透传——join 键在场上）
    const row: AppPlanRow = { id: 'oomrow', pkg: 'acme/oomy', entry: oomEntry, sandbox: { carrier: 'worker' } };
    await fleet.loader.load(row);
    const scope = anchor.fork({ name: 'oomrow', rowId: 'oomrow', builtinRow: false });
    await fleet.loader.apply({ ...row, config: { slot: 'oomrow' } }, scope);
    const taps = root.get<Record<string, () => Promise<unknown>>>('fleet/taps-oomrow');
    const inflight = taps.grow!().catch((e: unknown) => e);
    await until(() => marked.length > 0 && oomEvents.length > 0);
    // 行限执法与全局限同一结算链：BRIDGE_WORKER_EXITED + 内存超限签名 + ooms 归因
    expect(marked[0]).toMatchObject({ id: 'oomrow', code: BRIDGE_WORKER_EXITED });
    expect(marked[0]!.message).toContain('reaching memory limit');
    expect(oomEvents[0]).toMatchObject({ rowId: 'oomrow', workerId: 'w:oomrow' });
    expect(((await inflight) as { code?: string }).code).toBe(BRIDGE_WORKER_EXITED);
    expect(fleet.stats()).toMatchObject({ live: 0, crashed: 1, ooms: 1 });
    await root.dispose().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
});

/* ---------------- external 腿（fork 进程域——external carrier 落码批） ---------------- */

/** external 写探测 fixture：config.inside/outside 各写一发报结果 + 回报 TMPDIR
 * （fleet 组装的 per-域 tmp 注入面——env 白名单 + TMPDIR 的行为断言源） */
const FX_EXT_PROBE = `
import { writeFileSync } from 'node:fs';
export const name = 'fleet-ext-probe';
export default async function apply(ctx, config) {
  ctx.provide('fleet/ext-probe-' + config.slot, {
    probe: () => {
      const report = { tmpdir: process.env.TMPDIR };
      for (const [k, p] of [['inside', config.inside], ['outside', config.outside]]) {
        try { writeFileSync(p + '/probe.txt', 'x'); report[k] = { pass: true, code: null }; }
        catch (err) { report[k] = { pass: false, code: err.code ?? 'NO_CODE' }; }
      }
      return report;
    },
  });
}
`;

describe('createBridgeFleet — external 腿（闩二执法 + 收窄真跑 + env 面）', () => {
  /** 起 external 测试台：workspace + dataDir + osLayer:false 的最小沙箱桩
   * （OS 层单元测试在 safety/sandbox.test.ts——本面聚焦闩二与 PM 旗组装） */
  function setupExternal(name: string): {
    root: ContextScope;
    anchor: ContextScope;
    workspace: string;
    dataDir: string;
    probeEntry: string;
    dir: string;
  } {
    const { root, anchor, dir } = setupFixture(name);
    const workspace = join(dir, 'ws');
    const dataDir = join(dir, 'data');
    mkdirSync(workspace);
    mkdirSync(dataDir, { recursive: true });
    const probeEntry = join(dir, 'fx-ext-probe.ts');
    writeFileSync(probeEntry, FX_EXT_PROBE);
    return { root, anchor, workspace, dataDir, probeEntry, dir };
  }

  /** 最小沙箱桩：osLayer:false 时 confine/probe 均不可达——结构面占位即可 */
  const sandboxStub = { listBackends: () => [] } as unknown as SandboxService;

  it('闩二拒绝式：声明根越宿主基线 → COMPOSITION_ROW_INVALID 拒载（spawn 前执法——零域产出）', async () => {
    const { root, anchor, workspace, dataDir, probeEntry, dir } = setupExternal('fleet-ext-latch2');
    const fleet = createBridgeFleet({
      root,
      anchor: () => anchor,
      external: { workspace, dataDir, sandbox: sandboxStub, osLayer: false },
    });
    // 越界声明：workspace 的兄弟目录（前缀撞不上——isInsideRoot 分隔符特判；
    // 不存在的路径即越界判据本身——canonicalPath 容缺形）。闩二在 spawn 参数
    // 组装段同步抛——async 包裹让 expect().rejects 可接
    const evil = join(dir, 'ws-evil');
    const row: AppPlanRow = {
      id: 'lx',
      entry: probeEntry,
      sandbox: { carrier: 'external', fs: { writableRoots: [evil] } },
    };
    await expect(async () => fleet.loader.load(row)).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('越界'),
    });
    // spawn 前执法：零域产出（装机计数 0——拒载不留孤儿域）
    expect(fleet.stats()).toMatchObject({ spawned: 0, live: 0 });
    await root.dispose().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fail-closed 补漏（R1 复盘批二 11e）：external 行 + external 装配参数缺席 = 响亮拒载，不静默降 worker 线程域（修复前必红）', async () => {
    const { root, anchor, probeEntry, dir } = setupExternal('fleet-ext-failclosed');
    // 裁剪装配面形态：不注入 external 参数（worker 腿参数给全——修复前 external
    // 行会静默吃 worker 腿参数落线程域，进程墙承诺无声消失）
    const fleet = createBridgeFleet({
      root,
      anchor: () => anchor,
      workerUrl: WORKER_URL,
      execArgv: ['--import=tsx'],
    });
    const row: AppPlanRow = {
      id: 'ext-nocap',
      entry: probeEntry,
      sandbox: { carrier: 'external' },
    };
    await expect(async () => fleet.loader.load(row)).rejects.toMatchObject({
      code: APP_LOAD_FAILED,
      message: expect.stringContaining('fail-closed 拒载不降格'),
    });
    // 零域产出：无静默 spawn（修复前 spawned=1——external 行落 worker 线程域）
    expect(fleet.stats()).toMatchObject({ spawned: 0 });
    await root.dispose().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('闩二实化后复验（R1 P0-5 回归锁）：workspace 内 symlink 指基线外 + 末段不存在声明——词法验过、预建实化越基线真身即拒载', async () => {
    const { root, anchor, workspace, dataDir, probeEntry, dir } = setupExternal('fleet-ext-symlink');
    const fleet = createBridgeFleet({
      root,
      anchor: () => anchor,
      external: { workspace, dataDir, sandbox: sandboxStub, osLayer: false },
    });
    // 攻击形态：workspace 内 symlink 指向基线外目录；声明走「symlink 下不
    // 存在的子路径」——canonicalPath 对 ENOENT 整体原样返回（中间 symlink
    // 组件不被解析），词法形在 workspace 内 → 第一道词法验放行；mkdirSync
    // 预建跟随 symlink 在基线外实化出真身（修复前：实化根直接进 PM 白名单
    // ——越基线授权）
    const victim = join(dir, 'victim');
    mkdirSync(victim);
    symlinkSync(victim, join(workspace, 'link'));
    const declared = join(workspace, 'link', 'esc');
    const row: AppPlanRow = {
      id: 'sx',
      entry: probeEntry,
      sandbox: { carrier: 'external', fs: { writableRoots: [declared] } },
    };
    await expect(async () => fleet.loader.load(row)).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('实化越界'),
    });
    // 拒载零域产出（spawn 前执法——与词法拒绝式同款收口）
    expect(fleet.stats()).toMatchObject({ spawned: 0, live: 0 });
    await root.dispose().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    '声明收窄真跑：writableRoots=ws/sub → 基线内子目录过、workspace 本体拒（PM 真执法 = 基线 ∩ 声明）',
    { timeout: 60_000 },
    async () => {
      const { root, anchor, workspace, dataDir, probeEntry, dir } = setupExternal('fleet-ext-narrow');
      const fleet = createBridgeFleet({
        root,
        anchor: () => anchor,
        external: { workspace, dataDir, sandbox: sandboxStub, osLayer: false },
      });
      const sub = join(workspace, 'sub');
      mkdirSync(sub);
      const row: AppPlanRow = {
        id: 'nx',
        entry: probeEntry,
        sandbox: { carrier: 'external', fs: { writableRoots: [sub] } },
        config: { slot: 'nx', inside: sub, outside: workspace },
      };
      await fleet.loader.load(row);
      const scope = anchor.fork({ name: 'nx', rowId: 'nx', builtinRow: false });
      await fleet.loader.apply(row, scope);
      const report = await root
        .get<{
          probe: () => Promise<{
            tmpdir?: string;
            inside: { pass: boolean; code: string | null };
            outside: { pass: boolean; code: string | null };
          }>;
        }>('fleet/ext-probe-nx')
        .probe();
      // 收窄语义：声明 sub → 有效白名单只有 sub——workspace 本体虽在宿主基线内，
      // 但基线 ∩ 声明后不在白名单 → PM 拒（ERR_ACCESS_DENIED 签名）
      expect(report.inside).toEqual({ pass: true, code: null });
      expect(report.outside).toEqual({ pass: false, code: 'ERR_ACCESS_DENIED' });
      // per-域 TMPDIR 注入面：件数据根内 tmp/（契约篇 §1.5 钉位——痕迹随行清算）
      expect(report.tmpdir).toBe(join(appDataDirOf(dataDir, 'nx'), 'tmp'));
      await fleet.terminateAll('用例收尾');
      await root.dispose().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  );

  it(
    '声明缺席 = 全基线：无 sandbox.fs 行写 workspace 本体过（基线全额放行 + PM 旗仍在）',
    { timeout: 60_000 },
    async () => {
      const { root, anchor, workspace, dataDir, probeEntry, dir } = setupExternal('fleet-ext-full');
      const outside = join(dir, 'outside');
      mkdirSync(outside);
      const fleet = createBridgeFleet({
        root,
        anchor: () => anchor,
        external: { workspace, dataDir, sandbox: sandboxStub, osLayer: false },
      });
      const row: AppPlanRow = {
        id: 'fx',
        entry: probeEntry,
        sandbox: { carrier: 'external' },
        config: { slot: 'fx', inside: workspace, outside },
      };
      await fleet.loader.load(row);
      const scope = anchor.fork({ name: 'fx', rowId: 'fx', builtinRow: false });
      await fleet.loader.apply(row, scope);
      const report = await root
        .get<{
          probe: () => Promise<{
            inside: { pass: boolean; code: string | null };
            outside: { pass: boolean; code: string | null };
          }>;
        }>('fleet/ext-probe-fx')
        .probe();
      // 未声明 → 全基线（workspace 本体可写）；基线外仍拒——PM 旗从未缺席
      expect(report.inside).toEqual({ pass: true, code: null });
      expect(report.outside).toEqual({ pass: false, code: 'ERR_ACCESS_DENIED' });
      expect(fleet.stats()).toMatchObject({ spawned: 1, live: 1 });
      await fleet.terminateAll('用例收尾');
      await root.dispose().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  );
});

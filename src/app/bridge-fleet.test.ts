/**
 * app — worker 域舰队端到端测试（契约篇 §1.7 K3-c，第二十七批刀二）。
 *
 * 真 worker_threads 子进程（同 bootstrap.test.ts 模式：execArgv [--import=tsx]
 * 直跑 TS 源）+ 真 ctx 作用域——不 mock bridge/fleet 任何内部，只对 fleet 消费
 * 的 markFailed 注入物用记录桩（PluginsService 的结构面）。bootstrap.test.ts
 * 已覆盖机制面（桥协议/域死回卷/工具桥接）；本文件聚焦**装配编舞语义**：
 * 每行一域路由 / 装机计数 / reapUnapplied 防漏 / terminateAll 收编 /
 * 意外死亡结算（markFailed 回写 + plugin/failed 广播）/ 装载失败防漏。
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContext } from '../context/context.js';
import type { ContextScope } from '../context/types.js';
import type { PluginPlanRow } from '../contracts/plugin.js';
import { BRIDGE_HANDLER_FAILED, BRIDGE_WORKER_EXITED } from '../contracts/errors.js';
import { createBridgeFleet } from './bridge-fleet.js';

/* ---------------- 测试基建 ---------------- */

/** 真 worker 子进程入口：bridge 模块的 worker.ts（vitest 下 import.meta.url 指源文件） */
const WORKER_URL = new URL('../bridge/worker.ts', import.meta.url);

/** fleet fixture 插件：provide 一个 ping 服务（名按 config.slot 参数化防串扰）；
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

/** 起一次 fixture 环境（临时目录 + 插件文件 + 真 ctx/锚） */
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
  it('装载生命线：每行一域路由 + 装机计数 + reapUnapplied 只清未应用 + terminateAll 全收', async () => {
    const { root, anchor, fxEntry, dir } = setupFixture('fleet-life');
    const fleet = createBridgeFleet({
      root,
      anchor: () => anchor,
      workerUrl: WORKER_URL,
      execArgv: ['--import=tsx'],
    });
    // 行 r1：完整 load+apply（宿主物化 provide 服务）
    await fleet.loader.load({ id: 'r1', entry: fxEntry, runtime: 'worker' });
    const scope1 = anchor.fork({ name: 'r1', rowId: 'r1' });
    await fleet.loader.apply({ id: 'r1', entry: fxEntry, runtime: 'worker', config: { slot: 'a' } }, scope1);
    // 行 r2：只 load 不 apply（模拟 Kahn 零进展残留——孤儿域待清割）
    await fleet.loader.load({ id: 'r2', entry: fxEntry, runtime: 'worker' });

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

  it('死亡结算与装载失败防漏：意外死亡 → markFailed 回写 + plugin/failed 广播；坏 entry → 域即刻收尾', async () => {
    const { root, anchor, fxEntry, dir } = setupFixture('fleet-death');
    /** markFailed 注入物记录桩（PluginsService 结构面——状态回写语义的被测出口） */
    const marked: Array<{ id: string; code: string; message: string }> = [];
    /** plugin/failed 广播记录（anchor 上真 on 订阅——fleet 死亡结算的词汇面） */
    const broadcast: Array<{ id: string; code?: string; message?: string }> = [];
    anchor.on('plugin/failed', (payload: { id: string; code?: string; message?: string }) => broadcast.push(payload));
    const fleet = createBridgeFleet({
      root,
      anchor: () => anchor,
      workerUrl: WORKER_URL,
      execArgv: ['--import=tsx'],
      markFailed: (id, code, message) => marked.push({ id, code, message }),
    });
    // 行 w1 装载自崩插件（apply 返还后 uncaught 异步异常 → worker 线程自崩溃）
    await fleet.loader.load({ id: 'w1', entry: fxEntry, runtime: 'worker' });
    const scope1 = anchor.fork({ name: 'w1', rowId: 'w1' });
    await fleet.loader.apply(
      { id: 'w1', entry: fxEntry, runtime: 'worker', config: { slot: 'd', crash: true } },
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
    const badRow: PluginPlanRow = { id: 'bad', entry: join(dir, 'nope.ts'), runtime: 'worker' };
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
    await fleet.loader.load({ id: 'b1', entry: throwEntry, runtime: 'worker' });
    const scope = anchor.fork({ name: 'b1', rowId: 'b1' });
    // worker 侧非 AppError 抛错 → 信封归一 BRIDGE_HANDLER_FAILED 保码回宿主
    expect(await rejectionCode(fleet.loader.apply({ id: 'b1', entry: throwEntry, runtime: 'worker' }, scope))).toBe(
      BRIDGE_HANDLER_FAILED,
    );
    // 防漏：行已失败，域不留（apply 失败即收——非等 reap）
    expect(fleet.stats()).toMatchObject({ live: 0, terminated: 1 });
    await root.dispose().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('心跳 watchdog：同步死循环冻结 → kill → 在途结算 + 归因心跳缺失 + heartbeatFreezes 计数（动机用例）', async () => {
    const { root, anchor, fxEntry, dir } = setupFixture('fleet-heartbeat');
    const marked: Array<{ id: string; code: string; message: string }> = [];
    const broadcast: Array<{ id: string; code?: string; message?: string }> = [];
    anchor.on('plugin/failed', (payload: { id: string; code?: string; message?: string }) => broadcast.push(payload));
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
    await fleet.loader.load({ id: 'hb', entry: fxEntry, runtime: 'worker' });
    const scope = anchor.fork({ name: 'hb', rowId: 'hb' });
    await fleet.loader.apply({ id: 'hb', entry: fxEntry, runtime: 'worker', config: { slot: 'w' } }, scope);
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
    await fleet.loader.load({ id: 'sb', entry: slowEntry, runtime: 'worker' });
    const scope = anchor.fork({ name: 'sb', rowId: 'sb' });
    await fleet.loader.apply({ id: 'sb', entry: slowEntry, runtime: 'worker', config: { slot: 'sb' } }, scope);
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
    await fleet.loader.load({ id: 'oom', entry: oomEntry, runtime: 'worker' });
    const scope = anchor.fork({ name: 'oom', rowId: 'oom' });
    await fleet.loader.apply({ id: 'oom', entry: oomEntry, runtime: 'worker', config: { slot: 'oom' } }, scope);
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
      rowResourceLimits: (row) => (row.plugin === 'acme/oomy' ? { maxOldGenerationSizeMb: 48 } : undefined),
      markFailed: (id, code, message) => marked.push({ id, code, message }),
    });
    // 行携带 plugin 引用（PluginPlanRow.plugin 透传——join 键在场上）
    const row: PluginPlanRow = { id: 'oomrow', plugin: 'acme/oomy', entry: oomEntry, runtime: 'worker' };
    await fleet.loader.load(row);
    const scope = anchor.fork({ name: 'oomrow', rowId: 'oomrow' });
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

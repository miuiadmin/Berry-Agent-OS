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
import { BRIDGE_WORKER_EXITED } from '../contracts/errors.js';
import { createBridgeFleet } from './bridge-fleet.js';

/* ---------------- 测试基建 ---------------- */

/** 真 worker 子进程入口：bridge 模块的 worker.ts（vitest 下 import.meta.url 指源文件） */
const WORKER_URL = new URL('../bridge/worker.ts', import.meta.url);

/** fleet fixture 插件：provide 一个 ping 服务（名按 config.slot 参数化防串扰）；
 * config.crash 真 → apply 返还后异步抛 uncaught（worker 线程崩 = 自崩溃最真形态
 * ——fleet 不暴露域句柄，直杀不可达；uncaught 异步异常默认终结 worker 线程） */
const FX_PLUGIN = `
export const name = 'fleet-fx';
export default async function apply(ctx, config) {
  ctx.provide('fleet/taps-' + config.slot, { ping: () => 'pong' });
  if (config.crash) setTimeout(() => { throw new Error('模拟 worker 自崩溃'); }, 10);
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
    const broadcast: Array<{ id: string; code?: string }> = [];
    anchor.on('plugin/failed', (payload: { id: string; code?: string }) => broadcast.push(payload));
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
    expect(fleet.stats().live).toBe(0);

    // 坏 entry 装载失败防漏：load reject + 域即刻刻意收尾（不留孤儿进程）
    const badRow: PluginPlanRow = { id: 'bad', entry: join(dir, 'nope.ts'), runtime: 'worker' };
    await expect(fleet.loader.load(badRow)).rejects.toBeTruthy();
    expect(fleet.stats()).toMatchObject({ live: 0, terminated: 1 }); // 装载失败即收、不入册
    await root.dispose().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
});

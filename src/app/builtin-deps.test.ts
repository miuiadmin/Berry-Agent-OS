/**
 * L3 app 组合根 builtin-deps 测试 — 限流单例接线回归锁（契约篇 §6.10
 * 「第三消费位」，第五十四批刀三余量）。
 *
 * 断言面单一：assembleBuiltinDeps 产出的 webOverrides.gates 与
 * browserDeps.gates 是**同一实例**（web 件 fetch 与 browser 件 navigate
 * 共享同一 InflightGates 的组合根证据），且 host 注入缝在场时复用注入实例。
 * 宿主活资源束以最小假面过界（全部闭包晚绑——装配期只触 dataDir/webOverrides）。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InflightGates } from '../web/index.js';
import { assembleBuiltinDeps, type BuiltinHostResources } from './builtin-deps.js';

/* ---------------- 最小宿主假面（装配期零触达的键全闭包占位） ---------------- */

/** 构造最小 BuiltinHostResources（cast 过界——装配期真实消费键齐真值） */
function minimalHost(dataDir: string, webOverrides?: object): BuiltinHostResources {
  return {
    persistence: false, // 无持久层诊断形态（scheduler 件闭包降级位）
    workspace: dataDir,
    dataDir: () => dataDir,
    sandbox: {} as never,
    llmService: {} as never,
    durableGate: (() => {}) as never,
    rowApp: () => undefined,
    rootsProvider: () => [],
    officialApps: new Map(),
    appGaps: () => new Map(),
    registry: { entries: new Map(), routed: () => undefined },
    chatModule: {} as never,
    chatFront: {} as never,
    goalChannel: {} as never,
    tickRunner: (() => {}) as never,
    osTickRegistrar: {} as never,
    subagentFactory: undefined,
    ui: () => ({}) as never,
    cordoned: () => false,
    mountApprovalClaim: (() => () => {}) as never,
    mountSymbols: (() => () => {}) as never,
    mountEphemeralAuth: (() => () => {}) as never,
    symbolsFor: undefined,
    logUiError: () => undefined,
    daemonAuth: undefined,
    webOverrides,
    agentLocations: [], // 阻 defaultAgentDirectories 急切推导（真盘扫描）
    homeDir: undefined,
    processKind: undefined,
  } as unknown as BuiltinHostResources;
}

/* ---------------- 测试目录 ---------------- */

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'berry-builtin-deps-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/* ---------------- 限流单例两形态 ---------------- */

describe('组合根限流单例（web/browser 两件共享 InflightGates）', () => {
  it('缺席新建形态：webOverrides.gates ≡ browserDeps.gates（同一实例非两实例）', () => {
    const deps = assembleBuiltinDeps(minimalHost(dir));
    expect(deps.webOverrides?.gates).toBeDefined();
    expect(deps.webOverrides?.gates).toBeInstanceOf(InflightGates);
    // 第三消费位核心断言：两件拿到的是同一实例（身份等价——拆开各建即回归红）
    expect(deps.browserDeps.gates).toBe(deps.webOverrides?.gates);
  });

  it('host 注入缝在场形态：复用注入实例（注入缝生产消费合法——fetchImpl 先例同位）', () => {
    const gates = new InflightGates(); // 宿主持有实例（daemon 等形态）
    const deps = assembleBuiltinDeps(minimalHost(dir, { gates }));
    expect(deps.webOverrides?.gates).toBe(gates); // 注入实例被采纳非新建
    expect(deps.browserDeps.gates).toBe(gates);
  });
});

/* ---------------- 会话清单运行态可选键（TUI 强化批 2 刀三） ---------------- */

describe('webuiDeps.sessionsFor 运行态可选键（TUI 强化批 2 刀三——活条目腿直读驱动 isRunning）', () => {
  /** 带注册表活条目的最小宿主：driver.isRunning 可脚本化（双段 cast 过界——
   * registry.entries 公开面是 ReadonlyMap 视图，测试注入需可写位；sessionsFor
   * 只消费 entry.session.header.sessionId / appId / retired / driver.isRunning） */
  function hostWithEntry(isRunning: boolean): BuiltinHostResources {
    const host = minimalHost(dir);
    (host.registry as unknown as { entries: Map<string, unknown> }).entries.set('s-run', {
      session: { header: { sessionId: 's-run' }, events: [{ type: 'turn/start', time: 7 }] },
      appId: 'chat',
      retired: false,
      driver: { isRunning },
    });
    return host;
  }

  it('在飞条目 running: true（驱动直读——修前键缺席即红）；退役语义另测', () => {
    const deps = assembleBuiltinDeps(hostWithEntry(true));
    const row = deps.webuiDeps.sessionsFor().find((s) => s.id === 's-run');
    expect(row).toBeDefined();
    expect(row?.active).toBe(true);
    // 修前红位：running 键缺席（undefined ≠ true）
    expect(row?.running).toBe(true);
  });

  it('空闲条目 running: false（键在场——活条目腿恒写键，非真即假不缺省）', () => {
    const deps = assembleBuiltinDeps(hostWithEntry(false));
    const row = deps.webuiDeps.sessionsFor().find((s) => s.id === 's-run');
    expect(row?.running).toBe(false);
  });
});

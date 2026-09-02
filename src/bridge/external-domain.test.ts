/**
 * bridge — external（fork 进程）域端到端测试（契约篇 §1.7 external 载体，
 * external carrier 落码批）。
 *
 * 真 child_process.spawn 子进程（external-entry.ts 真入口 + NDJSON stdio 载体
 * + tsx 直跑 TS 源）+ 真宿主作用域——不 mock bridge 任何内部。与
 * bootstrap.test.ts（worker 腿）同金样同断言面 = **Echo 双行 parity 测试**
 * （契约篇 §1.7 external carrier 落码批注记）：过桥往返/工具物化/行回卷/
 * 域死结算在两载体上行为同一。external 腿独有面另测：PM 三层旗真执法 /
 * 组杀（树杀）/ 孤儿防线 / crash diagnostic / kill 归因。
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolDefinition, ToolsService } from '../contracts/tools.js';
import { createContext } from '../context/context.js';
import type { ContextScope } from '../context/types.js';
import type { Logger } from '../context/logger.js';
import { loadApps } from '../context/loader.js';
import type { WorkerRowLoader } from '../context/loader.js';
import { BRIDGE_METHOD_NOT_FOUND, BRIDGE_WORKER_EXITED } from '../contracts/errors.js';
import { spawnExternalDomain, externalEntryUrl, type ExternalDomain } from './external-domain.js';
import { buildChildEnv } from '../exec/env.js';

/* ---------------- 测试基建（同 bootstrap.test.ts 形态——parity 的基建也对齐） ---------------- */

/**
 * 域 id 判死探测：process.kill(pid, 0) 抛 ESRCH = 已死；Linux 下 zombie 按
 * 死报。zombie 澄清（刀四 CI 跟进修实测）：树杀用例等「孙进程死」，孙的父
 * （域）先被组杀 → 孙过继 PID 1——若 init 不 reap（docker 容器 PID 1 是
 * sh/node，macOS launchd 与 GH runner systemd 都收），孙成永久 zombie 而
 * kill(pid, 0) 对 zombie 仍成功（pid 未释放）→ 误报活拖到轮询超时。读
 * /proc/\<pid\>/stat 的 state 字段（comm 可含空格——取最后 ')' 后首段），
 * Z = 已退出按死报；无 /proc 平台（macOS）kill0 结果即真相。
 */
function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/)[0];
    return state !== 'Z';
  } catch {
    return true; // 无 /proc——kill0 已证进程在且非本平台可判 zombie
  }
}

/** 轮询直到谓词为真（异步到达面的确定性等待；谓词可同步可异步） */
async function until(predicate: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect.unreachable(`轮询超时（${ms}ms）——异步面未到达`);
}

/** 取 reject 的错误（非 AppError 抛出时让用例失败并显示原值） */
async function rejection(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  const err = await promise.then(
    () => {
      throw new Error('预期 reject，实际 resolve');
    },
    (e: unknown) => e,
  );
  if (!(err instanceof Error)) throw err;
  const coded = err as { code?: string; message: string };
  if (typeof coded.code !== 'string') throw err;
  return coded as { code: string; message: string };
}

/** 最小工具服务桩（bootstrap.test.ts 同款——桥接工具注册的宿主物化断言面） */
class FakeTools {
  readonly defs = new Map<string, ToolDefinition>();
  register(def: ToolDefinition): () => void {
    this.defs.set(def.name, def);
    return () => {
      this.defs.delete(def.name);
    };
  }
  get(name: string): ToolDefinition | undefined {
    return this.defs.get(name);
  }
}

/**
 * Echo 金样 fixture（worker 腿 FX_WORKER 同款同断言面——parity 判据）：provide
 * 服务（名按 config.slot 参数化）+ effect 打点 + 事件订阅 + 工具注册。
 */
const FX_ECHO = `
export const name = 'fx-external';
export const events = [{ name: 'fx/etick', mode: 'emit', note: 'external e2e 测试事件' }];
export default async function apply(ctx, config) {
  const seen = [];
  ctx.provide('fx/etaps-' + config.slot, {
    list: () => seen,
    add: (a, b) => a + b,
    hang: () => new Promise(() => {}),
  });
  ctx.effect(() => { seen.push('e1'); return () => {}; });
  ctx.on('fx/etick', (v) => { seen.push('tick:' + String(v)); });
  ctx.get('tools').register({
    name: 'fx/et',
    description: 'fixture 工具（external 腿）',
    parameters: { type: 'object', properties: {} },
    execute: async (args) => ({ content: [{ type: 'text', text: 'et:' + JSON.stringify(args) }] }),
  });
}
`;

/** crash fixture：apply 返还后异步 uncaught（fork 进程崩 = 自崩溃最真形态——stderr 栈 + exit 1） */
const FX_CRASH = `
export const name = 'fx-crash';
export default async function apply(ctx) {
  ctx.provide('fx/crash-ready', { ok: () => true });
  setTimeout(() => { throw new Error('模拟 external 自崩溃'); }, 20);
}
`;

/** 孙进程 fixture：域内 spawn 长命孙进程（同组继承 pgid——树杀收割面）+ pid 回报服务 */
const FX_GRANDCHILD = `
import { spawn } from 'node:child_process';
export const name = 'fx-grandchild';
export default async function apply(ctx) {
  const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  ctx.provide('fx/grandpid', { pid: () => grand.pid });
  ctx.effect(() => () => grand.kill('SIGKILL')); // 行回卷兜底（树杀用例不走此路）
}
`;

/** PM 写探测 fixture：config.inside/outside 两路径各写一发，结果经服务回传 */
const FX_PM_PROBE = `
import { writeFileSync } from 'node:fs';
export const name = 'fx-pm-probe';
export default async function apply(ctx, config) {
  ctx.provide('fx/pm-probe', {
    probe: () => {
      const report = {};
      for (const [k, p] of [['inside', config.inside], ['outside', config.outside]]) {
        try { writeFileSync(p + '/probe.txt', 'x'); report[k] = { pass: true, code: null }; }
        catch (err) { report[k] = { pass: false, code: err.code ?? 'NO_CODE' }; }
      }
      return report;
    },
  });
}
`;

/** 赖子 fixture：装载即吞 SIGTERM（空监听防默认退——terminate 升级段的回归锁面：
 *  组杀 SIGTERM 被吞后，宽限到点 SIGKILL 升级是唯一收割手段，此前零覆盖） */
const FX_TERM_TRAP = `
export const name = 'fx-term-trap';
process.on('SIGTERM', () => {}); // 吞组杀信号——宽限内不退，制造赖子形态
export default async function apply(ctx) {
  ctx.provide('fx/trap-ready', { ok: () => true });
}
`;

/** 冻结 fixture：burn() 同步死循环占死域事件循环（CPU 燃烧形态——ping 无应答，
 *  SIGTERM 也收不到），宿主心跳丢拍计满即 onFreeze（冻结检测判据面） */
const FX_FREEZE = `
export const name = 'fx-freeze';
export default async function apply(ctx) {
  ctx.provide('fx/burn', { burn: () => { while (true) {} } });
}
`;

/**
 * 坏行双发 fixture（.mjs——非 .ts 不走引导器路由，node 直跑）：先吐一行撕裂
 * JSON（宿主侧 onBadLine 接线断言面）、再吐一行合法的域级 log tell（rowId 空
 * ——宿主 onTell 'log' 域级路由断言面）。setInterval 保活等宿主 terminate 收割。
 */
const FX_NOISY = `
process.stdout.write('{torn-json\\n');
process.stdout.write(JSON.stringify({ kind: 'tell', event: 'log', payload: { rowId: '', level: 'warn', message: 'entry-noisy 域级上行', fields: { k: 1 } } }) + '\\n');
setInterval(() => {}, 1 << 30);
`;

/** 测试环境根（fixture 全落这里；afterAll 统一清） */
let fixtureDir: string;
let root: ContextScope;
let tools: FakeTools;
/** 共享域（Echo parity 用例组——fork 冷启 ~1.5s，beforeAll 一次起域复用） */
let domain: ExternalDomain;
let echoEntry: string;
/** 共享域意外死亡记录（terminate 用例断言主动收尾不落此——事故面观测） */
const unexpectedExits: Array<{ workerId: string; code: number; rows: readonly string[]; diagnostic?: string }> = [];

/** 起一个测试域（各独立用例专用域的公共形态——PM/树杀/孤儿等独有面） */
function spawnTestDomain(
  opts: Partial<Parameters<typeof spawnExternalDomain>[0]> & {
    onExit?: (info: {
      workerId: string;
      code: number;
      rows: readonly string[];
      reason?: string;
      diagnostic?: string;
    }) => void;
  },
): ExternalDomain {
  return spawnExternalDomain({
    root,
    tools: tools as unknown as ToolsService,
    workerId: opts.workerId ?? `e-test-${Math.random().toString(36).slice(2, 8)}`,
    // #40 env 必填：与真实装配层同款白名单产物（fixture 全零 env 依赖——孙进程
    // spawn 走 execPath 绝对路径，白名单只作「装配层显式持入」的形态保真）
    env: opts.env ?? buildChildEnv(process.env),
    ...opts,
  });
}

/** 等域就绪：svc.load 探活（handler 挂好前 ask 被丢弃——探到即全就绪） */
async function untilReady(d: ExternalDomain, entry: string): Promise<void> {
  await until(() =>
    d.endpoint.call('svc', 'load', [{ id: '__probe__', entry }]).then(
      () => true,
      () => false,
    ),
  );
}

beforeAll(async () => {
  fixtureDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'bridge-ext-')));
  echoEntry = join(fixtureDir, 'fx-echo.ts');
  writeFileSync(echoEntry, FX_ECHO);
  writeFileSync(join(fixtureDir, 'fx-crash.ts'), FX_CRASH);
  writeFileSync(join(fixtureDir, 'fx-grandchild.ts'), FX_GRANDCHILD);
  writeFileSync(join(fixtureDir, 'fx-pm-probe.ts'), FX_PM_PROBE);
  writeFileSync(join(fixtureDir, 'fx-term-trap.ts'), FX_TERM_TRAP);
  writeFileSync(join(fixtureDir, 'fx-freeze.ts'), FX_FREEZE);
  writeFileSync(join(fixtureDir, 'fx-noisy.mjs'), FX_NOISY);
  root = createContext({ name: 'bridge-ext-test' });
  tools = new FakeTools();
  domain = spawnExternalDomain({
    root,
    tools: tools as unknown as ToolsService,
    externalUrl: externalEntryUrl(import.meta.url),
    workerId: 'e2e-external',
    // #40 env 必填：真实装配层同款白名单产物（测试豁免 DAG——跨模块引 exec/env 合法）
    env: buildChildEnv(process.env),
    onExit: (info) => unexpectedExits.push(info),
  });
  await untilReady(domain, echoEntry);
}, 30_000);

afterAll(async () => {
  domain?.terminate('测试收尾');
  await root?.dispose().catch(() => undefined);
  rmSync(fixtureDir, { recursive: true, force: true });
});

/* ---------------- Echo 双行 parity（worker 腿 bootstrap.test.ts 同断言面） ---------------- */

describe('spawnExternalDomain — Echo parity（真 fork 子进程，worker 腿同款断言）', () => {
  it('loadApps 全管线激活：external 行走 workerLoader 注入口 + 词汇入册 + 宿主物化', async () => {
    // 首用例经 loadApps（与 bootstrap.test.ts 同纪律）：meta.events 词汇在此
    // 入册——后续直连用例的 ctx.on 才有宿主词汇表可依
    const loader: WorkerRowLoader = {
      load: (row) => domain.load(row),
      apply: (row, scope, callOpts) => domain.applyRow(row, scope, callOpts),
    };
    const result = await loadApps(
      root,
      [{ id: 'x0', entry: echoEntry, sandbox: { carrier: 'external' }, config: { slot: 'p' } }],
      { workerLoader: loader },
    );
    expect(result.failed).toEqual([]);
    expect(result.activated.map((a) => a.id)).toEqual(['x0']);
    // 全管线物化可见：代理方法真往返
    const taps = root.get<Record<string, (...args: unknown[]) => Promise<unknown>>>('fx/etaps-p');
    await expect(taps['add']!(2, 3)).resolves.toBe(5);
  });

  it('load → applyRow：宿主 provide 物化 + 代理方法过桥往返 + 工具注册物化执行', async () => {
    const meta = await domain.load({ id: 'x1', entry: echoEntry, sandbox: { carrier: 'external' } });
    expect(meta.name).toBe('fx-external');
    const scope = root.fork({ name: 'x1', rowId: 'x1', builtinRow: false });
    await domain.applyRow({ id: 'x1', sandbox: { carrier: 'external' }, config: { slot: 'a' } }, scope);
    // 宿主侧物化：锚作用域可见（JSON 通道代理——方法过界往返）
    const taps = root.tryGet<Record<string, (...args: unknown[]) => Promise<unknown>>>('fx/etaps-a');
    expect(taps).toBeDefined();
    await expect(taps!['add']!(2, 3)).resolves.toBe(5);
    // effect 打点过界生效（apply 排水语义——list 已见 e1）
    await expect(taps!['list']!()).resolves.toEqual(['e1']);
    // 工具注册宿主物化 + execute 过桥回 fork 域执行体
    const def = tools.get('fx/et');
    expect(def).toBeDefined();
    const result = (await def!.execute({ x: 7 }, { toolCallId: 'tc-ext', signal: new AbortController().signal })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'et:{"x":7}' });
    await scope.dispose();
  });

  it('行回卷联动：行作用域 dispose → 宿主绑定清 + svc.unload 到达（域侧行状态自清）', async () => {
    await domain.load({ id: 'x2', entry: echoEntry, sandbox: { carrier: 'external' } });
    const scope = root.fork({ name: 'x2', rowId: 'x2', builtinRow: false });
    await domain.applyRow({ id: 'x2', sandbox: { carrier: 'external' }, config: { slot: 'u' } }, scope);
    await scope.dispose();
    // 卸载联动 fire-and-forget——轮询等域侧行状态清（服务不可达）
    await until(async () => {
      try {
        await domain.endpoint.call('svc', 'invoke', ['x2', 'fx/etaps-u', 'add', []]);
        return false;
      } catch (err) {
        return (err as { code?: string }).code === BRIDGE_METHOD_NOT_FOUND;
      }
    });
  });

  it('terminate 域死：在途调用以 BRIDGE_WORKER_EXITED 结算、后续调用即刻拒绝；主动收尾不叫 onExit（非事故）', async () => {
    await domain.load({ id: 'x5', entry: echoEntry, sandbox: { carrier: 'external' } });
    const scope = root.fork({ name: 'x5', rowId: 'x5', builtinRow: false });
    await domain.applyRow({ id: 'x5', sandbox: { carrier: 'external' }, config: { slot: 'd' } }, scope);
    // 挂起在途调用（hang 永不结算）→ terminate → SIGTERM 组杀 → 域死结算
    const inflight = root.get<Record<string, (...args: unknown[]) => Promise<unknown>>>('fx/etaps-d')!['hang']!();
    domain.terminate('测试域死结算');
    const err = await rejection(inflight);
    expect(err.code).toBe(BRIDGE_WORKER_EXITED);
    // 端点已 dispose：新调用即刻拒绝
    const refused = await rejection(domain.endpoint.call('svc', 'invoke', ['x5', 'fx/etaps-d', 'add', []]));
    expect(refused.code).toBe(BRIDGE_WORKER_EXITED);
    // 子进程真死（exit 事件已到——terminate 编舞完成）
    await until(() => !pidAlive(domain.child.pid));
    expect(unexpectedExits).toEqual([]); // 主动收尾不触发意外死亡通知
  });
});

/* ---------------- external 腿独有面 ---------------- */

describe('spawnExternalDomain — external 独有面（PM 执法/树杀/孤儿/crash/kill）', () => {
  it(
    'PM 三层旗真执法：derivePmFlags 产物 spawn 域——写根内过 / 写根外 ERR_ACCESS_DENIED',
    { timeout: 60_000 },
    async () => {
      const stage = realpathSync(mkdtempSync(join(fixtureDir, 'pm-')));
      const inside = join(stage, 'allowed');
      const outside = join(stage, 'outside');
      // 手写 PM 旗组（derivePmFlags 产物同形——推导器自身的真跑回归锁在
      // safety/pm-flags.test.ts 单点；本面断言对象是 spawnExternalDomain 把
      // execArgv 透传到真执法，跨模块 import 推导器违拓扑纪律）。写根旗值
      // 自带推导器同款两坑执法：预建（坑三——不存在则白名单静默失效）+
      // realpath 归一（坑一——与子进程运行时路径同形）
      mkdirSync(inside, { recursive: true });
      // --allow-worker 在位：TS 源形态经引导器 module.register 挂 loader 钩子
      // 线程（AsyncLoaderHookWorker），PM 拒 Worker 构造即挂——刀四载体去
      // tsx 化实测勘正（旧理由 tsx→esbuild 线程已退役；TSX_DISABLE_CACHE 同
      // 批退役——载体零 tsx 无磁盘缓存面）
      const execArgv = [
        '--permission',
        '--allow-fs-read=*',
        `--allow-fs-write=${realpathSync(inside)}`,
        '--allow-worker',
      ];
      const pm = spawnTestDomain({
        execArgv,
      });
      const probeEntry = join(fixtureDir, 'fx-pm-probe.ts');
      try {
        await untilReady(pm, probeEntry);
        await pm.load({
          id: 'pmx',
          entry: probeEntry,
          sandbox: { carrier: 'external' },
          config: { inside, outside },
        });
        const scope = root.fork({ name: 'pmx', rowId: 'pmx', builtinRow: false });
        await pm.applyRow({ id: 'pmx', sandbox: { carrier: 'external' }, config: { inside, outside } }, scope);
        const probe = root.get<{ probe: () => Promise<Record<string, { pass: boolean; code: string | null }>> }>(
          'fx/pm-probe',
        );
        const report = await probe.probe();
        // PM 中层真执法：根内写放行、根外写拒且签名是 PM 拦截码
        expect(report.inside).toEqual({ pass: true, code: null });
        expect(report.outside).toEqual({ pass: false, code: 'ERR_ACCESS_DENIED' });
        await scope.dispose();
      } finally {
        pm.terminate('PM 用例收尾');
      }
    },
  );

  it(
    'crash 意外死亡：uncaught → onExit rows 带行 id + diagnostic 携 stderr 栈尾 + 域死回卷（宿主物化消失）',
    { timeout: 40_000 },
    async () => {
      const exits: Array<{ workerId: string; code: number; rows: readonly string[]; diagnostic?: string }> = [];
      const crash = spawnTestDomain({
        onExit: (info) => exits.push(info),
      });
      const crashEntry = join(fixtureDir, 'fx-crash.ts');
      await untilReady(crash, crashEntry);
      await crash.load({ id: 'cx', entry: crashEntry, sandbox: { carrier: 'external' } });
      const scope = root.fork({ name: 'cx', rowId: 'cx', builtinRow: false });
      await crash.applyRow({ id: 'cx', sandbox: { carrier: 'external' } }, scope);
      expect(root.tryGet('fx/crash-ready')).toBeDefined();
      // fixture 20ms 后异步 uncaught → fork 进程崩（stderr 栈 + exit 1）
      await until(() => exits.length > 0);
      expect(exits[0]!.rows).toEqual(['cx']);
      expect(exits[0]!.code).toBe(1);
      // diagnostic = stderr 尾缓存——自崩溃第一手栈（fixture 消息可辨）
      expect(exits[0]!.diagnostic).toContain('模拟 external 自崩溃');
      // 域死回卷：宿主物化随行作用域消失
      await until(() => root.tryGet('fx/crash-ready') === undefined);
    },
  );

  it(
    'kill 执法：watchdog 直杀 → onExit 携 reason 归因（意外死亡全流程，非编舞终点）',
    { timeout: 40_000 },
    async () => {
      const exits: Array<{ workerId: string; code: number; rows: readonly string[]; reason?: string }> = [];
      const victim = spawnTestDomain({
        onExit: (info) => exits.push(info),
      });
      await untilReady(victim, echoEntry);
      await victim.load({ id: 'kx', entry: echoEntry, sandbox: { carrier: 'external' } });
      const scope = root.fork({ name: 'kx', rowId: 'kx', builtinRow: false });
      await victim.applyRow({ id: 'kx', sandbox: { carrier: 'external' }, config: { slot: 'k' } }, scope);
      victim.kill('心跳缺失执法（测试）');
      await until(() => exits.length > 0);
      expect(exits[0]!.reason).toBe('心跳缺失执法（测试）');
      expect(exits[0]!.rows).toEqual(['kx']);
      await until(() => root.tryGet('fx/etaps-k') === undefined);
    },
  );

  it('组杀树杀：域内孙进程随组收割——terminate SIGTERM 组孙同死（PoC ⑨ 判据）', { timeout: 40_000 }, async () => {
    const gc = spawnTestDomain({ killGraceMs: 1_500 });
    const gcEntry = join(fixtureDir, 'fx-grandchild.ts');
    await untilReady(gc, gcEntry);
    await gc.load({ id: 'gx', entry: gcEntry, sandbox: { carrier: 'external' } });
    const scope = root.fork({ name: 'gx', rowId: 'gx', builtinRow: false });
    await gc.applyRow({ id: 'gx', sandbox: { carrier: 'external' } }, scope);
    const grandPid = await root.get<{ pid: () => Promise<number> }>('fx/grandpid').pid();
    expect(pidAlive(grandPid)).toBe(true); // 孙进程活着（域内 spawn 的长命进程）
    // terminate = SIGTERM 组：负 pid 投组，孙进程（同组继承 pgid）一并收割
    gc.terminate('树杀用例');
    await until(() => !pidAlive(grandPid));
    await until(() => !pidAlive(gc.child.pid));
  });

  it(
    'terminate 升级段（R2 测试小项②）：SIGTERM 被吞不退 → 宽限到点 SIGKILL 组收割——signalCode 直证升级（吞信号的赖子无升级段即永久泄漏）',
    { timeout: 40_000 },
    async () => {
      // 赖子形态：域装载即挂 SIGTERM 空监听（吞默认退）。terminate 三段编舞的
      // 第三段（宽限后 childAlive 复查 → SIGKILL）此前零自动化覆盖。killGraceMs
      // 直传 1s 直测域句柄——该参数不经 fleet 线程是本批 charter 裁定（测试-only
      // 批不改产线参数面），fleet 层的 terminate* 只同步清 entries 不证进程死
      const trap = spawnTestDomain({ killGraceMs: 1_000 });
      const trapEntry = join(fixtureDir, 'fx-term-trap.ts');
      await untilReady(trap, trapEntry);
      await trap.load({ id: 'tx', entry: trapEntry, sandbox: { carrier: 'external' } });
      const scope = root.fork({ name: 'tx', rowId: 'tx', builtinRow: false });
      await trap.applyRow({ id: 'tx', sandbox: { carrier: 'external' } }, scope);
      expect(pidAlive(trap.child.pid)).toBe(true); // 前置：域活着
      trap.terminate('升级段用例');
      // 宽限中段（1s 内的 400ms 处）：SIGTERM 已投组且被吞——进程仍活。
      // exitCode/signalCode 双空 = childAlive() 判据命中的形态（升级段的触发条件）
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(pidAlive(trap.child.pid)).toBe(true);
      expect(trap.child.exitCode).toBeNull();
      expect(trap.child.signalCode).toBeNull();
      // 宽限到点 → SIGKILL 组收割（uncatchable——空监听也拦不住）。signalCode
      // 直证升级段执行：若域是自愿退出（吞 TERM 后 process.exit）则 exitCode 非
      // null 而非信号死——两形态在本断言上互斥可辨。
      // 等待条件取「宿主侧收割落定」而非「pid 消失」：SIGKILL 后子进程先成
      // zombie（父未 reap），/proc 判活此刻已报死但 libuv 的 exit 事件尚未进
      // 事件循环——signalCode 还没落定就断言必红（Linux CI 三跑竞速实证；
      // macOS 无 /proc 走 kill0 须等 reap 才过，故本机恒绿掩住了这层）
      await until(() => trap.child.exitCode !== null || trap.child.signalCode !== null);
      expect(trap.child.signalCode).toBe('SIGKILL');
      expect(trap.child.exitCode).toBeNull();
    },
  );

  it(
    '孤儿防线：宿主 stdin 管道断（模拟宿主被 SIGKILL）→ 组杀本域进程组自尽（critic #1 后形态）',
    { timeout: 40_000 },
    async () => {
      const exits: Array<{ workerId: string; code: number; rows: readonly string[] }> = [];
      const orphan = spawnTestDomain({
        onExit: (info) => exits.push(info),
      });
      await untilReady(orphan, echoEntry);
      await orphan.load({ id: 'ox', entry: echoEntry, sandbox: { carrier: 'external' } });
      const scope = root.fork({ name: 'ox', rowId: 'ox', builtinRow: false });
      await orphan.applyRow({ id: 'ox', sandbox: { carrier: 'external' }, config: { slot: 'o' } }, scope);
      // 关宿主侧 stdin 写端 = 模拟宿主死（管道断 → 域入口 'end' → 组杀本域
      // 进程组再自尽——负 pid 投组，域自身亦在组内 = 信号死形态）
      orphan.child.stdin?.end();
      await until(() => exits.length > 0);
      expect(exits[0]!.code).toBe(-1); // 信号死（exitCode null → -1）——组杀含自的孤儿防线语义
      expect(orphan.child.signalCode).toBe('SIGKILL');
      await until(() => !pidAlive(orphan.child.pid));
    },
  );

  it(
    '【回归锁】坏行观测双向接线（遗漏大扫 20260902 #7）：宿主侧 onBadLine 落 root logger warn + 域级 log tell（rowId 空）域级路由',
    { timeout: 40_000 },
    async () => {
      // 修前红位：宿主侧构造点未传 onBadLine（坏行静默蒸发）+ onTell 'log' 只认
      // 行绑定（rowId 空的域级上行被「行已回卷」分支静默丢弃）——两 warn 全缺席
      const warns: Array<{ message: string; fields?: Record<string, unknown> }> = [];
      const noop = (): void => undefined;
      const recorder: Logger = {
        error: noop,
        info: noop,
        debug: noop,
        warn: (message, fields) => warns.push({ message, fields }),
        child: () => recorder, // createContext 会 child(name)——同录音面
        setLevel: noop,
      };
      const noisyRoot = createContext({ name: 'bridge-ext-noisy', logger: recorder });
      const noisy = spawnTestDomain({
        root: noisyRoot,
        externalUrl: pathToFileURL(join(fixtureDir, 'fx-noisy.mjs')),
      });
      await until(() => warns.length >= 2);
      // 宿主侧腿：坏行 → root logger warn（预览 + 字节数 + parse 错误）
      const hostLeg = warns.find((w) => w.message.includes('坏行'));
      expect(hostLeg).toBeTruthy();
      // parse 错误第一手（V8 各版本消息形态有差——以 JSON 关键词锚定不回显依赖）
      expect(String(hostLeg!.fields?.error)).toContain('JSON');
      expect(hostLeg!.fields?.preview).toBe('{torn-json'); // 截断预览 = 行原文（10 字符 < 120 上限）
      expect(hostLeg!.fields?.bytes).toBe('{torn-json'.length);
      // 域入口侧腿：坏行观测经 log tell 上行（rowId 空 = 域级标记）→ 域级路由落 root logger
      const entryLeg = warns.find((w) => w.message.includes('域级上行'));
      expect(entryLeg).toBeTruthy();
      expect(entryLeg!.fields).toEqual({ k: 1 });
      noisy.terminate('测试收尾');
      await noisyRoot.dispose().catch(() => undefined);

      // 真入口上行腿：fx-noisy 是裸 .mjs 绕过了 external-entry——另起真入口域，
      // 向 child.stdin 写坏行 → 入口 onBadLine 经 tell 上行（rowId 空）→ 域级
      // 路由落 root logger（修前红位：入口构造点未传 onBadLine——该 warn 恒缺席）
      const entryRoot = createContext({ name: 'bridge-ext-noisy-entry', logger: recorder });
      const entryDomain = spawnTestDomain({ root: entryRoot });
      entryDomain.child.stdin?.write('{torn-host-side\n');
      await until(() => warns.some((w) => w.message.includes('域入口收到坏行')));
      const hostSideLeg = warns.find((w) => w.message.includes('域入口收到坏行'))!;
      expect(hostSideLeg.fields?.bytes).toBe('{torn-host-side'.length);
      entryDomain.terminate('测试收尾');
      await entryRoot.dispose().catch(() => undefined);
    },
  );

  it(
    '孤儿防线收割（critic #1 修复锁）：stdin 断 → 组杀罩域内同组孙进程——孙进程随域死（修前域退孙活永存）',
    { timeout: 40_000 },
    async () => {
      const orphan = spawnTestDomain({});
      const gcEntry = join(fixtureDir, 'fx-grandchild.ts');
      await untilReady(orphan, gcEntry);
      await orphan.load({ id: 'gx3', entry: gcEntry, sandbox: { carrier: 'external' } });
      const scope = root.fork({ name: 'gx3', rowId: 'gx3', builtinRow: false });
      await orphan.applyRow({ id: 'gx3', sandbox: { carrier: 'external' } }, scope);
      const grandPid = await root.get<{ pid: () => Promise<number> }>('fx/grandpid').pid();
      expect(pidAlive(grandPid)).toBe(true); // 前置：域内 spawn 的长命孙进程活着
      // 关宿主侧 stdin 写端 = 模拟宿主死。孙进程非 detached spawn 继承域 pgid——
      // 组杀（负 pid）收割射程内（修前 exit(0) 只退域进程本身，孙进程永活 =
      // 宪章七进程墙的生命周期残角；宿主侧 in-flight exec 命令另一腿由 §6.6
      // 登记簿清扫承接，不在此测）
      orphan.child.stdin?.end();
      await until(() => !pidAlive(grandPid)); // 修前红锚：孙进程不在旧防线收割射程
      await until(() => !pidAlive(orphan.child.pid));
    },
  );

  it(
    'spawn 失败腿（20260901-c #3）：runner 缺失 ENOENT → error 自触发死亡结算（在途调用 WORKER_EXITED + onExit code -1 + diagnostic 第一手 + reason 缺席），无 uncaughtException',
    { timeout: 20_000 },
    async () => {
      // Node 在 spawn 失败时只发 'error' 不发 'exit'（没有进程可退）——修前
      // 零监听即冒泡 uncaughtException 杀宿主；在途 svc/load 调用也永挂
      const exits: Array<{
        workerId: string;
        code: number;
        rows: readonly string[];
        reason?: string;
        diagnostic?: string;
      }> = [];
      const d = spawnTestDomain({
        argvWrapper: () => [join(fixtureDir, 'no-such-runner-enoent')],
        onExit: (info) => exits.push(info),
      });
      const loadP = d.load({ id: 'sx', entry: echoEntry, sandbox: { carrier: 'external' } });
      const err = await rejection(loadP); // 在途调用按域死结算（不等 loadTimeout）
      expect(err.code).toBe('BRIDGE_WORKER_EXITED');
      await until(() => exits.length > 0);
      expect(exits[0]!.code).toBe(-1); // exitCode null → -1（信号死/spawn 失败同形）
      expect(exits[0]!.diagnostic).toContain('ENOENT'); // 第一手 spawn 错误（stderr 恒空——error 消息是唯一归因）
      expect(exits[0]!.reason).toBeUndefined(); // reason 契约：仍仅 kill 执法携带（diagnostic 是事实面）
      // 结算后端点拒新调用（deathSettled 闸与 exit 路同一收场）
      const again = await rejection(d.endpoint.call('svc', 'load', [{ id: 'sx2', entry: echoEntry }]));
      expect(again.code).toBe('BRIDGE_WORKER_EXITED');
    },
  );

  it('externalEntryUrl：按宿主半自身形态判别 fork 入口（.ts 源 → external-entry.ts / 编译产物 → .js）', () => {
    expect(externalEntryUrl('file:///repo/dist/bridge/bootstrap.js').href).toBe(
      'file:///repo/dist/bridge/external-entry.js',
    );
    expect(externalEntryUrl('file:///repo/src/bridge/external-domain.ts').href).toBe(
      'file:///repo/src/bridge/external-entry.ts',
    );
  });

  it(
    '心跳冻结检测：burn 同步死循环占死域事件循环 → 丢拍计满 onFreeze（一次性）+ kill 意外死亡归因',
    { timeout: 40_000 },
    async () => {
      const freezes: Array<{ missed: number }> = [];
      const exits: Array<{ workerId: string; code: number; rows: readonly string[]; reason?: string }> = [];
      const frozen = spawnTestDomain({
        // 60ms 节律 + missLimit=1：第 2 拍丢满（missed > limit 才 freeze）——
        // 生产缺省 15s×3 等不起测试钟，形态与判据同构
        heartbeatMs: 60,
        heartbeatMissLimit: 1,
        onFreeze: (info) => freezes.push(info),
        onExit: (info) => exits.push(info),
      });
      const freezeEntry = join(fixtureDir, 'fx-freeze.ts');
      await untilReady(frozen, freezeEntry);
      // 心跳起表点 = 首次 domain.load 成功（boot 窗 ping 不计拍——两窗分工），
      // untilReady 的 svc.load 探活不经 domain.load 包装，不消耗起表
      await frozen.load({ id: 'fz', entry: freezeEntry, sandbox: { carrier: 'external' } });
      const scope = root.fork({ name: 'fz', rowId: 'fz', builtinRow: false });
      await frozen.applyRow({ id: 'fz', sandbox: { carrier: 'external' } }, scope);
      // 燃烧域事件循环：RPC 永不归还（pending 由 kill 结算 WORKER_EXITED——
      // catch 吞 unhandled 形态）
      root
        .get<{ burn: () => Promise<void> }>('fx/burn')
        .burn()
        .catch(() => {});
      await until(() => freezes.length > 0);
      // 一次性上报：missed=2（丢满即停表，不再累计——frozen 旗标闸）
      expect(freezes[0]!.missed).toBe(2);
      // 冻结域收不到 SIGTERM（事件循环死）——kill 直杀 SIGKILL 组走意外死亡，
      // onExit 携 kill 归因（fleet onFreeze→kill 接线在组合根，此处单测域半）
      frozen.kill('心跳丢拍执法（测试）');
      await until(() => exits.length > 0);
      expect(exits[0]!.reason).toBe('心跳丢拍执法（测试）');
      expect(exits[0]!.rows).toEqual(['fz']);
      await until(() => !pidAlive(frozen.child.pid));
    },
  );

  it('载体去 tsx 化路由：TS 入口经引导器 + argv[2] 域id 协议位恒在；显式旗组原样透传（spawnargs 直证）', () => {
    // 刀四 CI 首跑红根因①回归锁：旧「TS 形态自补 --import=tsx」在 node 22
    // 双缺陷（module.register 钩子不挂 worker 线程 + esbuild 子进程被 PM 旗
    // 拒杀）——现形 TS 入口恒经纯 JS 引导器 carrier-launch.mjs（原生
    // type-strip 直载 + 兜底 resolve 钩子），argv 形状 =
    // [node, ...旗, carrier-launch.mjs, 域id, 入口路径]。
    // 断言面（spawnargs 字面锁）：①零 tsx（旗组透传不追加——加载链不在
    // execArgv）；②argv[2] 恒域 id（external-entry.ts 协议位，引导器透明）；
    // ③入口路径在 argv[3]（引导器读它动态 import）。
    const domain = spawnTestDomain({ execArgv: ['--permission'], workerId: 'route-probe' });
    const args = domain.child.spawnargs.slice(1); // 去 node 本体
    // ① 显式旗组原样在位且零 tsx 追加
    expect(args).toContain('--permission');
    expect(args.filter((a) => a.includes('tsx'))).toHaveLength(0);
    // ②③ 引导器路由形：域 id 与 .ts 入口都在（域 id 位置 = 引导器后第一位）
    const launcherAt = args.findIndex((a) => a.endsWith('carrier-launch.mjs'));
    expect(launcherAt).toBeGreaterThan(-1);
    expect(args[launcherAt + 1]).toBe('route-probe'); // argv[2] 域 id 协议位恒在
    expect(args[launcherAt + 2]).toMatch(/external-entry\.ts$/); // 入口路径随行
    domain.terminate('守卫用例收尾');
  });
});

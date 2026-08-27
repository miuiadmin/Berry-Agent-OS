/**
 * bridge — 宿主半端到端测试（契约篇 §1.7，第二十七批刀二 K3-b2）。
 *
 * 真 worker_threads 子进程（execArgv [--import=tsx] 直跑 TS 源——dev
 * 形态同构；等号单元素形态与两段参数语义等价，且避开拓扑门禁的裸导入
 * 词法扫描误触发）+ 真宿主作用域 + 真 loadPlugins 管线：不 mock bridge 任何内部。
 * 工具服务用最小记录桩（WorkerDomainOptions.tools 的结构面——桥接语义真跑，
 * 注册表本体非被测件）；模型面无涉（零 mock 原则的天然满足）。
 *
 * 用例编排纪律（词汇/服务名的跨用例串扰防护）：
 * - 自定义事件词汇由首个 loadPlugins 用例首登记（宿主半词汇入册是装载管线
 *   职责——直连 applyRow 的用例排在它之后，词汇已在册）；
 * - worker fixture 的 provide 服务名按行 config.slot 参数化——各行互不撞名
 *   （真注册表 TOOL_DUPLICATE/CONTEXT_SERVICE_EXISTS 同纪律在桩外的真面）。
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolDefinition, ToolsService } from '../contracts/tools.js';
import { createContext } from '../context/context.js';
import type { ContextScope } from '../context/types.js';
import { loadPlugins } from '../context/loader.js';
import { BRIDGE_METHOD_NOT_FOUND, BRIDGE_WORKER_EXITED } from '../contracts/errors.js';
import { spawnWorkerDomain, makeRowLoader, workerEntryUrl, type WorkerDomain } from './bootstrap.js';

/* ---------------- 测试基建 ---------------- */

/** 真 worker 子进程入口：本文件同目录的 worker.ts（vitest 下 import.meta.url 指源文件） */
const WORKER_URL = new URL('./worker.ts', import.meta.url);

/**
 * worker 域金样 fixture：provide 服务（名按 config.slot 参数化）+ effect 打点 +
 * 事件订阅 + 工具注册——宿主半各用例的公共载荷面。events 声明是宿主半词汇
 * 入册的数据源（loadPlugins 阶段① registerLiveEvent）。
 */
const FX_WORKER = `
export const name = 'fx-worker';
export const events = [{ name: 'fx/tick', mode: 'emit', note: 'bridge e2e 测试事件' }];
export default async function apply(ctx, config) {
  const seen = [];
  ctx.provide('fx/taps-' + config.slot, {
    list: () => seen,
    add: (a, b) => a + b,
    hang: () => new Promise(() => {}),
  });
  ctx.effect(() => { seen.push('e1'); return () => {}; });
  ctx.on('fx/tick', (v) => { seen.push('tick:' + String(v)); });
  ctx.get('tools').register({
    name: 'fx/wt',
    description: 'fixture 工具',
    parameters: { type: 'object', properties: {} },
    execute: async (args) => ({ content: [{ type: 'text', text: 'wt:' + JSON.stringify(args) }] }),
  });
}
`;

/** main 域消费 fixture：inject worker 行 provide 的服务（slot-k 专用）——Kahn 跨域混排用 */
const FX_CONSUMER = `
export const name = 'fx-consumer';
export const inject = ['fx/taps-k'];
export default async function apply(ctx) {
  const taps = ctx.get('fx/taps-k');
  const value = await taps.list();
  ctx.provide('fx/main-saw', { value });
}
`;

/**
 * 最小工具服务桩：register 记录 + get 查回 + 注销器记录（桥接工具注册的宿主
 * 物化断言面——register 返回注销器是真 ToolsService 契约面，行回卷摘除断言用）
 */
class FakeTools {
  readonly defs = new Map<string, ToolDefinition>();
  /** 已摘除的工具名序列（行回卷联动的观测面） */
  readonly removed: string[] = [];
  register(def: ToolDefinition): () => void {
    this.defs.set(def.name, def);
    return () => {
      this.defs.delete(def.name);
      this.removed.push(def.name);
    };
  }
  get(name: string): ToolDefinition | undefined {
    return this.defs.get(name);
  }
}

/** 轮询直到谓词为真（unload 联动等异步到达面的确定性等待；谓词可同步可异步） */
async function until(predicate: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
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

/* ---------------- 共享域（tsx worker 冷启 ~1s——beforeAll 一次起域多用例复用） ---------------- */

let domain: WorkerDomain;
let root: ContextScope;
let tools: FakeTools;
let fixtureDir: string;
let workerEntry: string;
/** 共享域意外死亡记录（it5 断言主动收尾不落此——事故面观测） */
const unexpectedExits: Array<{ workerId: string; code: number; rows: readonly string[] }> = [];

beforeAll(async () => {
  fixtureDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'bridge-host-')));
  workerEntry = join(fixtureDir, 'fx-worker.ts');
  writeFileSync(workerEntry, FX_WORKER);
  writeFileSync(join(fixtureDir, 'fx-consumer.ts'), FX_CONSUMER);
  root = createContext({ name: 'bridge-host-test' });
  tools = new FakeTools();
  domain = spawnWorkerDomain({
    root,
    // 结构面桩（桥接语义真跑——注册表本体非被测件；FakeTools 的窄面断言到
    // ToolsService：register/get 是 bootstrap.ts 消费的两面，结构兼容即可）
    tools: tools as unknown as ToolsService,
    workerUrl: WORKER_URL,
    workerId: 'e2e-worker',
    execArgv: ['--import=tsx'],
    // 共享域意外死亡观测面（正常用例流不该有意外死亡——it5 terminate 是主动收尾）
    onExit: (info) => unexpectedExits.push(info),
  });
  // 等域就绪：svc.load 探活（handler 挂好前 ask 会被丢弃——探到即全就绪）
  await until(
    () =>
      domain.endpoint.call('svc', 'load', [{ id: '__probe__', entry: workerEntry }]).then(
        () => true,
        () => false,
      ),
    20_000,
  );
});

afterAll(async () => {
  domain?.terminate('测试收尾');
  await root?.dispose().catch(() => undefined);
  rmSync(fixtureDir, { recursive: true, force: true });
});

/* ---------------- 端到端用例（声明序即执行序：loadPlugins 用例先行做词汇首登记） ---------------- */

describe('spawnWorkerDomain — 端到端（真 worker 子进程）', () => {
  it('makeRowLoader + loadPlugins：worker 行全管线激活 + Kahn 跨域混排（main 行 inject worker 服务）', async () => {
    const loader = makeRowLoader(domain);
    const result = await loadPlugins(
      root,
      [
        { id: 'w2', entry: workerEntry, runtime: 'worker', config: { slot: 'k' } },
        { id: 'c1', entry: join(fixtureDir, 'fx-consumer.ts') },
      ],
      { workerLoader: loader },
    );
    // 两行全激活、零失败（main 行的 inject 由 worker 行宿主物化满足——轮次混排不分域）
    expect(result.failed).toEqual([]);
    expect(result.activated.map((a) => a.id).sort()).toEqual(['c1', 'w2']);
    // main 行真消费了 worker 服务：list() 过桥取值 → provide 'fx/main-saw'
    const saw = root.get<{ value: string[] }>('fx/main-saw');
    expect(saw.value).toEqual(['e1']);
  });

  it('load → applyRow：宿主 provide 物化 + 代理方法过桥往返（直连面——词汇已由上例入册）', async () => {
    const meta = await domain.load({ id: 'w1', entry: workerEntry, runtime: 'worker' });
    expect(meta.name).toBe('fx-worker');
    const scope = root.fork({ name: 'w1', rowId: 'w1', builtinRow: false });
    // 行 config 走 applyRow 的 row 参数（与 loadPlugins activateOne 同源——slot 决定服务名）
    await domain.applyRow({ id: 'w1', runtime: 'worker', config: { slot: 'a' } }, scope);
    // 宿主侧物化：锚作用域可见（main 域消费方 Kahn inject 的判据源）
    const taps = root.tryGet<Record<string, (...args: unknown[]) => Promise<unknown>>>('fx/taps-a');
    expect(taps).toBeDefined();
    // 代理方法调用过桥：真往返 worker 域实现
    await expect(taps!['add']!(2, 3)).resolves.toBe(5);
    // 行回卷兜底（本用例自持作用域——不影响后续用例的服务名空间）
    await scope.dispose();
  });

  it('工具注册宿主物化：def 落桩注册表 + execute 过桥回 worker 执行体', async () => {
    await domain.load({ id: 'w3', entry: workerEntry, runtime: 'worker' });
    const scope = root.fork({ name: 'w3', rowId: 'w3', builtinRow: false });
    await domain.applyRow({ id: 'w3', runtime: 'worker', config: { slot: 't' } }, scope);
    // 声明面物化：注册表拿到 def（execute 是宿主侧 thunk——非函数克隆而是桥接翻译）
    const def = tools.get('fx/wt');
    expect(def).toBeDefined();
    expect(def!.description).toBe('fixture 工具');
    // execute 过桥：真调 worker 域执行体，结果原样回传
    const result = (await def!.execute({ x: 9 }, { toolCallId: 'tc-e2e', signal: new AbortController().signal })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'wt:{"x":9}' });
    await scope.dispose();
  });

  it('行回卷联动：行作用域 dispose → 宿主绑定清 + svc.unload 到达（worker 行状态自清）', async () => {
    await domain.load({ id: 'w4', entry: workerEntry, runtime: 'worker' });
    const scope = root.fork({ name: 'w4', rowId: 'w4', builtinRow: false });
    await domain.applyRow({ id: 'w4', runtime: 'worker', config: { slot: 'u' } }, scope);
    await scope.dispose();
    // 卸载联动是 fire-and-forget——轮询等 worker 侧行状态清（服务不可达）
    await until(async () => {
      try {
        await domain.endpoint.call('svc', 'invoke', ['w4', 'fx/taps-u', 'add', []]);
        return false;
      } catch (err) {
        return (err as { code?: string }).code === BRIDGE_METHOD_NOT_FOUND;
      }
    });
  });

  it('工具注册随行回卷摘除：register 注销器挂行作用域 effect——scope.dispose 即摘', async () => {
    await domain.load({ id: 'w6', entry: workerEntry, runtime: 'worker' });
    const scope = root.fork({ name: 'w6', rowId: 'w6', builtinRow: false });
    await domain.applyRow({ id: 'w6', runtime: 'worker', config: { slot: 'r' } }, scope);
    expect(tools.get('fx/wt')).toBeDefined();
    await scope.dispose();
    await until(async () => tools.removed.includes('fx/wt'));
    expect(tools.get('fx/wt')).toBeUndefined();
  });

  it('terminate 域死：在途调用以 BRIDGE_WORKER_EXITED 结算、后续调用即刻拒绝；主动收尾不叫 onExit（非事故）', async () => {
    await domain.load({ id: 'w5', entry: workerEntry, runtime: 'worker' });
    const scope = root.fork({ name: 'w5', rowId: 'w5', builtinRow: false });
    await domain.applyRow({ id: 'w5', runtime: 'worker', config: { slot: 'd' } }, scope);
    // 挂起在途调用（hang 永不结算）→ terminate → 域死结算
    const inflight = root.get<Record<string, (...args: unknown[]) => Promise<unknown>>>('fx/taps-d')!['hang']!();
    domain.terminate('测试域死结算');
    const err = await rejection(inflight);
    expect(err.code).toBe(BRIDGE_WORKER_EXITED);
    // 端点已 dispose：新调用即刻拒绝
    const refused = await rejection(domain.endpoint.call('svc', 'invoke', ['w5', 'fx/taps-d', 'add', []]));
    expect(refused.code).toBe(BRIDGE_WORKER_EXITED);
    // 等 exit 事件处理跑完（terminate 异步）——主动收尾不触发意外死亡通知
    await domain.worker.terminate();
    expect(unexpectedExits).toEqual([]);
  });

  it('意外死亡（绕过 terminate 直杀 worker）：行作用域回卷 + onExit 归因（rows 带行 id）', async () => {
    // 独立第二域：共享域已在上一用例 terminate——域死回卷语义需要活域观测
    const exits: Array<{ workerId: string; code: number; rows: readonly string[] }> = [];
    const domain2 = spawnWorkerDomain({
      root,
      tools: tools as unknown as ToolsService,
      workerUrl: WORKER_URL,
      workerId: 'e2e-worker-2',
      execArgv: ['--import=tsx'],
      onExit: (info) => exits.push(info),
    });
    await until(
      () =>
        domain2.endpoint.call('svc', 'load', [{ id: '__probe__', entry: workerEntry }]).then(
          () => true,
          () => false,
        ),
      20_000,
    );
    await domain2.load({ id: 'wx', entry: workerEntry, runtime: 'worker' });
    const scope = root.fork({ name: 'wx', rowId: 'wx', builtinRow: false });
    await domain2.applyRow({ id: 'wx', runtime: 'worker', config: { slot: 'x' } }, scope);
    expect(root.tryGet('fx/taps-x')).toBeDefined();
    // 绕过 domain.terminate（不置主动标记）直杀底层 worker = 模拟意外死亡
    await domain2.worker.terminate();
    // 域死回卷：宿主物化随行作用域消失 + onExit 一次性归因
    await until(() => exits.length > 0);
    expect(exits[0]!.rows).toEqual(['wx']);
    expect(exits[0]!.workerId).toBe('e2e-worker-2');
    await until(() => root.tryGet('fx/taps-x') === undefined);
  });

  it('workerEntryUrl：按宿主半自身形态判别 worker 同伴入口（.ts 源 → worker.ts / 编译产物 → worker.js）', () => {
    expect(workerEntryUrl('file:///repo/dist/bridge/bootstrap.js').href).toBe('file:///repo/dist/bridge/worker.js');
    expect(workerEntryUrl('file:///repo/src/bridge/bootstrap.ts').href).toBe('file:///repo/src/bridge/worker.ts');
  });
});

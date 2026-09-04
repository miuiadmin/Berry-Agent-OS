/**
 * bridge — worker 半单元测试（契约篇 §1.7，第二十七批刀二 K3-b2）。
 *
 * 纪律对照：不 mock worker.ts 任何内部——MessageChannel 端口对直连
 * startWorkerRealm（同线程两端口，无需真起 worker_threads 子进程），
 * fixture 是磁盘上的真 .ts 文件经与生产相同的 jiti 路径装载；宿主端用
 * 裸 BridgeEndpoint + 记录型 host 处理器（桥接语义是真跑，宿主服务面
 * 是测试桩——「mock 停在边界外」）。
 *
 * 覆盖面：svc.load 元数据过界 / svc.apply 桩 ctx 全景 + 注册结算排水 /
 * svc.invoke 服务分派与信封保码 / evt 回投 / tool-invoke / unload LIFO
 * 回卷 / apply 失败回卷 / 收窄面 / 取消传播与迟到纪律。
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertExperimentalDeclared } from '../contracts/api.js';
/* 就绪度审计 20260903 P0 回归锁基建：裁决核 passthrough spy（真实现照常执法，
 * 只观察「必经裁决核」）——realm 与宿主同进程同模块图，loader 的 import 被
 * 此 mock 拦截（worker realm 在线程内经 MessageChannel 起跑，模块实例共享） */
vi.mock('../contracts/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../contracts/api.js')>();
  return { ...actual, assertExperimentalDeclared: vi.fn(actual.assertExperimentalDeclared) };
});
import {
  AppError,
  BRIDGE_CANCELLED,
  BRIDGE_CALL_TIMEOUT,
  BRIDGE_HANDLER_FAILED,
  BRIDGE_METHOD_NOT_FOUND,
  BRIDGE_SURFACE_NARROWED,
  APP_IMPORT_FORBIDDEN,
  APP_LOAD_FAILED,
  APP_SHAPE_INVALID,
} from '../contracts/errors.js';
import { BridgeEndpoint } from './session.js';
import { startWorkerRealm } from './worker.js';

/* ---------------- 测试基建 ---------------- */

/** 临时 fixture 目录（realpath 归一——macOS /var 与 /private/var 差异教训） */
function makeFixtureDir(): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'bridge-worker-')));
}

/** 写一个 fixture 应用源文件，返回入口绝对路径 */
function writeApp(dir: string, file: string, source: string): string {
  const entry = join(dir, file);
  writeFileSync(entry, source);
  return entry;
}

/**
 * 全景金样 fixture：provide 服务（四方法）+ 双 effect（LIFO 观测）+ 事件订阅 +
 * 工具注册 + logger 上行 + config/tryGet 快照读出——apply 桩面一次装齐。
 * 手写 JSON Schema（不 import typebox——config 本就允许手写，且免拓扑误扫）。
 */
const FX_MAIN = `
export const name = 'fx-worker';
export const config = { type: 'object', properties: { greet: { type: 'string' } } };
export default async function apply(ctx, config) {
  const seen = [];
  ctx.provide('fx/taps', {
    list: () => seen,
    add: (a, b) => a + b,
    boom: () => { throw new Error('worker 内业务失败'); },
    hang: () => new Promise(() => {}),
  });
  ctx.effect(() => { seen.push('e1'); return () => ctx.logger.warn('d1'); });
  ctx.effect(() => { seen.push('e2'); return () => ctx.logger.warn('d2'); });
  ctx.on('fx/tick', (v) => { seen.push('tick:' + String(v)); });
  ctx.get('tools').register({
    name: 'fx/wt',
    description: 'fixture 工具',
    parameters: { type: 'object', properties: {} },
    execute: async (args) => ({ content: [{ type: 'text', text: 'wt:' + JSON.stringify(args) }] }),
  });
  seen.push('cfg:' + config.greet);
  seen.push('tryGet:maybe=' + (ctx.tryGet('maybe-svc') !== undefined) + ',other=' + (ctx.tryGet('not-declared') !== undefined));
  ctx.logger.warn('from-worker', { a: 1 });
}
`;

/** apply 失败回卷 fixture：provide 先落、default 中途抛错 */
const FX_FAIL = `
export const name = 'fx-fail';
export default async function apply(ctx) {
  ctx.provide('fx/fail-taps', { ok: () => 'registered' });
  throw new Error('apply 半途爆炸');
}
`;

/** 形状非法 fixture：default 非函数（svc.load 装载校验面） */
const FX_BAD_SHAPE = `
export const name = 'fx-bad-shape';
export default 42;
`;

/** 收窄面 fixture：default 调 waterfall（同步收窄清单执法） */
const FX_NARROW = `
export const name = 'fx-narrow';
export default async function apply(ctx) {
  ctx.waterfall('whatever');
}
`;

/** 挂起取消 fixture：default 观察 ctx.signal——abort 后标记并正常返还（迟到 result 面） */
const FX_HANG = `
export const name = 'fx-hang';
export default async function apply(ctx) {
  const seen = [];
  ctx.provide('fx/hang-taps', { list: () => seen });
  await new Promise((resolve) => ctx.signal.addEventListener('abort', () => { seen.push('aborted'); resolve(); }, { once: true }));
}
`;

/** 信封保码 fixture：宿主 svc-invoke 桩抛 AppError——default 捕获后把码写进可读面 */
const FX_ENVELOPE = `
export const name = 'fx-envelope';
export default async function apply(ctx) {
  const codes = [];
  ctx.provide('fx/env-taps', { codes: () => codes });
  try { await ctx.get('any-svc').anyMethod(); } catch (err) { codes.push(err.code); }
}
`;

/** 宿主服务代理腿预算 fixture（A19 腿二，第十一轮遗漏大扫 20260904-b）：default
 *  直取未声明宿主服务（缺省宿主代理面）并 await——hangSvcInvoke 桩下永不结算，
 *  修后由 svcCallTimeoutMs 到点以 BRIDGE_CALL_TIMEOUT 结算；码经 tap 服务回读 */
const FX_SVC_TIMEOUT = `
export const name = 'fx-svc-timeout';
export default async function apply(ctx) {
  const codes = [];
  ctx.provide('fx/svc-timeout-taps', { codes: () => codes });
  try { await ctx.get('fx-hang-host').hang(); } catch (err) { codes.push(err.code); }
}
`;

/** 侧门双封 fixture（R1 复盘批二）：声明 optionalInject:['tools'] 后 tryGet——
 * 修复前拿到宿主服务代理（register 走 svc-invoke('tools',...) → 测试桩抛
 * METHOD_NOT_FOUND）；修复后拿到本地桩（register 走 tools-register 帧成功） */
const FX_TOOLS_SIDEDOOR = `
export const name = 'fx-sidedoor';
export default async function apply(ctx) {
  const seen = [];
  ctx.provide('fx/sidedoor-taps', { seen: () => seen });
  const t = ctx.tryGet('tools');
  seen.push('defined=' + (t !== undefined));
  if (t !== undefined) {
    try {
      await t.register({
        name: 'fx/sd',
        description: '侧门探针',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'sd' }] }),
      });
      seen.push('register:ok');
    } catch (err) {
      seen.push('register:err:' + err.code);
    }
  }
}
`;

/** 亚下限预算 fixture（定向复扫 20260902 第七轮 M-1）：声明 timeoutMs 500——
 * 分域声明面就该钳至 1000ms 下限再过界。宿主侧 registry 只钳存储副本（管道
 * 预算腿），execute 闭包按 meta 原值起桥预算（session setTimeout 腿）——修前
 * 500 原样过界，分域工具被亚下限值杀而主域同值享 1000ms 下限（「不换协议
 * 只换载体」等价性破）；修后声明面单点钳位，两腿同值 */
const FX_TOOL_FLOOR = `
export const name = 'fx-tool-floor';
export default async function apply(ctx) {
  ctx.get('tools').register({
    name: 'fx/floor',
    description: '亚下限预算探针',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 500,
    execute: async () => ({ content: [{ type: 'text', text: 'floor' }] }),
  });
}
`;

/** 直连域：MessageChannel 两端各挂一个端点（worker 端 = 被测件；宿主端 = 记录型桩）
 * host = 宿主端点（测试驱动面）；registered/subs/unsubs/toolRegs/logs/dropped =
 * 宿主侧记录面；close() = dispose 双端 + 关端口。opts = 注入面：
 * rejectSvcRegister（svc-register 桩改抛）/ hangSvcInvoke（svc-invoke 桩永不
 * 结算——A19 腿二红锁的域侧真实现挂死形态）/ svcCallTimeoutMs（域半宿主服务
 * 代理预算覆写——60s 缺省在测试形态不可观察，测试专用面）。 */
interface TestChannel {
  /** 宿主端点（测试驱动面） */
  host: BridgeEndpoint;
  /** 宿主侧记录：svc-register [rowId, name] 调用序列 */
  registered: Array<[string, string]>;
  /** 宿主侧记录：sub [rowId, event] 调用序列 */
  subs: Array<[string, string]>;
  /** 宿主侧记录：unsub [rowId, event] 调用序列（O-1 退订对称面观测位） */
  unsubs: Array<[string, string]>;
  /** 宿主侧记录：tools-register 载荷 */
  toolRegs: unknown[];
  /** 宿主侧记录：log 上行载荷 */
  logs: Array<{ rowId: string; level: string; message: string }>;
  /** 宿主侧记录：丢弃消息（迟到纪律断言面） */
  dropped: unknown[];
  /** 收尾（dispose 双端 + 关端口） */
  close(): void;
}

/** 建直连域 + 记录型宿主桩（svc-invoke 故意抛保码 AppError——信封链路断言用）。
 * rejectSvcRegister = svc-register 桩改抛（L-7 迟到注册失败形态的注入面）；
 * hangSvcInvoke = svc-invoke 桩永不结算（A19 腿二注入面）；svcCallTimeoutMs =
 * 域半宿主服务代理预算覆写（透传 startWorkerRealm） */
function makeChannel(opts?: {
  rejectSvcRegister?: boolean;
  hangSvcInvoke?: boolean;
  svcCallTimeoutMs?: number;
}): TestChannel {
  const { port1, port2 } = new MessageChannel();
  const registered: Array<[string, string]> = [];
  const subs: Array<[string, string]> = [];
  const unsubs: Array<[string, string]> = [];
  const toolRegs: unknown[] = [];
  const logs: TestChannel['logs'] = [];
  const dropped: unknown[] = [];
  const host = new BridgeEndpoint(port1, {
    onTell: (event, payload) => {
      if (event !== 'log') return;
      logs.push(payload as TestChannel['logs'][number]);
    },
    onDropped: (m) => dropped.push(m),
  });
  host
    .handle('host', 'svc-register', ([rowId, name]) => {
      if (opts?.rejectSvcRegister) {
        throw new AppError(BRIDGE_METHOD_NOT_FOUND, '宿主测试桩拒收 svc-register（注入）');
      }
      registered.push([String(rowId), String(name)]);
    })
    .handle('host', 'sub', ([rowId, event]) => {
      subs.push([String(rowId), String(event)]);
    })
    .handle('host', 'unsub', ([rowId, event]) => {
      unsubs.push([String(rowId), String(event)]);
    })
    .handle('host', 'emit', () => undefined)
    .handle('host', 'tools-register', (args) => {
      toolRegs.push(args);
    })
    /* 宿主服务桩：缺省保码抛 METHOD_NOT_FOUND——worker 侧桩的错误信封回卷链路借此可断言；
     * hangSvcInvoke = 永不结算（A19 腿二——域侧 svc-invoke 真实现挂死的对端形态） */
    .handle('host', 'svc-invoke', ([name, method]) => {
      if (opts?.hangSvcInvoke) return new Promise<never>(() => {});
      throw new AppError(BRIDGE_METHOD_NOT_FOUND, `宿主测试桩无此服务方法：${String(name)}.${String(method)}`);
    })
    .handle('host', 'tool-run', () => {
      throw new AppError(BRIDGE_METHOD_NOT_FOUND, '宿主测试桩不提供 tool-run');
    });
  const worker = startWorkerRealm(port2, 'test-worker', {
    // 域半宿主服务代理预算覆写（A19 腿二测试专用面——缺省 60s 不可观察）
    svcCallTimeoutMs: opts?.svcCallTimeoutMs,
  });
  return {
    host,
    registered,
    subs,
    unsubs,
    toolRegs,
    logs,
    dropped,
    close() {
      host.dispose('测试收尾');
      worker.dispose('测试收尾');
      port1.close();
      port2.close();
    },
  };
}

/** 轮询直到谓词为真（evt 回投等异步到达面的确定性等待——上限内 20ms 步进） */
async function until(predicate: () => Promise<boolean>, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect.unreachable(`轮询超时（${ms}ms）——异步面未到达`);
}

/** 直连域登记（afterEach 统一收尾防泄漏） */
const channels: TestChannel[] = [];
/** fixture 目录登记（afterEach 统一删除） */
const dirs: string[] = [];
afterEach(() => {
  while (channels.length > 0) channels.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** 建域 + 建 fixture 目录（双登记） */
function setup(): { ch: TestChannel; dir: string } {
  const ch = makeChannel();
  channels.push(ch);
  const dir = makeFixtureDir();
  dirs.push(dir);
  return { ch, dir };
}

/** 取 reject 的错误（非 AppError 抛出时让用例失败并显示原值） */
async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const err = await promise.then(
    () => {
      throw new Error('预期 reject，实际 resolve');
    },
    (e: unknown) => e,
  );
  if (!(err instanceof AppError)) throw err;
  return err;
}

/* ---------------- svc.load：worker 半装载 ---------------- */

describe('startWorkerRealm — svc.load（装载校验与元数据过界）', () => {
  it('meta 五面过界：name/手写 config schema 原样克隆、未声明字段不占位', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-main.ts', FX_MAIN);
    const meta = await ch.host.call<Record<string, unknown>>('svc', 'load', [
      { id: 'fx', entry, sandbox: { carrier: 'worker' } },
    ]);
    expect(meta['name']).toBe('fx-worker');
    expect(JSON.stringify(meta['config'])).toContain('greet');
    // 未声明的 inject/optionalInject/events/skills 不占位（宿主侧按 undefined 判缺省）
    expect(meta['inject']).toBeUndefined();
    expect(meta['optionalInject']).toBeUndefined();
    expect(meta['events']).toBeUndefined();
    expect(meta['skills']).toBeUndefined();
  });

  it('形状非法保码过界：default 非函数 → APP_SHAPE_INVALID 信封', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-bad.ts', FX_BAD_SHAPE);
    const err = await rejection(ch.host.call('svc', 'load', [{ id: 'fx', entry }]));
    expect(err.code).toBe(APP_SHAPE_INVALID);
  });
});

/* ---------------- svc.apply：桩 ctx 全景 + 注册排水 ---------------- */

describe('startWorkerRealm — svc.apply（桩 ctx 与注册结算）', () => {
  it('全景：apply 返回即宿主注册全落定（排水语义）+ logger 上行 + config 冻结 + tryGet 快照', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-main.ts', FX_MAIN);
    await ch.host.call('svc', 'load', [{ id: 'fx', entry }]);
    await ch.host.call('svc', 'apply', ['fx', { greet: 'hi' }, { 'maybe-svc': true }]);
    // 注册排水：apply 的 result 到达 = 全部过界注册已落定（时序确定性）
    expect(ch.registered).toEqual([['fx', 'fx/taps']]);
    expect(ch.subs).toEqual([['fx', 'fx/tick']]);
    expect(ch.toolRegs).toHaveLength(1);
    expect((ch.toolRegs[0] as unknown[])[1]).toMatchObject({ name: 'fx/wt' });
    // logger 单向上行已到达宿主
    expect(ch.logs.some((l) => l.message === 'from-worker')).toBe(true);
    // config 快照 + tryGet 在场快照（声明的 optionalInject 命中、未声明 undefined）
    const seen = (await ch.host.call('svc', 'invoke', ['fx', 'fx/taps', 'list', []])) as string[];
    expect(seen).toContain('cfg:hi');
    expect(seen).toContain('tryGet:maybe=true,other=false');
  });

  it('收窄面：waterfall 调用 → apply 失败信封 BRIDGE_SURFACE_NARROWED（宁响亮不静默）', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-narrow.ts', FX_NARROW);
    await ch.host.call('svc', 'load', [{ id: 'fx', entry }]);
    const err = await rejection(ch.host.call('svc', 'apply', ['fx', {}, {}]));
    expect(err.code).toBe(BRIDGE_SURFACE_NARROWED);
  });

  it('tryGet("tools") 特判拦截（R1 复盘批二侧门双封）：optionalInject 声明后拿到本地桩非宿主代理', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-sidedoor.ts', FX_TOOLS_SIDEDOOR);
    await ch.host.call('svc', 'load', [{ id: 'fx', entry }]);
    // presence['tools']=true（宿主激活探测命中——本测试的宿主桩直接给真值）
    await ch.host.call('svc', 'apply', ['fx', {}, { tools: true }]);
    const seen = (await ch.host.call('svc', 'invoke', ['fx', 'fx/sidedoor-taps', 'seen', []])) as string[];
    // 修复前：tryGet 无特判 → makeHostServiceProxy → register 走
    // svc-invoke('tools','register') → 测试桩保码抛 → seen 落
    // 'register:err:BRIDGE_METHOD_NOT_FOUND'（本例必红）
    expect(seen).toContain('defined=true');
    expect(seen).toContain('register:ok');
    // 工具注册走 tools-register 帧（本地桩行为面）——svc-invoke 通道零 'tools' 帧
    expect(ch.toolRegs.some((r) => JSON.stringify(r).includes('fx/sd'))).toBe(true);
  });

  it('工具注册亚下限 timeoutMs 声明面钳位（第七轮 M-1）：500 过界即钳 1000——主域同律', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-floor.ts', FX_TOOL_FLOOR);
    await ch.host.call('svc', 'load', [{ id: 'fx', entry }]);
    await ch.host.call('svc', 'apply', ['fx', {}, {}]);
    // tools-register 帧 = [rowId, meta, domain]——meta[1] 是声明面五字段结构化
    const frame = ch.toolRegs.find((r) => JSON.stringify(r).includes('fx/floor'));
    expect(frame).toBeDefined();
    const meta = (frame as unknown[])[1] as { timeoutMs?: number };
    // 修前：meta.timeoutMs === 500 原样过界（宿主 execute 闭包按原值起桥预算
    // → ~500ms 收 BRIDGE_CALL_TIMEOUT；主域同值经 registry 钳位享 1000ms）
    expect(meta.timeoutMs).toBe(1000);
  });
});

/* ---------------- svc.invoke：宿主 → worker 服务分派 ---------------- */

describe('startWorkerRealm — svc.invoke（服务分派与错误信封）', () => {
  it('方法分派：参数原样过界、返回值原样回传', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-main.ts', FX_MAIN);
    await ch.host.call('svc', 'load', [{ id: 'fx', entry }]);
    await ch.host.call('svc', 'apply', ['fx', { greet: 'hi' }, {}]);
    await expect(ch.host.call('svc', 'invoke', ['fx', 'fx/taps', 'add', [1, 2]])).resolves.toBe(3);
  });

  it('非 AppError 异常入桶：BRIDGE_HANDLER_FAILED + 原始 message', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-main.ts', FX_MAIN);
    await ch.host.call('svc', 'load', [{ id: 'fx', entry }]);
    await ch.host.call('svc', 'apply', ['fx', {}, {}]);
    const err = await rejection(ch.host.call('svc', 'invoke', ['fx', 'fx/taps', 'boom', []]));
    expect(err.code).toBe(BRIDGE_HANDLER_FAILED);
    expect(err.message).toContain('worker 内业务失败');
  });

  it('缺服务/缺方法：BRIDGE_METHOD_NOT_FOUND（宁响亮不静默）', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-main.ts', FX_MAIN);
    await ch.host.call('svc', 'load', [{ id: 'fx', entry }]);
    await ch.host.call('svc', 'apply', ['fx', {}, {}]);
    const missing = await rejection(ch.host.call('svc', 'invoke', ['fx', 'fx/taps', 'nope', []]));
    expect(missing.code).toBe(BRIDGE_METHOD_NOT_FOUND);
    const noRow = await rejection(ch.host.call('svc', 'invoke', ['ghost', 'fx/taps', 'add', []]));
    expect(noRow.code).toBe(BRIDGE_METHOD_NOT_FOUND);
  });

  it('宿主→worker 保码链：桩 ctx get(...) 的调用错误信封回 worker 保码（AppError 家族词）', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-env.ts', FX_ENVELOPE);
    await ch.host.call('svc', 'load', [{ id: 'fx', entry }]);
    await ch.host.call('svc', 'apply', ['fx', {}, {}]);
    // 宿主 svc-invoke 桩抛 METHOD_NOT_FOUND → worker 桩 catch 后码写进可读面
    const codes = (await ch.host.call('svc', 'invoke', ['fx', 'fx/env-taps', 'codes', []])) as string[];
    expect(codes).toEqual([BRIDGE_METHOD_NOT_FOUND]);
  });

  it('宿主服务代理腿预算：域内调宿主 svc 永不结算 → svcCallTimeoutMs 到点 BRIDGE_CALL_TIMEOUT（A19 腿二，修前红：代理调用无预算 apply 永挂）', async () => {
    const ch = makeChannel({ hangSvcInvoke: true, svcCallTimeoutMs: 300 });
    channels.push(ch);
    const dir = makeFixtureDir();
    dirs.push(dir);
    const entry = writeApp(dir, 'fx-svc-timeout.ts', FX_SVC_TIMEOUT);
    await ch.host.call('svc', 'load', [{ id: 'fx', entry, sandbox: { carrier: 'worker' } }]);
    // apply 内 await 挂死调用：修后 300ms 到点结算 BRIDGE_CALL_TIMEOUT → apply 收束
    await ch.host.call('svc', 'apply', ['fx', {}, {}]);
    const codes = (await ch.host.call('svc', 'invoke', ['fx', 'fx/svc-timeout-taps', 'codes', []])) as string[];
    expect(codes).toEqual([BRIDGE_CALL_TIMEOUT]);
  }, 10_000);
});

/* ---------------- 事件回投与工具执行 ---------------- */

describe('startWorkerRealm — evt 回投与 tool-invoke', () => {
  it('宿主 tell(evt) → worker 行处理器收到参数', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-main.ts', FX_MAIN);
    await ch.host.call('svc', 'load', [{ id: 'fx', entry }]);
    await ch.host.call('svc', 'apply', ['fx', {}, {}]);
    ch.host.tell('evt', { rowId: 'fx', event: 'fx/tick', args: [7] });
    await until(async () => {
      const seen = (await ch.host.call('svc', 'invoke', ['fx', 'fx/taps', 'list', []])) as string[];
      return seen.includes('tick:7');
    });
  });

  it('tool-invoke：执行体留在 worker 域、宿主侧只发载荷；缺执行体 METHOD_NOT_FOUND', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-main.ts', FX_MAIN);
    await ch.host.call('svc', 'load', [{ id: 'fx', entry }]);
    await ch.host.call('svc', 'apply', ['fx', {}, {}]);
    const result = (await ch.host.call('svc', 'tool-invoke', ['fx', 'fx/wt', { x: 1 }, { toolCallId: 'tc-1' }])) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'wt:{"x":1}' });
    const missing = await rejection(ch.host.call('svc', 'tool-invoke', ['fx', 'no-such-tool', {}, {}]));
    expect(missing.code).toBe(BRIDGE_METHOD_NOT_FOUND);
  });
});

/* ---------------- unload 与失败回卷 ---------------- */

describe('startWorkerRealm — unload 与 apply 失败回卷', () => {
  it('unload：effect 栈 LIFO 逆序回卷（d2 → d1）+ 行状态清（后续 invoke 拒绝）', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-main.ts', FX_MAIN);
    await ch.host.call('svc', 'load', [{ id: 'fx', entry }]);
    await ch.host.call('svc', 'apply', ['fx', {}, {}]);
    const logsBefore = ch.logs.filter((l) => l.message === 'd1' || l.message === 'd2').length;
    await ch.host.call('svc', 'unload', ['fx']);
    // LIFO：d2 先于 d1 上行（effect 后进先出——与宿主作用域同纪律）
    await until(async () => ch.logs.filter((l) => l.message === 'd1' || l.message === 'd2').length >= 2);
    const unwind = ch.logs.filter((l) => l.message === 'd1' || l.message === 'd2').map((l) => l.message);
    expect(logsBefore).toBe(0);
    expect(unwind).toEqual(['d2', 'd1']);
    // 行注册面已关闭：服务分派响亮拒绝不留暗残骸
    const err = await rejection(ch.host.call('svc', 'invoke', ['fx', 'fx/taps', 'add', []]));
    expect(err.code).toBe(BRIDGE_METHOD_NOT_FOUND);
  });

  it('apply 失败同路回卷：reject 保码 + worker 行状态自清（宿主侧回卷归装载器）', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-fail.ts', FX_FAIL);
    await ch.host.call('svc', 'load', [{ id: 'fx', entry }]);
    const err = await rejection(ch.host.call('svc', 'apply', ['fx', {}, {}]));
    expect(err.code).toBe(BRIDGE_HANDLER_FAILED);
    expect(err.message).toContain('apply 半途爆炸');
    // worker 侧行状态已清：服务不可再达（宿主侧 provide 回卷由 loadApps 收尾）
    const gone = await rejection(ch.host.call('svc', 'invoke', ['fx', 'fx/fail-taps', 'ok', []]));
    expect(gone.code).toBe(BRIDGE_METHOD_NOT_FOUND);
  });
});

/* ---------------- 取消传播与迟到纪律 ---------------- */

describe('startWorkerRealm — 取消传播（apply 的入站 signal）', () => {
  it('宿主 abort → 本地立即结算 BRIDGE_CANCELLED；worker 观测 ctx.signal 后返还的迟到 result 被丢弃观测吸收', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-hang.ts', FX_HANG);
    await ch.host.call('svc', 'load', [{ id: 'fx', entry }]);
    const ctl = new AbortController();
    const applied = ch.host.call('svc', 'apply', ['fx', {}, {}], { signal: ctl.signal });
    // 让 ask 先发出（注册进 pending）再 abort——顺序不可反（未发出即 abort 时
    // onAbort 早已挂上，同样本地结算；此处测标准路径）
    await new Promise((resolve) => setTimeout(resolve, 30));
    ctl.abort();
    const err = await rejection(applied);
    expect(err.code).toBe(BRIDGE_CANCELLED);
    // worker 侧 default 在 signal abort 后正常返还 → 迟到 result 到达已结算的
    // pending 条目 → onDropped 吸收（迟到不复活不二次结算）
    await until(async () => ch.dropped.some((m) => (m as { kind?: string }).kind === 'result'));
    // 迟到结算的副作用照常发生（worker 侧 seen 已 push aborted——signal 观测面）
    await until(async () => {
      const seen = (await ch.host.call('svc', 'invoke', ['fx', 'fx/hang-taps', 'list', []])) as string[];
      return seen.includes('aborted');
    });
  });
});

/* ---------------- sub 幂等与退订对称面（遗漏大扫 20260901 O-1+L-7） ---------------- */

/** 双订阅 fixture：同事件两 handler + 退订控制面（O-1 扇出/退订锁的载荷） */
const FX_DBL = `
export const name = 'fx-dbl';
export default async function apply(ctx) {
  const seen = [];
  ctx.provide('fx/dbl-taps', { list: () => seen });
  const off1 = ctx.on('fx/pulse', () => { seen.push('h1'); });
  const off2 = ctx.on('fx/pulse', () => { seen.push('h2'); });
  ctx.provide('fx/dbl-ctl', { off1: () => off1(), off2: () => off2() });
}
`;

/** 迟到注册 fixture：apply 排水返还后异步 provide（L-7——注册 promise 无人 await 形态） */
const FX_LATE = `
export const name = 'fx-late';
export default async function apply(ctx) {
  setTimeout(() => { ctx.provide('fx/late-svc', {}); }, 10);
}
`;

describe('startWorkerRealm — sub 帧单发与退订对称面（O-1 worker 半回归锁）', () => {
  it('同事件双订阅 → 过界 sub 帧恰一条（0→1 单发；修复前每 on 一条——宿主侧 N 转发器扇出之源）', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-dbl.ts', FX_DBL);
    await ch.host.call('svc', 'load', [{ id: 'fx', entry }]);
    await ch.host.call('svc', 'apply', ['fx', {}, {}]);
    // 修复前：subs == [fx/pulse, fx/pulse]（每 ctx.on 一条 sub 帧）
    expect(ch.subs).toEqual([['fx', 'fx/pulse']]);
  });

  it('退订对称面：2→1 不发 unsub；1→0 发恰一条（修复前退订器不回传宿主——转发器残留累积）', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-dbl.ts', FX_DBL);
    await ch.host.call('svc', 'load', [{ id: 'fx', entry }]);
    await ch.host.call('svc', 'apply', ['fx', {}, {}]);
    // 摘 h1（2→1）：仍有 handler 在订阅——不发 unsub
    await ch.host.call('svc', 'invoke', ['fx', 'fx/dbl-ctl', 'off1', []]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ch.unsubs).toEqual([]);
    // 摘 h2（1→0）：最后一个 handler 清空 → 恰一条 unsub 回宿主
    await ch.host.call('svc', 'invoke', ['fx', 'fx/dbl-ctl', 'off2', []]);
    await until(async () => ch.unsubs.length > 0);
    expect(ch.unsubs).toEqual([['fx', 'fx/pulse']]);
  });

  it('迟到注册失败留 warn 痕不炸域（L-7：排水返还后的注册 promise 无人 await——teardown 竞窗 reject 不得成 unhandledRejection）', async () => {
    // 通道注入：宿主测试桩对 svc-register 一律拒收 → 一切注册 promise 都 reject
    const rejectCh = makeChannel({ rejectSvcRegister: true });
    channels.push(rejectCh);
    const dir = makeFixtureDir();
    dirs.push(dir);
    const entry = writeApp(dir, 'fx-late.ts', FX_LATE);
    await rejectCh.host.call('svc', 'load', [{ id: 'fx', entry }]);
    // apply 排水时零注册即返（迟到 provide 尚未发生）→ 10ms 后 provide 触达拒收桩
    await rejectCh.host.call('svc', 'apply', ['fx', {}, {}]);
    // 修复前：迟到注册 promise reject 无人接（unhandledRejection 面上炸域）；
    // 修复后：warn 日志上行留痕（「看不见的 bug 不允许靠进程日志独扛」——warn 即可见面）
    await until(async () => rejectCh.logs.some((l) => l.level === 'warn' && l.message.includes('过界注册迟到失败')));
    expect(rejectCh.registered).toEqual([]);
  });
});

/* ---------------- svc.load apiGate 过桥（就绪度审计 20260903 P0 回归锁） ---------------- */

describe('startWorkerRealm — svc.load 载荷 apiGate 过桥（API 声明门分域同面执法）', () => {
  /** 裁决核 spy（vi.fn 包装真实现——断言「必经裁决核」而非篡改结果） */
  const gateSpy = () => vi.mocked(assertExperimentalDeclared);

  it('lite 载荷门上下文进装载窗：声明集数组→Set + 应用归因（bootstrap/external domain.load 投影同形；修复前红：载荷字段无消费方）', async () => {
    gateSpy().mockClear();
    const { ch, dir } = setup();
    // 探针键用 berryagent 契约面（bridge 域白名单容虚拟名、typebox 禁——拓扑闸
    // 扫文件文本连 fixture 字符串一并执法；刀 G 后宿主驻留键在分域拒载，送达锁
    // 只关心「键过裁决核 + 声明集 + 归因」三参，键身份不承载语义）
    const entry = writeApp(
      dir,
      'fx-gate.ts',
      [
        "import { AppError } from 'berryagent';",
        "export const name = 'fx-gate';",
        'export const probe = typeof AppError;',
        'export default async function apply() {}',
      ].join('\n'),
    );
    const meta = (await ch.host.call('svc', 'load', [
      { id: 'g1', entry, apiGate: { appId: 'demo-app', experimental: [] } },
    ])) as { name: string };
    expect(meta.name).toBe('fx-gate');
    expect(gateSpy()).toHaveBeenCalledWith('berryagent', new Set(), 'demo-app');
  });

  it('载荷 apiGate 缺席 = 空门 fail-closed：裁决核仍必经（空声明集 + 行 id 归因；修复前红：门禁静默放行）', async () => {
    gateSpy().mockClear();
    const { ch, dir } = setup();
    const entry = writeApp(
      dir,
      'fx-gate2.ts',
      [
        "import { AppError } from 'berryagent';",
        "export const name = 'fx-gate2';",
        'export const probe = typeof AppError;',
        'export default async function apply() {}',
      ].join('\n'),
    );
    await ch.host.call('svc', 'load', [{ id: 'g2', entry }]);
    // 刀 G：分域 svc.load 门上下文恒在场（realm 位需要）——apiGate 缺席时归因
    // 缺省行 id（比旧「gate 整体缺席 → 未名 undefined」归因更准，fail-closed 不变）
    expect(gateSpy()).toHaveBeenCalledWith('berryagent', new Set(), 'g2');
  });

  it('宿主驻留键分域拒载：worker 域 import berryagent/llm → APP_IMPORT_FORBIDDEN + worker 载体归因（刀 G——契约篇 §1.2 桥接状态纪律终态；修复前红：分域静默 import 宿主活对象）', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(
      dir,
      'fx-host-resident.ts',
      [
        "import { hasApi } from 'berryagent/llm';",
        "export const name = 'fx-host-resident';",
        'export default async function apply() {}',
      ].join('\n'),
    );
    // 真线程域（svc.load 经 MessageChannel 过桥）：loader 线内锁之外的实弹腿
    const err = await rejection(ch.host.call('svc', 'load', [{ id: 'hr1', entry }]));
    expect(err.code).toBe(APP_IMPORT_FORBIDDEN);
    expect(err.message).toContain('宿主驻留面');
    expect(err.message).toContain('worker 载体');
    expect(err.message).toContain(`ctx.get('llm')`);
  });
});

describe('startWorkerRealm — svc.apply 载荷 hostFaceData 过桥（ctx.host 档位同面——§6.13.5 桥接档；就绪度审计 20260903 P3）', () => {
  /** 宿主自省面读出 fixture：ctx.host 各面经 tap 服务回读（svc.invoke 往返——
   * 结构化克隆只过纯数据，方法面在对岸物化后本域调用） */
  const FX_HOST_FACE = `
export const name = 'fx-hostface';
export default async function apply(ctx) {
  const h = ctx.host;
  ctx.provide('fx/hostface-taps', {
    version: () => (h === undefined ? '(absent)' : h.version),
    apiVersion: () => (h === undefined ? '(absent)' : h.apiVersion),
    formFactor: () => (h === undefined ? '(absent)' : h.formFactor),
    capHas: (n) => (h === undefined ? '(absent)' : h.capabilities.has(n)),
    capList: () => (h === undefined ? [] : [...h.capabilities.list()].sort()),
    expEnabled: (n) => (h === undefined ? '(absent)' : h.experimental.enabled(n)),
  });
}
`;

  /** tap 方法调用捷径（svc.invoke 三段载荷） */
  function tapCall(ch: { host: BridgeEndpoint }, rowId: string, method: string, ...args: unknown[]) {
    return ch.host.call('svc', 'invoke', [rowId, 'fx/hostface-taps', method, args]);
  }

  it('第 4 位载荷物化 ctx.host：五面全同值过河（修复前红：apply 载荷无 host 数据帧、ctx.host undefined）', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-hostface.ts', FX_HOST_FACE);
    await ch.host.call('svc', 'load', [{ id: 'h1', entry }]);
    // 合成数据（非真 readHostFaceData 产物）——断言「过河忠实于宿主所发」而非真目录值
    const hostFace = {
      version: '9.9.9-test',
      apiVersion: '9.9',
      formFactor: 'standalone',
      capabilities: ['memory.store', 'web.fetch'],
      experimentalKeys: [],
    };
    await ch.host.call('svc', 'apply', ['h1', {}, {}, hostFace]);
    await expect(tapCall(ch, 'h1', 'version')).resolves.toBe('9.9.9-test');
    await expect(tapCall(ch, 'h1', 'apiVersion')).resolves.toBe('9.9');
    await expect(tapCall(ch, 'h1', 'formFactor')).resolves.toBe('standalone');
    await expect(tapCall(ch, 'h1', 'capHas', 'memory.store')).resolves.toBe(true);
    await expect(tapCall(ch, 'h1', 'capHas', 'nope.cap')).resolves.toBe(false);
    await expect(tapCall(ch, 'h1', 'capList')).resolves.toEqual(['memory.store', 'web.fetch']);
    // 面在场语义：stable 键不在实验集 → false（enabled 只答 tier=experimental 在场）
    await expect(tapCall(ch, 'h1', 'expEnabled', 'typebox')).resolves.toBe(false);
  });

  it('载荷缺席 = ctx.host 成员缺席：不物化空面（宿主未注入形态的诚实呈现——undefined 不冒充数据面）', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-hostface.ts', FX_HOST_FACE);
    await ch.host.call('svc', 'load', [{ id: 'h2', entry }]);
    await ch.host.call('svc', 'apply', ['h2', {}, {}]);
    await expect(tapCall(ch, 'h2', 'version')).resolves.toBe('(absent)');
    await expect(tapCall(ch, 'h2', 'capList')).resolves.toEqual([]);
  });

  it('第 4 位载荷形状执法：病态 hostFaceData 拒收 APP_LOAD_FAILED（修前红：盲断言物化病态面后静默装载成功——遗漏大扫 20260904 #9）', async () => {
    const { ch, dir } = setup();
    const entry = writeApp(dir, 'fx-hostface.ts', FX_HOST_FACE);
    await ch.host.call('svc', 'load', [{ id: 'h9', entry }]);
    // 病态载荷（version 缺席 + capabilities 非数组）：宿主真链路只会发
    // readHostFaceData 产物，收到病态形 = 装载管线不变量被破坏，fail-loud 拒收
    const err = await rejection(
      ch.host.call('svc', 'apply', [
        'h9',
        {},
        {},
        { apiVersion: '9.9', formFactor: 'standalone', capabilities: 'nope' },
      ]),
    );
    expect(err.code).toBe(APP_LOAD_FAILED);
    expect(err.message).toContain('hostFaceData 形状非法');
  });
});

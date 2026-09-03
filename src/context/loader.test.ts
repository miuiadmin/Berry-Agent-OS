/**
 * L1 context — 应用加载器本体测试（真实 jiti 直载 .ts fixture + 虚拟注入端到端）。
 *
 * 纪律对照：不 mock 加载器任何内部——fixture 是磁盘上的真 .ts 文件，经与生产
 * 完全相同的 jiti 路径（虚拟模块 berryagent/typebox）装载；断言面 = 返回清单 +
 * root 服务注册表 + root 事件序列。测试文件只引 context 模块与 contracts
 * （拓扑白名单边），fixture 不引宿主内部实现（零 import 面，契约篇 §3）。
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createContext } from './context.js';
import { createAppJiti, importAppEntry, loadApps } from './loader.js';
import { chainCaller } from './chain.js';
import type { AppSkillsInfo } from './loader.js';
import type { ContextScope } from './types.js';
import {
  EVENT_DUPLICATE,
  APP_APPLY_FAILED,
  APP_APPLY_TIMEOUT,
  APP_CONFIG_INVALID,
  APP_IMPORT_FORBIDDEN,
  APP_INJECT_UNRESOLVED,
  APP_LOAD_FAILED,
  APP_SHAPE_INVALID,
} from '../contracts/errors.js';
import type { AppActivatedPayload, AppFailedPayload, AppPlanRow, AppSkippedPayload } from '../contracts/app.js';

/* ---------------- 测试基建 ---------------- */

/** 临时 fixture 目录（realpath 归一——macOS /var 与 /private/var 差异教训） */
function makeFixtureDir(): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ctx-loader-')));
}

/** 写一个 fixture 应用源文件，返回入口绝对路径 */
function writeApp(dir: string, file: string, source: string): string {
  const entry = join(dir, file);
  writeFileSync(entry, source);
  return entry;
}

/** 本用例根作用域登记（afterEach 统一回卷防泄漏） */
const roots: ContextScope[] = [];
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    await root.dispose().catch(() => undefined);
  }
});

/** 建根作用域 + 登记（loadApps 的 fork 锚） */
function makeRoot(): ContextScope {
  const root = createContext({ name: 'loader-test' });
  roots.push(root);
  return root;
}

/** 生命周期事件录音（三事件全录——序列断言用） */
function recordLifecycle(root: ContextScope) {
  const events: Array<{ kind: string; payload: unknown }> = [];
  root.on('app/activated', (payload: AppActivatedPayload) => events.push({ kind: 'activated', payload }));
  root.on('app/failed', (payload: AppFailedPayload) => events.push({ kind: 'failed', payload }));
  root.on('app/skipped', (payload: AppSkippedPayload) => events.push({ kind: 'skipped', payload }));
  return events;
}

/* ---------------- 虚拟注入 + 激活主路径 ---------------- */

describe('loadApps 虚拟注入与激活', () => {
  it('虚拟模块端到端：fixture 经 berryagent 取 AppError、经 typebox 建 schema，宿主 Value 同实例校验通过', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'happy.ts',
      [
        "import { AppError } from 'berryagent';",
        "import { Type } from 'typebox';",
        "export const name = 'happy';",
        'export const config = Type.Object({ greeting: Type.String() });',
        'export default async function apply(ctx, rowConfig) {',
        '  ctx.provide("fx/happy-marker", {',
        '    appErrorUsable: typeof AppError === "function" && new AppError("TEST_CODE", "x") instanceof Error,',
        '    schemaFromVirtualTypebox: typeof config === "object" && config !== null,',
        '    greeting: rowConfig.greeting,',
        '    configFrozen: Object.isFrozen(ctx.config),',
        '    configIsRowConfig: ctx.config === rowConfig,',
        '  });',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'happy', entry, config: { greeting: '你好' } }]);

    expect(result.failed).toEqual([]);
    expect(result.activated).toMatchObject([{ id: 'happy', name: 'happy' }]);
    // 虚拟注入三面全通：宿主错误面可用 / typebox 构 schema（宿主 Value 同实例校验通过才走到 apply）/ config 冻结视图
    const marker = root.tryGet<Record<string, unknown>>('fx/happy-marker');
    expect(marker).toBeTruthy();
    expect(marker!['appErrorUsable']).toBe(true);
    expect(marker!['schemaFromVirtualTypebox']).toBe(true);
    expect(marker!['greeting']).toBe('你好');
    expect(marker!['configFrozen']).toBe(true);
    expect(marker!['configIsRowConfig']).toBe(true);
  });

  it('ctx.rowId：装载器手持注入组合树行 id（件数据目录键正规获取口，P0-1）', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'rowid.ts',
      [
        "export const name = 'fx/rowid-probe';",
        'export default async function apply(ctx) {',
        '  // 行 id 直读 + 应用内再 fork 的子作用域继承（行身份随 fork 深度保持）',
        '  const child = ctx.fork({ name: "inner" });',
        '  ctx.provide("fx/rowid-probe", { own: ctx.rowId, childSees: child.rowId });',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    // 根/宿主作用域 rowId = undefined（无行归属）
    expect(root.rowId).toBeUndefined();
    const result = await loadApps(root, [{ id: 'the-row-id', entry }]);

    expect(result.failed).toEqual([]);
    const probe = root.tryGet<{ own: string | undefined; childSees: string | undefined }>('fx/rowid-probe');
    // loader fork 注入行 id（可与应用声明 name 不同物——行 id 是组合树身份）
    expect(probe!.own).toBe('the-row-id');
    expect(probe!.childSees).toBe('the-row-id');
  });

  it('行 config 未过应用 schema：APP_CONFIG_INVALID，apply 不执行（无服务泄漏）', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'schema.ts',
      [
        "import { Type } from 'typebox';",
        "export const name = 'schema';",
        'export const config = Type.Object({ port: Type.Number() });',
        'export default async function apply(ctx) {',
        '  ctx.provide("fx/schema-leak", { ran: true });',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'schema', entry, config: { port: '不是数字' } }]);

    expect(result.activated).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.code).toBe(APP_CONFIG_INVALID);
    expect(result.failed[0]!.message).toContain('port'); // 首个错误路径进诊断
    expect(root.tryGet('fx/schema-leak')).toBeUndefined(); // apply 未执行——无残骸
  });

  it('optionalInject 缺席不阻塞：tryGet 探测得 undefined，照常激活', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'soft.ts',
      [
        "export const name = 'soft';",
        "export const optionalInject = ['absent-service'];",
        'export default async function apply(ctx) {',
        '  ctx.provide("fx/soft-probe", { absent: ctx.tryGet("absent-service") });',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'soft', entry }]);

    expect(result.failed).toEqual([]);
    expect(result.activated).toHaveLength(1);
    expect(root.tryGet<{ absent: unknown }>('fx/soft-probe')!.absent).toBeUndefined();
  });
});

/* ---------------- inject 轮次激活（Kahn 式） ---------------- */

describe('loadApps inject 依赖驱动轮次激活', () => {
  it('依赖倒序装载：消费者在前、提供者在后，轮次激活补齐后双双成功', async () => {
    const dir = makeFixtureDir();
    const consumer = writeApp(
      dir,
      'consumer.ts',
      [
        "export const name = 'consumer';",
        "export const inject = ['fx/kahn-svc'];",
        'export default async function apply(ctx) {',
        '  const svc = ctx.get("fx/kahn-svc");',
        '  ctx.provide("fx/consumer-saw", { value: svc.value });',
        '}',
      ].join('\n'),
    );
    const provider = writeApp(
      dir,
      'provider.ts',
      [
        "export const name = 'provider';",
        'export default async function apply(ctx) {',
        '  ctx.provide("fx/kahn-svc", { value: 42 });',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const events = recordLifecycle(root);
    // 行序故意把消费者放前（首轮不可激活；提供者激活后第二轮补齐）
    const result = await loadApps(root, [
      { id: 'consumer', entry: consumer },
      { id: 'provider', entry: provider },
    ]);

    expect(result.failed).toEqual([]);
    expect(root.tryGet<{ value: number }>('fx/consumer-saw')!.value).toBe(42);
    // 激活顺序：提供者先于消费者（轮次激活语义），事件序与清单序一致
    expect(result.activated.map((item) => item.id)).toEqual(['provider', 'consumer']);
    expect(events.filter((e) => e.kind === 'activated').map((e) => (e.payload as AppActivatedPayload).id)).toEqual([
      'provider',
      'consumer',
    ]);
  });

  it('缺提供方：APP_INJECT_UNRESOLVED 响亮失败，列出缺失服务名', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'waiter.ts',
      [
        "export const name = 'waiter';",
        "export const inject = ['no-such-service'];",
        'export default async function apply(ctx) {',
        '  ctx.provide("fx/waiter-ran", true);',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'waiter', entry }]);

    expect(result.activated).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.code).toBe(APP_INJECT_UNRESOLVED);
    expect(result.failed[0]!.message).toContain('no-such-service');
    expect(root.tryGet('fx/waiter-ran')).toBeUndefined(); // 未激活——无残骸
  });

  it('依赖环：双方 APP_INJECT_UNRESOLVED，诊断指明疑似依赖环', async () => {
    const dir = makeFixtureDir();
    const a = writeApp(
      dir,
      'cyc-a.ts',
      [
        "export const name = 'cyc-a';",
        "export const inject = ['fx/cyc-b-svc'];",
        'export default async function apply(ctx) { ctx.provide("fx/cyc-a-svc", true); }',
      ].join('\n'),
    );
    const b = writeApp(
      dir,
      'cyc-b.ts',
      [
        "export const name = 'cyc-b';",
        "export const inject = ['fx/cyc-a-svc'];",
        'export default async function apply(ctx) { ctx.provide("fx/cyc-b-svc", true); }',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [
      { id: 'cyc-a', entry: a },
      { id: 'cyc-b', entry: b },
    ]);

    expect(result.activated).toEqual([]);
    expect(result.failed.map((item) => item.id).sort()).toEqual(['cyc-a', 'cyc-b']);
    for (const item of result.failed) {
      expect(item.code).toBe(APP_INJECT_UNRESOLVED);
      // 两成因并列诊断：缺失名 + 全体 pending 行（缺失名都在对方 inject 里 = 环）
      expect(item.message).toContain('cyc-a、cyc-b');
      expect(item.message).toContain('缺提供方或依赖环');
    }
  });
});

/* ---------------- 形状与装载失败 ---------------- */

describe('loadApps 形状校验与 import 失败', () => {
  it('default 非函数 / name 缺失 / inject 非 string[]：三例皆 APP_SHAPE_INVALID', async () => {
    const dir = makeFixtureDir();
    const notFn = writeApp(dir, 'not-fn.ts', ['export const name = "not-fn";', 'export default 42;'].join('\n'));
    const noName = writeApp(
      dir,
      'no-name.ts',
      ['export default async function apply(ctx) { ctx.provide("fx/no-name-leak", true); }'].join('\n'),
    );
    const badInject = writeApp(
      dir,
      'bad-inject.ts',
      [
        'export const name = "bad-inject";',
        'export const inject = "not-an-array";',
        'export default async function apply(ctx) {}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [
      { id: 'not-fn', entry: notFn },
      { id: 'no-name', entry: noName },
      { id: 'bad-inject', entry: badInject },
    ]);

    expect(result.activated).toEqual([]);
    expect(result.failed).toHaveLength(3);
    // 单行失败不阻断其余行——三行全量诊断
    expect(result.failed.map((item) => [item.id, item.code])).toEqual([
      ['not-fn', APP_SHAPE_INVALID],
      ['no-name', APP_SHAPE_INVALID],
      ['bad-inject', APP_SHAPE_INVALID],
    ]);
    expect(root.tryGet('fx/no-name-leak')).toBeUndefined(); // 形状不过——apply 从未执行
  });

  it('入口语法错误：APP_LOAD_FAILED（非 AppError 的 import 异常也归一入清单）', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(dir, 'broken.ts', 'export const name = "broken";\nthis is ((( not valid\n');
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'broken', entry }]);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.code).toBe(APP_LOAD_FAILED);
    expect(result.failed[0]!.message).toContain('broken'); // 行 id 进诊断（归因）
  });

  it('虚拟面子路径猜错：import 门禁先拦，消息附六键白名单清单（探针 #12 回归锁 + P0-2 执法面）', async () => {
    const dir = makeFixtureDir();
    // npm 子路径直觉写法——虚拟面只有精确键，子路径既不在白名单也不可解析。
    // P0-2 起 transform 门禁先于 jiti 解析拦下（原 Cannot find → 现更早更准的
    // APP_IMPORT_FORBIDDEN，消息自带合法路——探针 #12 诉求在新形态下满足）
    const entry = writeApp(
      dir,
      'subpath.ts',
      [
        'export const name = "subpath";',
        'import { Type } from "berryagent/typebox";',
        'export const config = Type.Object({ probe: Type.Optional(Type.String()) });',
        'export default async function apply() {}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'subpath', entry }]);

    expect(result.activated).toEqual([]);
    expect(result.failed[0]!.code).toBe(APP_IMPORT_FORBIDDEN);
    // 错误自带合法路：六键白名单清单（含扩键后的 berryagent/llm、berryagent/sqlite）
    expect(result.failed[0]!.message).toContain(`'berryagent'`);
    expect(result.failed[0]!.message).toContain(`'typebox/value'`);
    expect(result.failed[0]!.message).toContain(`'berryagent/llm'`);
    expect(result.failed[0]!.message).toContain(`'berryagent/sqlite'`);
  });
});

/* ---------------- import 来源门禁执法（P0-2，契约篇 §1.2 执法面②） ---------------- */

describe('loadApps import 来源门禁', () => {
  /** 在宿主 node_modules 内造 fixture 目录（用后必删）——构造「解析祖先链上逃到宿主侧」的真实威胁形态 */
  function makeFixtureInsideHostTree(): string {
    return mkdtempSync(join(realpathSync(process.cwd()), 'node_modules', '.gate-fixture-'));
  }

  /** 清理 node_modules 内 fixture（递归强删——mkdtemp 目录归本测试所有） */
  function cleanupFixture(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
  }

  it('宿主侧依赖上逃拒载：jiti 解析到宿主 node_modules = 树外（模块永不求值）', async () => {
    const dir = makeFixtureInsideHostTree();
    try {
      // 顶层副作用标记：门禁在 transform 期抛错（先于 eval）——拒载时标记必不触达
      const entry = writeApp(
        dir,
        'steal-host.ts',
        [
          'export const name = "steal-host";',
          'im' + "port { createJiti } from 'jiti';",
          '(globalThis as Record<string, unknown>).__stealHostEvaluated = true;',
          'export default async function apply() { void createJiti; }',
        ].join('\n'),
      );
      const root = makeRoot();
      const result = await loadApps(root, [{ id: 'steal-host', entry }]);

      expect(result.activated).toEqual([]);
      expect(result.failed[0]!.code).toBe(APP_IMPORT_FORBIDDEN);
      expect(result.failed[0]!.message).toContain('jiti');
      expect(result.failed[0]!.message).toContain('包解析逃逸出应用目录树');
      // 求值前拦截：副作用标记零触达（spike ② 的进程内复证）
      expect((globalThis as Record<string, unknown>).__stealHostEvaluated).toBeUndefined();
      delete (globalThis as Record<string, unknown>).__stealHostEvaluated;
    } finally {
      cleanupFixture(dir);
    }
  });

  it('不可解析裸名拒载：消息指路自捆分发（拼写错与未安装同路）', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'ghost-dep.ts',
      [
        'export const name = "ghost-dep";',
        // 说明符拆段防拓扑检查器误扫（fixture 必然含越界字面量——join 求值后完整）
        'im' + "port { x } from 'never-exists-anywhere';",
        'export default async function apply() { void x; }',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'ghost-dep', entry }]);

    expect(result.activated).toEqual([]);
    expect(result.failed[0]!.code).toBe(APP_IMPORT_FORBIDDEN);
    expect(result.failed[0]!.message).toContain('不可解析');
    expect(result.failed[0]!.message).toContain('自捆');
  });

  // 装载排队回归锁（20260901-d #13，契约篇 §1.2 注记⑤勘正）：TLA + 树内动态
  // import 的应用与并发他载（admin 收割消费方形态）交错时，懒件 transform 须恒
  // 见己根——修前无排队，X 的懒件在他载树根下被误判「逃逸出应用目录树」
  // （berry 真身 loader 探针 25/25 误拒），或见他载已清空值走门禁静默放行
  it('并发装载排队：TLA 懒件 transform 恒见己根，无误拒不旁路', async () => {
    // X：顶层 await + 树内动态 import 链——求值跨异步边界，懒件 lazy 延后
    // transform（verifier 探针实证：lazy 的 transform 落在 TLA 恢复时点）。
    // 懒件自身携带相对 import（lazy → leaf）是复现关键：门禁扫的是**被转译
    // 文件自身**的说明符——lazy 在他载根（dirY）下裁决 './leaf' 即逃逸误报
    // （修前误拒腿 APP_IMPORT_FORBIDDEN；门禁若已清空则旁路——两腿同根因）
    const dirX = makeFixtureDir();
    const entryX = writeApp(
      dirX,
      'tla-x.ts',
      [
        'export const name = "tla-x";',
        'await Promise.resolve();',
        // im/port 断词拼接：拓扑 checker 只认整形的 import 形态（同文件 unused-bind
        // 先例）——测试源文本不构成导入，运行时拼出真形写入 fixture
        'const lazy = await im' + "port('./lazy-x');",
        'export const marker = lazy.marker;',
        'export default async function apply() {}',
      ].join('\n'),
    );
    writeApp(
      dirX,
      'lazy-x.ts',
      [
        'im' + "port { marker as leafMarker } from './leaf-x';",
        'export const marker = leafMarker;',
        'export default async function apply() {}',
        '',
      ].join('\n'),
    );
    writeApp(dirX, 'leaf-x.ts', "export const marker = 'x';\nexport default async function apply() {}\n");
    // Y：同形 TLA 应用——自身挂起拉宽「他载在飞」窗（root=dirY 恒在场至其结算，
    // X 的懒件 transform 必落此窗内——修前在他载根下裁决即误拒）
    const dirY = makeFixtureDir();
    const entryY = writeApp(
      dirY,
      'tla-y.ts',
      [
        'export const name = "tla-y";',
        'await Promise.resolve();',
        'export const marker = "y";',
        'export default async function apply() {}',
      ].join('\n'),
    );
    // Promise.all 并发两装载（修前：Y 的树根在 X 懒件 transform 时点在场或已清空）
    const [modX, modY] = await Promise.all([
      importAppEntry(createAppJiti(), entryX),
      importAppEntry(createAppJiti(), entryY),
    ]);
    // X 的树内动态 import 正常装载（修前误拒腿：APP_IMPORT_FORBIDDEN 逃逸误报）
    expect((modX as { marker?: string }).marker).toBe('x');
    expect((modY as { marker?: string }).marker).toBe('y');
    // 排队后再次单飞装载仍绿——链收尾清根不染后续（builtin/防御路径恒 undefined）
    const again = await importAppEntry(createAppJiti(), entryY);
    expect((again as { marker?: string }).marker).toBe('y');
  });

  it('解析对账不等使用：import 了但未使用的越界说明符同样拒载', async () => {
    const dir = makeFixtureInsideHostTree();
    try {
      // jiti 转译会丢弃未使用 import（对照实验实证）——门禁在转译前扫源码，
      // 声明即拦（type-only import 同纪律：源码面统一，不留「未使用即豁免」旁门）
      const entry = writeApp(
        dir,
        'unused-bind.ts',
        [
          'export const name = "unused-bind";',
          'im' + "port { createJiti } from 'jiti';",
          'export default async function apply() {}',
        ].join('\n'),
      );
      const root = makeRoot();
      const result = await loadApps(root, [{ id: 'unused-bind', entry }]);

      expect(result.activated).toEqual([]);
      expect(result.failed[0]!.code).toBe(APP_IMPORT_FORBIDDEN);
    } finally {
      cleanupFixture(dir);
    }
  });

  it('自捆依赖放行：应用目录树内 node_modules 的包正常 import（正门用例）', async () => {
    const dir = makeFixtureDir();
    // 造自捆包：fixture/node_modules/self-dep（树内解析——第三道白名单的正路形态）
    mkdirSync(join(dir, 'node_modules', 'self-dep'), { recursive: true });
    writeFileSync(
      join(dir, 'node_modules', 'self-dep', 'package.json'),
      JSON.stringify({ name: 'self-dep', version: '1.0.0', type: 'module' }),
    );
    writeFileSync(join(dir, 'node_modules', 'self-dep', 'index.js'), 'export const marker = "self-dep-ok";\n');
    const entry = writeApp(
      dir,
      'bundled.ts',
      [
        'export const name = "bundled";',
        'im' + "port { marker } from 'self-dep';",
        'export default async function apply(ctx) { ctx.provide("fx/bundled-marker", { marker }); }',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'bundled', entry }]);

    expect(result.failed).toEqual([]);
    expect(result.activated).toMatchObject([{ id: 'bundled', name: 'bundled' }]);
    expect(root.tryGet<{ marker: string }>('fx/bundled-marker')!.marker).toBe('self-dep-ok');
  });

  it('相对路径树内放行 + 子文件逃逸拒载：全图扫描不只看入口（moduleCache:false 对账兜底）', async () => {
    // 树内 helper 正常引用（helper 再引裸内建——嵌套文件同过门禁）
    const okDir = makeFixtureDir();
    writeApp(
      okDir,
      'helper.ts',
      ["import { join } from 'node:path';\nexport const combined = join('a', 'b');\n"].join(''),
    );
    const okEntry = writeApp(
      okDir,
      'uses-helper.ts',
      [
        'export const name = "uses-helper";',
        'im' + "port { combined } from './helper.ts';",
        'export default async function apply(ctx) { ctx.provide("fx/helper-marker", { combined }); }',
      ].join('\n'),
    );
    const okRoot = makeRoot();
    const okResult = await loadApps(okRoot, [{ id: 'uses-helper', entry: okEntry }]);
    expect(okResult.failed).toEqual([]);
    expect(okRoot.tryGet<{ combined: string }>('fx/helper-marker')!.combined).toBe(join('a', 'b'));

    // 子文件相对路径跳出树根（../../ 指向 tmpdir 层的诱饵文件）——入口干净、依赖脏，同样拒
    const badDir = makeFixtureDir();
    // 子文件源码同样拆段防误扫（逃逸说明符 ../../../outside-dep.js 是执法测试的道具）
    writeApp(
      badDir,
      'evil-helper.ts',
      ['im' + "port { x } from '../../../outside-dep.js';\nexport const x2 = x;\n"].join(''),
    );
    const badEntry = writeApp(
      badDir,
      'uses-evil.ts',
      [
        'export const name = "uses-evil";',
        'im' + "port { x2 } from './evil-helper.ts';",
        'export default async function apply() { void x2; }',
      ].join('\n'),
    );
    const badRoot = makeRoot();
    const badResult = await loadApps(badRoot, [{ id: 'uses-evil', entry: badEntry }]);
    expect(badResult.activated).toEqual([]);
    expect(badResult.failed[0]!.code).toBe(APP_IMPORT_FORBIDDEN);
    expect(badResult.failed[0]!.message).toContain('相对路径解析逃逸出应用目录树');
    expect(badResult.failed[0]!.message).toContain('evil-helper');
  });

  it('node: 显式与裸内建放行：fs/path/crypto 等宿主运行时直用合法', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'natives.ts',
      [
        'export const name = "natives";',
        "import { join } from 'node:path';",
        "import { isBuiltin } from 'node:module';",
        'im' + "port { basename } from 'path';", // 裸内建（无 node: 前缀）——应用允许的形态
        'export default async function apply(ctx) {',
        '  ctx.provide("fx/natives-marker", { joined: join("x", "y"), builtin: isBuiltin("path"), base: basename("/a/b.ts") });',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'natives', entry }]);

    expect(result.failed).toEqual([]);
    const marker = root.tryGet<Record<string, unknown>>('fx/natives-marker')!;
    expect(marker['joined']).toBe(join('x', 'y'));
    expect(marker['builtin']).toBe(true);
    expect(marker['base']).toBe('b.ts');
  });

  it('第五/六键注入物端到端：virtualFaces 传入即经 berryagent/llm、berryagent/sqlite 取得', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'faces.ts',
      [
        'export const name = "faces";',
        "import { createProvider, hasApi } from 'berryagent/llm';",
        "import { openDatabase } from 'berryagent/sqlite';",
        'export default async function apply(ctx) {',
        '  ctx.provide("fx/faces-marker", {',
        '    provider: createProvider({ id: "fake" }),',
        '    guard: hasApi({} as never, "fake"),',
        '    db: openDatabase(":memory:"),',
        '  });',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'faces', entry }], {
      virtualFaces: {
        llm: {
          createProvider: (options: { id: string }) => ({ kind: 'provider', ...options }),
          hasApi: () => true,
        },
        sqlite: { openDatabase: (path: string) => ({ kind: 'db', path }) },
      },
    });

    expect(result.failed).toEqual([]);
    const marker = root.tryGet<Record<string, unknown>>('fx/faces-marker')!;
    expect(marker['provider']).toEqual({ kind: 'provider', id: 'fake' });
    expect(marker['guard']).toBe(true);
    expect(marker['db']).toEqual({ kind: 'db', path: ':memory:' });
  });

  it('virtualFaces 缺省：两键恒在虚拟面（import 不炸），面为空由应用自查', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'empty-faces.ts',
      [
        'export const name = "empty-faces";',
        "import * as llmFace from 'berryagent/llm';",
        "import * as sqliteFace from 'berryagent/sqlite';",
        'export default async function apply(ctx) {',
        '  ctx.provide("fx/empty-faces-marker", {',
        '    llmKeys: Object.keys(llmFace).length,',
        '    sqliteKeys: Object.keys(sqliteFace).length,',
        '  });',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'empty-faces', entry }]);

    expect(result.failed).toEqual([]);
    const marker = root.tryGet<Record<string, unknown>>('fx/empty-faces-marker')!;
    expect(marker['llmKeys']).toBe(0);
    expect(marker['sqliteKeys']).toBe(0);
  });

  // 运行期兜底三形回归锁（全面复盘 20260902 S-1，契约篇 §1.2 注记⑤勘正）：
  // 字面量早拦只认引号字面量——计算说明符（运行期拼串求值）与纯 CJS 面（jiti
  // 对 .cjs/无 ESM 语法 .js 不调自定义 transform，探针实证）结构性失明，
  // 修前三形全部装载成功（逃逸到宿主文件系统/宿主 node_modules）。
  it('运行期兜底·计算绝对路径：拼串动态 import 树外真文件即拒（修前装载成功）', async () => {
    const outsideDir = makeFixtureDir(); // 树外真目录——诱饵目标真实存在，拒的是越界非解析失败
    writeFileSync(join(outsideDir, 'outside.js'), 'export const leaked = true;\n');
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'computed-abs.ts',
      [
        'export const name = "computed-abs";',
        // 说明符运行期拼出——SPECIFIER_RE 只认引号字面量，transform 期扫描结构性看不见
        `const base = ${JSON.stringify(outsideDir)};`,
        'const mod = await im' + "port(base + '/outside.js');",
        'export const marker = mod.leaked;',
        'export default async function apply() {}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'computed-abs', entry }]);

    expect(result.activated).toEqual([]);
    expect(result.failed[0]!.code).toBe(APP_IMPORT_FORBIDDEN);
    expect(result.failed[0]!.message).toContain('相对路径解析逃逸出应用目录树');
    expect(result.failed[0]!.message).toContain('outside.js');
    // 兜底层标注——与字面量早拦（「文件 …」origin）可分辨
    expect(result.failed[0]!.message).toContain('运行期兜底');
  });

  it('运行期兜底·计算裸包名：拼串动态 import 解析上逃宿主 node_modules 即拒（修前装载成功）', async () => {
    const dir = makeFixtureInsideHostTree();
    try {
      const entry = writeApp(
        dir,
        'computed-bare.ts',
        [
          'export const name = "computed-bare";',
          // 裸包名运行期拼出——fixture 在宿主 node_modules 内，解析向上走必达宿主侧
          "const pkg = ['j', 'i', 't', 'i'].join('');",
          'const mod = await im' + 'port(pkg);',
          'export const marker = typeof mod.createJiti;',
          'export default async function apply() {}',
        ].join('\n'),
      );
      const root = makeRoot();
      const result = await loadApps(root, [{ id: 'computed-bare', entry }]);

      expect(result.activated).toEqual([]);
      expect(result.failed[0]!.code).toBe(APP_IMPORT_FORBIDDEN);
      expect(result.failed[0]!.message).toContain('包解析逃逸出应用目录树');
      expect(result.failed[0]!.message).toContain('运行期兜底');
    } finally {
      cleanupFixture(dir);
    }
  });

  it('运行期兜底·纯 CJS 字面量 require：jiti 不调 transform 的面即拒（修前装载成功）', async () => {
    const outsideDir = makeFixtureDir();
    writeFileSync(join(outsideDir, 'outside.cjs'), 'module.exports = { leaked: true };\n');
    const dir = makeFixtureDir();
    // 纯 CJS 入口：字面量 require 明晃晃在场——但 jiti 对纯 CJS 不调自定义
    // transform（evalModule 转译判定：非 TS、无 ESM 语法即 native require 直载），
    // 字面量扫描结构性缺席；native 路径由 loadChain 窗内 Module._load 补丁执法
    // （require 发起文件落在装载树内即过裁决）。走 importAppEntry 直载面断言
    // 原生 AppError 形状（不经 loadApps 失败清单转译）。
    const entry = writeApp(
      dir,
      'cjs-literal.cjs',
      [
        `const mod = require(${JSON.stringify(join(outsideDir, 'outside.cjs'))});`,
        'exports.name = "cjs-literal";',
        'exports.marker = mod.leaked;',
        'exports.default = async function apply() {};',
      ].join('\n'),
    );
    await expect(importAppEntry(createAppJiti(), entry)).rejects.toMatchObject({
      code: APP_IMPORT_FORBIDDEN,
      message: expect.stringContaining('outside.cjs') as string,
    });
  });

  it('运行期兜底·前置守卫保 require 属性面：resolve 惯用面可用且包裹仍受辖（修前 TypeError）', async () => {
    const outsideDir = makeFixtureDir();
    writeFileSync(join(outsideDir, 'outside.js'), 'export const leaked = true;\n');
    const dir = makeFixtureDir();
    // 过 transform 的 TS 模块 = 前置守卫注入面（遗漏大扫 20260902-c #2）：
    // require 是 jiti 求值包裹参数，其属性面是合法 CJS 惯用面——require.resolve
    // （可选依赖探测）必须在守卫包裹后照常可用。裸函数遮蔽会整体丢属性面
    // （干净环境实测 require.resolve is not a function——合法第三方应用结构性
    // 不可装载，修 A 破 B）；Proxy apply 形态 = 属性读取透传 + 调用面受辖。
    const entry = writeApp(
      dir,
      'guard-face.ts',
      [
        'export const name = "guard-face";',
        'const resolveType = typeof require.resolve;',
        'let resolvedFs = "THREW";',
        'try { resolvedFs = require.resolve("node:fs"); } catch {}',
        `const target = ${JSON.stringify(join(outsideDir, 'outside.js'))};`,
        'let deniedCode = "";',
        'try { require(target); } catch (e) { deniedCode = e && e.code ? e.code : String(e); }',
        'export default async function apply(ctx) {',
        '  ctx.provide("fx/guard-face-marker", { resolveType, resolvedFs, deniedCode });',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'guard-face', entry }]);

    expect(result.failed).toEqual([]);
    const marker = root.tryGet<Record<string, unknown>>('fx/guard-face-marker')!;
    expect(marker['resolveType']).toBe('function'); // 修前裸函数遮蔽 → 'undefined'
    expect(marker['resolvedFs']).not.toBe('THREW'); // 修前调用即 TypeError（被 try 吞进哨兵）
    expect(marker['deniedCode']).toBe(APP_IMPORT_FORBIDDEN); // 包裹不松执法——计算说明符仍拒
  });

  it('运行期兜底·纯 CJS 迟发 require：apply 期（装载窗已还原）区外文件即拒（修前装载成功且逃逸）', async () => {
    const outsideDir = makeFixtureDir();
    writeFileSync(join(outsideDir, 'secret.cjs'), "module.exports = { secret: 'host-secret' };\n");
    const dir = makeFixtureDir();
    // 逃逸形态 = TS 入口经**纯 CJS 中间模块**迟发 require（遗漏大扫 20260902-c
    // #3）：mid.cjs 不经 transform（jiti 对纯 CJS native 直载——前置守卫结构性
    // 缺席），迟发 require 在 apply 期发生：装载窗（Module._load 补丁 +
    // currentTreeRoot）已还原，修前 require 区外绝对路径成功读宿主文件、行照常
    // 激活。行寿命执法 = 树根留在活动树根集、补丁常驻（集合镜像当前组合树，
    // loadApps 每轮剪枝）。纯 CJS 直接入口过不了形状校验（jiti interop 的
    // default = 整个 exports 对象，探针实证）——中间模块即现实攻击形态。
    writeFileSync(
      join(dir, 'mid.cjs'),
      [
        `const OUTSIDE = ${JSON.stringify(join(outsideDir, 'secret.cjs'))};`,
        'exports.lateLoad = function lateLoad() { return require(OUTSIDE).secret; };',
      ].join('\n'),
    );
    const entry = writeApp(
      dir,
      'cjs-late.ts',
      [
        // require 形（非 import 声明）：夹具字符串不触发 check-topology 的静态
        // 导入扫描（.cjs 无解析候选）；同时实测 Proxy 包裹对合法树内 require 放行
        'const { lateLoad } = require("./mid.cjs");',
        'export const name = "cjs-late";',
        'export default async function apply(ctx) {',
        '  ctx.provide("fx/cjs-late-escaped", lateLoad() === "host-secret");',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'cjs-late', entry }]);

    expect(result.activated).toEqual([]); // 修前：逃逸成功、行照常激活
    expect(result.failed[0]!.code).toBe(APP_APPLY_FAILED); // apply 内抛错族（门禁 AppError 被 activateOne 包装）
    expect(result.failed[0]!.message).toContain('secret.cjs');
    expect(result.failed[0]!.message).toContain('运行期兜底'); // 兜底层标注可分辨
  });

  it('运行期兜底·无父模块 _load(spec, null)：直呼内部入口绕父门即拒（遗漏大扫 20260903 fix-code #18，修前装载成功且逃逸）', async () => {
    const outsideDir = makeFixtureDir();
    writeFileSync(join(outsideDir, 'secret2.cjs'), "module.exports = { secret: 'host-secret-2' };\n");
    const dir = makeFixtureDir();
    // 逃逸形态 = 直呼 Module._load 内部入口 + parent=null（探针转正）：绕过
    // Module.prototype.require 的父归因——修前 gated 对 parentFile null 形整体
    // 跳过裁决、origLoad 直载区外文件成功读宿主秘密。合法树内/内建面对全体
    // 活动树逐一裁决恒放行（fail-closed 拦逃逸不拦装载——零误伤面）。
    writeFileSync(
      join(dir, 'mid-null.cjs'),
      [
        "const nodeModule = require('module');",
        `const OUTSIDE = ${JSON.stringify(join(outsideDir, 'secret2.cjs'))};`,
        'exports.lateLoad = function lateLoad() {',
        '  // parent=null 直呼：不走 Module.prototype.require——父门归因缺席',
        '  const mod = nodeModule._load(OUTSIDE, null, false);',
        '  return mod.secret;',
        '};',
      ].join('\n'),
    );
    const entry = writeApp(
      dir,
      'cjs-null-parent.ts',
      [
        'const { lateLoad } = require("./mid-null.cjs");',
        'export const name = "cjs-null-parent";',
        'export default async function apply(ctx) {',
        '  ctx.provide("fx/cjs-null-escaped", lateLoad() === "host-secret-2");',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'cjs-null-parent', entry }]);

    expect(result.activated).toEqual([]); // 修前：逃逸成功、行照常激活
    expect(result.failed[0]!.code).toBe(APP_APPLY_FAILED); // apply 内抛错族（门禁 AppError 被 activateOne 包装）
    expect(result.failed[0]!.message).toContain('secret2.cjs');
    expect(result.failed[0]!.message).toContain('无父模块'); // fail-closed 腿标注可分辨
  });
});

/* ---------------- apply 抛错回卷与生命周期事件 ---------------- */

describe('loadApps apply 失败回卷与生命周期事件', () => {
  it('apply 抛错：先回卷本作用域（服务下架 + effect 清理执行）再 APP_APPLY_FAILED', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'boom.ts',
      [
        'export const name = "boom";',
        'export default async function apply(ctx) {',
        '  ctx.provide("fx/boom-svc", { on: true });',
        '  ctx.effect(() => () => { (globalThis).__boomCleaned = true; });',
        '  throw new Error("apply 炸了");',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'boom', entry }]);

    expect(result.activated).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.code).toBe(APP_APPLY_FAILED);
    expect(result.failed[0]!.message).toContain('apply 炸了');
    // 失败行不留残骸（§1.6）：半途 provide 已回卷、effect 清理已执行
    expect(root.tryGet('fx/boom-svc')).toBeUndefined();
    expect((globalThis as Record<string, unknown>)['__boomCleaned']).toBe(true);
  });

  it('三态混合装载：生命周期事件逐行必发且与清单一致（§2.2 增补 1）', async () => {
    const dir = makeFixtureDir();
    const ok = writeApp(
      dir,
      'ok.ts',
      [
        'export const name = "ok";',
        'export default async function apply(ctx) { ctx.provide("fx/ok-svc", true); }',
      ].join('\n'),
    );
    writeApp(dir, 'off.ts', 'export const name = "off";\nexport default async function apply() {}\n');
    const root = makeRoot();
    const events = recordLifecycle(root);
    const rows: AppPlanRow[] = [
      { id: 'ok', entry: ok },
      { id: 'off', skip: 'disabled' }, // 跳过行不 import——off.ts 存在与否无关
      { id: 'ghost', unresolved: '应用「ghost」入口无法解析' }, // 解析失败行不 import
    ];
    const result = await loadApps(root, rows);

    // 清单三态
    expect(result.activated.map((item) => item.id)).toEqual(['ok']);
    expect(result.skipped).toEqual([{ id: 'off', reason: 'disabled' }]);
    expect(result.failed.map((item) => [item.id, item.code])).toEqual([['ghost', 'APP_ENTRY_UNRESOLVED']]);
    // 事件逐行必发（push 诊断面）：序 = 装载序（跳过/失败在 import 阶段，激活在轮次阶段）
    expect(events.map((e) => `${e.kind}:${(e.payload as { id: string }).id}`)).toEqual([
      'skipped:off',
      'failed:ghost',
      'activated:ok',
    ]);
    expect(root.tryGet('fx/ok-svc')).toBe(true);
  });
});

/* ---------------- apply 挂起时钟（§1.6 时钟族，2026-08-27 刀〇a） ---------------- */

describe('loadApps apply 挂起超时（APP_APPLY_TIMEOUT）', () => {
  it('apply 永不 resolve：竞速小钟触发——回卷半途注册后按挂起超时进失败清单，迟到 reject 不进 unhandledRejection', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'hang.ts',
      [
        'export const name = "hang";',
        'export default async function apply(ctx) {',
        '  ctx.provide("fx/hang-svc", { on: true });',
        '  ctx.effect(() => () => { (globalThis).__hangCleaned = true; });',
        '  await new Promise(() => {}); // 永挂：挂起转化条款的目标形态',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    // 小钟 30ms（生产缺省 10s——挂起语义不随时钟值变）
    const result = await loadApps(root, [{ id: 'hang', entry }], { applyTimeoutMs: 30 });

    expect(result.activated).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.code).toBe(APP_APPLY_TIMEOUT);
    expect(result.failed[0]!.message).toContain('30ms');
    // 失败行不留残骸：半途 provide 已回卷、effect 清理已执行
    expect(root.tryGet('fx/hang-svc')).toBeUndefined();
    expect((globalThis as Record<string, unknown>)['__hangCleaned']).toBe(true);
  });

  it('applyMs 打点随 activated 载荷上行（B2 P5——非负计时，诊断面展示启动开销）', async () => {
    const dir = makeFixtureDir();
    const ok = writeApp(dir, 'fast.ts', 'export const name = "fast";\nexport default async function apply() {}\n');
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'fast', entry: ok }]);

    expect(result.activated).toHaveLength(1);
    expect(result.activated[0]!.applyMs).toBeGreaterThanOrEqual(0);
  });
});

/* ---------------- 自定义事件词汇（events 第四件，§1.1 逃生口） ---------------- */

describe('loadApps 自定义事件词汇登记', () => {
  it('跨应用订阅无顺序洞：订阅行在前、声明行在后——词汇装载期入册，on 不炸、派发端到端送达', async () => {
    const dir = makeFixtureDir();
    const listener = writeApp(
      dir,
      'listener.ts',
      [
        'export const name = "listener";',
        'export default async function apply(ctx) {',
        '  ctx.on("emitter/done", (payload: { n: number }) => {',
        '    ctx.provide("fx/listener-saw", payload.n);',
        '  });',
        '}',
      ].join('\n'),
    );
    const emitter = writeApp(
      dir,
      'emitter.ts',
      [
        'export const name = "emitter";',
        'export const events = [{ name: "emitter/done", mode: "emit", note: "完成后通知" }];',
        'export default async function apply(ctx) {',
        '  ctx.emit("emitter/done", { n: 7 });',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    // 行序故意把订阅者放前、声明行放后——词汇在装载阶段①（一切 apply 之前）统一入册，
    // 订阅者的 on 不因声明行更晚激活而炸 EVENT_UNKNOWN（跨应用订阅无顺序洞回归锁）
    const result = await loadApps(root, [
      { id: 'listener', entry: listener },
      { id: 'emitter', entry: emitter },
    ]);

    expect(result.failed).toEqual([]);
    expect(result.activated).toHaveLength(2);
    expect(root.tryGet('fx/listener-saw')).toBe(7); // on 在册通过 + emit 送达
  });

  it('events 声明非法（name 无 /、mode 非四值、缺 note）三例皆 APP_SHAPE_INVALID，apply 从未执行', async () => {
    const dir = makeFixtureDir();
    const noSlash = writeApp(
      dir,
      'no-slash.ts',
      [
        'export const name = "no-slash";',
        'export const events = [{ name: "noslash", mode: "emit", note: "x" }];',
        'export default async function apply(ctx) { ctx.provide("fx/no-slash-leak", true); }',
      ].join('\n'),
    );
    const badMode = writeApp(
      dir,
      'bad-mode.ts',
      [
        'export const name = "bad-mode";',
        'export const events = [{ name: "bad/mode", mode: "fire", note: "x" }];',
        'export default async function apply() {}',
      ].join('\n'),
    );
    const noNote = writeApp(
      dir,
      'no-note.ts',
      [
        'export const name = "no-note";',
        'export const events = [{ name: "no/note", mode: "emit" }];',
        'export default async function apply() {}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [
      { id: 'no-slash', entry: noSlash },
      { id: 'bad-mode', entry: badMode },
      { id: 'no-note', entry: noNote },
    ]);

    expect(result.activated).toEqual([]);
    expect(result.failed.map((item) => [item.id, item.code])).toEqual([
      ['no-slash', APP_SHAPE_INVALID],
      ['bad-mode', APP_SHAPE_INVALID],
      ['no-note', APP_SHAPE_INVALID],
    ]);
    // 归因单源：行 id 只在失败信封（item.id）与清单格式出现，消息体内不再重复
    // 前缀（探针 #14 回归锁——曾出现「hermes-core：hermes-core：」双前缀）
    for (const item of result.failed) {
      expect(item.message.startsWith(`${item.id}：`)).toBe(false);
    }
    expect(root.tryGet('fx/no-slash-leak')).toBeUndefined(); // 声明面不过——apply 从未执行
  });

  it('effect 回调返回非函数：装载期即失败并带正确习语指引（探针 #13——jiti 无类型护栏的运行时补位）', async () => {
    const dir = makeFixtureDir();
    // 病灶习语：const d = …; ctx.effect(() => d())——注册即注销 + undefined 入栈
    const entry = writeApp(
      dir,
      'bad-effect.ts',
      [
        'export const name = "bad-effect";',
        'export default async function apply(ctx) {',
        '  const d = ctx.effect(() => () => {}); // 先正常注册拿一个 disposer',
        '  ctx.effect(() => d()); // 病灶：立即执行 d（撤销上一个注册）且返回 undefined',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'bad-effect', entry }]);

    expect(result.activated).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.code).toBe(APP_APPLY_FAILED);
    // 指引链路：apply 失败消息内含 CONTEXT_EFFECT_INVALID 码与正确习语
    expect(result.failed[0]!.message).toContain('CONTEXT_EFFECT_INVALID');
    expect(result.failed[0]!.message).toContain('ctx.effect(d)');
  });

  it('撞名：两行声明同名 / 撞宿主目录名皆 EVENT_DUPLICATE——词汇表拒绝静默覆盖，先到者照常激活', async () => {
    const dir = makeFixtureDir();
    const first = writeApp(
      dir,
      'twice-a.ts',
      [
        'export const name = "twice-a";',
        'export const events = [{ name: "twice/evt", mode: "emit", note: "先到" }];',
        'export default async function apply() {}',
      ].join('\n'),
    );
    const second = writeApp(
      dir,
      'twice-b.ts',
      [
        'export const name = "twice-b";',
        'export const events = [{ name: "twice/evt", mode: "emit", note: "后到" }];',
        'export default async function apply() {}',
      ].join('\n'),
    );
    // 撞宿主目录名须选「格式合法且在目录」的名字（app/activated 含斜线小写合法）；
    // tools_change 类无斜线名先被格式检查拦下——宿主自留地由格式纪律防住，到不了撞名检查
    const catalogClash = writeApp(
      dir,
      'catalog-clash.ts',
      [
        'export const name = "catalog-clash";',
        'export const events = [{ name: "app/activated", mode: "emit", note: "撞宿主目录名" }];',
        'export default async function apply() {}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [
      { id: 'twice-a', entry: first },
      { id: 'twice-b', entry: second },
      { id: 'catalog-clash', entry: catalogClash },
    ]);

    expect(result.activated.map((item) => item.id)).toEqual(['twice-a']); // 先到者词汇入册、照常激活
    expect(result.failed.map((item) => [item.id, item.code])).toEqual([
      ['twice-b', EVENT_DUPLICATE],
      ['catalog-clash', EVENT_DUPLICATE],
    ]);
  });
});

/* ---------------- 技能目录注册回调（§1.2 第六件，2026-08-26 技能包应用纵切） ---------------- */

describe('loadApps 技能目录注册回调', () => {
  it('回调时序：行作用域 fork 后、apply 之前——回调先于 apply 收到完整行信息', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'skillpack.ts',
      [
        "export const name = 'skillpack';",
        "export const skills = ['./skills'];",
        'export default async function apply(ctx) {',
        '  ctx.provide("fx/skillpack-apply-ran", true);',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const seen: AppSkillsInfo[] = [];
    const result = await loadApps(root, [{ id: 'skillpack', entry }], {
      registerSkills: (info) => {
        // 时序锚点：回调时 apply 尚未执行（fork 后 apply 前的登记位——冷读裁决）
        seen.push(info);
        expect(root.tryGet('fx/skillpack-apply-ran')).toBeUndefined();
      },
    });

    expect(result.failed).toEqual([]);
    expect(result.activated).toMatchObject([{ id: 'skillpack', name: 'skillpack' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe('skillpack');
    expect(seen[0]!.packageRoot).toBe(dir); // 包根 = 入口文件所在目录
    expect(seen[0]!.dirs).toEqual(['./skills']);
    expect(seen[0]!.scope).toBeTruthy(); // 行作用域已 fork（回调可挂 effect）
    expect(root.tryGet('fx/skillpack-apply-ran')).toBe(true); // apply 事后确实跑了
  });

  it('apply 抛错回卷：回调挂行作用域的 effect 随 dispose 回卷（技能是行资产，失败不留残骸）', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'boom.ts',
      [
        "export const name = 'boom';",
        "export const skills = ['./skills'];",
        'export default async function apply() {',
        '  throw new Error("boom");',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    let registered = false;
    let cleaned = false;
    const result = await loadApps(root, [{ id: 'boom', entry }], {
      registerSkills: (info) => {
        registered = true;
        // 模拟组合根桥接：包层 provider 注册挂行作用域 effect（注销器即回卷证据）
        info.scope.effect(() => () => {
          cleaned = true;
        });
      },
    });

    expect(registered).toBe(true); // 回调确实发生（fork 后 apply 前）
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.code).toBe(APP_APPLY_FAILED);
    expect(cleaned).toBe(true); // apply 抛错 → scope.dispose() → 注册 effect LIFO 回卷
  });

  it('未注入回调：skills 声明行照常激活（老调用方兼容面——回调是可选参数）', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'nohook.ts',
      [
        "export const name = 'nohook';",
        "export const skills = ['./skills'];",
        'export default async function apply(ctx) {',
        '  ctx.provide("fx/nohook-ran", true);',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'nohook', entry }]);

    expect(result.failed).toEqual([]);
    expect(result.activated).toMatchObject([{ id: 'nohook', name: 'nohook' }]);
    expect(root.tryGet('fx/nohook-ran')).toBe(true);
  });

  it('纯技能包最小形态：name + skills + default 空实现三件零逻辑即合法应用', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'pure.ts',
      [
        "export const name = 'pure';",
        "export const skills = ['./skills'];",
        'export default async function apply() {}',
      ].join('\n'),
    );
    const root = makeRoot();
    let called = false;
    const result = await loadApps(root, [{ id: 'pure', entry }], {
      registerSkills: () => {
        called = true;
      },
    });

    expect(result.failed).toEqual([]);
    expect(result.activated).toMatchObject([{ id: 'pure', name: 'pure' }]);
    expect(called).toBe(true); // 空实现也走技能注册（纯技能包的唯一起作用面）
  });

  it('skills 非 string[]：APP_SHAPE_INVALID，apply 不执行', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'badskills.ts',
      [
        "export const name = 'badskills';",
        "export const skills = './skills';",
        'export default async function apply(ctx) {',
        '  ctx.provide("fx/badskills-leak", true);',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadApps(root, [{ id: 'badskills', entry }]);

    expect(result.activated).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.code).toBe(APP_SHAPE_INVALID);
    expect(result.failed[0]!.message).toContain('skills');
    expect(root.tryGet('fx/badskills-leak')).toBeUndefined(); // 声明面不过——apply 从未执行
  });

  it('builtin 行声明 skills：回调收到 packageRoot undefined（宿主函数件无磁盘锚点）', async () => {
    const root = makeRoot();
    const seen: AppSkillsInfo[] = [];
    const result = await loadApps(
      root,
      [
        {
          id: 'builtin-demo',
          builtin: {
            name: 'demo',
            skills: ['./skills'],
            apply: async (ctx) => {
              ctx.provide('builtin-demo-ran', true);
            },
          },
        },
      ],
      {
        registerSkills: (info) => {
          seen.push(info);
        },
      },
    );

    expect(result.failed).toEqual([]);
    expect(result.activated).toMatchObject([{ id: 'builtin-demo', name: 'demo' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.packageRoot).toBeUndefined(); // builtin 行无入口文件——组合根侧跳过注册
    expect(root.tryGet('builtin-demo-ran')).toBe(true);
  });

  // packageRoot 桥两来源钉死（契约篇 §3.4 两处钉死，2026-08-27 admin 刀）：
  // builtin 件自述 packageRoot 生效（admin 件先例）；文件应用模块带 packageRoot
  // 键被忽略（包根恒走入口路径推导——暗道不存在）
  it('builtin 自述 packageRoot：回调收到自述锚点（admin 件形态）', async () => {
    const root = makeRoot();
    const seen: AppSkillsInfo[] = [];
    const result = await loadApps(
      root,
      [
        {
          id: 'builtin-selfroot',
          builtin: {
            name: 'selfroot',
            skills: ['./skills/admin'],
            packageRoot: '/anchor/admin',
            apply: async () => {},
          },
        },
      ],
      {
        registerSkills: (info) => {
          seen.push(info);
        },
      },
    );

    expect(result.failed).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.packageRoot).toBe('/anchor/admin'); // 自述锚点原样透传（import.meta.url 位置事实）
    expect(seen[0]!.dirs).toEqual(['./skills/admin']);
  });

  it('文件应用模块带 packageRoot 键：被忽略（包根恒走 entry 推导——暗道不存在）', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'fakeroot.ts',
      [
        "export const name = 'fakeroot';",
        "export const skills = ['./skills'];",
        "export const packageRoot = '/should/be/ignored';",
        'export default async function apply() {}',
      ].join('\n'),
    );
    const root = makeRoot();
    const seen: AppSkillsInfo[] = [];
    const result = await loadApps(root, [{ id: 'fakeroot', entry }], {
      registerSkills: (info) => {
        seen.push(info);
      },
    });

    expect(result.failed).toEqual([]); // 多余 named export 不算形状违规（宽容面）——只是不被读
    expect(seen[0]!.packageRoot).toBe(dir); // 入口路径推导胜出（模块键被忽略）
  });
});

/* ---------------- caller 链装载器写点（会话篇 §5.1 导入者归因，P1-1） ---------------- */

describe('装载器 apply 边界的 caller 链（应用身份已知的第一写点）', () => {
  it('apply 段内经宿主服务读链 = 本行应用 id；装载器自身代码不在链上', async () => {
    const dir = makeFixtureDir();
    const entry = writeApp(
      dir,
      'caller-probe.ts',
      [
        "export const name = 'caller-probe';",
        'export default async function apply(ctx) {',
        "  const probe = ctx.get<(label: string) => string | undefined>('caller-probe');",
        '  ctx.effect(() => () => {});', // 注册侧不在链上的对照探针见下
        '  await Promise.resolve();', // 跨 tick 仍在链上（异步下游继承）
        "  ctx.provide('fx/probe-result', { applyTime: probe('apply') });",
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    // 宿主探针服务：实现闭包在宿主侧读链——归因面真实路径（服务面看不到调用方，
    // 身份靠装载器边界进入 ALS）
    const reads: Array<{ label: string; caller: string | undefined }> = [];
    root.provide('caller-probe', (label: string) => {
      const caller = chainCaller();
      reads.push({ label, caller });
      return caller;
    });
    const result = await loadApps(root, [{ id: 'row-caller-id', entry }]);

    expect(result.failed).toEqual([]);
    // apply 段（含跨 tick）：本行 id
    expect(reads.find((r) => r.label === 'apply')).toEqual({ label: 'apply', caller: 'row-caller-id' });
    // 装载器自身（激活完成后宿主侧读）：不在链上——注册回调/生命周期 emit 不落应用账
    expect(chainCaller()).toBeUndefined();
    expect(root.tryGet('fx/probe-result')).toEqual({ applyTime: 'row-caller-id' });
  });
});

/**
 * L1 context — 插件加载器本体测试（真实 jiti 直载 .ts fixture + 虚拟注入端到端）。
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
import { loadPlugins } from './loader.js';
import type { PluginSkillsInfo } from './loader.js';
import type { ContextScope } from './types.js';
import {
  EVENT_DUPLICATE,
  PLUGIN_APPLY_FAILED,
  PLUGIN_CONFIG_INVALID,
  PLUGIN_IMPORT_FORBIDDEN,
  PLUGIN_INJECT_UNRESOLVED,
  PLUGIN_LOAD_FAILED,
  PLUGIN_SHAPE_INVALID,
} from '../contracts/errors.js';
import type {
  PluginActivatedPayload,
  PluginFailedPayload,
  PluginPlanRow,
  PluginSkippedPayload,
} from '../contracts/plugin.js';

/* ---------------- 测试基建 ---------------- */

/** 临时 fixture 目录（realpath 归一——macOS /var 与 /private/var 差异教训） */
function makeFixtureDir(): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ctx-loader-')));
}

/** 写一个 fixture 插件源文件，返回入口绝对路径 */
function writePlugin(dir: string, file: string, source: string): string {
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

/** 建根作用域 + 登记（loadPlugins 的 fork 锚） */
function makeRoot(): ContextScope {
  const root = createContext({ name: 'loader-test' });
  roots.push(root);
  return root;
}

/** 生命周期事件录音（三事件全录——序列断言用） */
function recordLifecycle(root: ContextScope) {
  const events: Array<{ kind: string; payload: unknown }> = [];
  root.on('plugin/activated', (payload: PluginActivatedPayload) => events.push({ kind: 'activated', payload }));
  root.on('plugin/failed', (payload: PluginFailedPayload) => events.push({ kind: 'failed', payload }));
  root.on('plugin/skipped', (payload: PluginSkippedPayload) => events.push({ kind: 'skipped', payload }));
  return events;
}

/* ---------------- 虚拟注入 + 激活主路径 ---------------- */

describe('loadPlugins 虚拟注入与激活', () => {
  it('虚拟模块端到端：fixture 经 berryagent 取 AppError、经 typebox 建 schema，宿主 Value 同实例校验通过', async () => {
    const dir = makeFixtureDir();
    const entry = writePlugin(
      dir,
      'happy.ts',
      [
        "import { AppError } from 'berryagent';",
        "import { Type } from 'typebox';",
        "export const name = 'happy';",
        'export const config = Type.Object({ greeting: Type.String() });',
        'export default async function apply(ctx, rowConfig) {',
        '  ctx.provide("happy-marker", {',
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
    const result = await loadPlugins(root, [{ id: 'happy', entry, config: { greeting: '你好' } }]);

    expect(result.failed).toEqual([]);
    expect(result.activated).toEqual([{ id: 'happy', name: 'happy' }]);
    // 虚拟注入三面全通：宿主错误面可用 / typebox 构 schema（宿主 Value 同实例校验通过才走到 apply）/ config 冻结视图
    const marker = root.tryGet<Record<string, unknown>>('happy-marker');
    expect(marker).toBeTruthy();
    expect(marker!['appErrorUsable']).toBe(true);
    expect(marker!['schemaFromVirtualTypebox']).toBe(true);
    expect(marker!['greeting']).toBe('你好');
    expect(marker!['configFrozen']).toBe(true);
    expect(marker!['configIsRowConfig']).toBe(true);
  });

  it('ctx.rowId：装载器手持注入组合树行 id（件数据目录键正规获取口，P0-1）', async () => {
    const dir = makeFixtureDir();
    const entry = writePlugin(
      dir,
      'rowid.ts',
      [
        "export const name = 'rowid-probe';",
        'export default async function apply(ctx) {',
        '  // 行 id 直读 + 插件内再 fork 的子作用域继承（行身份随 fork 深度保持）',
        '  const child = ctx.fork({ name: "inner" });',
        '  ctx.provide("rowid-probe", { own: ctx.rowId, childSees: child.rowId });',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    // 根/宿主作用域 rowId = undefined（无行归属）
    expect(root.rowId).toBeUndefined();
    const result = await loadPlugins(root, [{ id: 'the-row-id', entry }]);

    expect(result.failed).toEqual([]);
    const probe = root.tryGet<{ own: string | undefined; childSees: string | undefined }>('rowid-probe');
    // loader fork 注入行 id（可与插件声明 name 不同物——行 id 是组合树身份）
    expect(probe!.own).toBe('the-row-id');
    expect(probe!.childSees).toBe('the-row-id');
  });

  it('行 config 未过插件 schema：PLUGIN_CONFIG_INVALID，apply 不执行（无服务泄漏）', async () => {
    const dir = makeFixtureDir();
    const entry = writePlugin(
      dir,
      'schema.ts',
      [
        "import { Type } from 'typebox';",
        "export const name = 'schema';",
        'export const config = Type.Object({ port: Type.Number() });',
        'export default async function apply(ctx) {',
        '  ctx.provide("schema-leak", { ran: true });',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadPlugins(root, [{ id: 'schema', entry, config: { port: '不是数字' } }]);

    expect(result.activated).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.code).toBe(PLUGIN_CONFIG_INVALID);
    expect(result.failed[0]!.message).toContain('port'); // 首个错误路径进诊断
    expect(root.tryGet('schema-leak')).toBeUndefined(); // apply 未执行——无残骸
  });

  it('optionalInject 缺席不阻塞：tryGet 探测得 undefined，照常激活', async () => {
    const dir = makeFixtureDir();
    const entry = writePlugin(
      dir,
      'soft.ts',
      [
        "export const name = 'soft';",
        "export const optionalInject = ['absent-service'];",
        'export default async function apply(ctx) {',
        '  ctx.provide("soft-probe", { absent: ctx.tryGet("absent-service") });',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadPlugins(root, [{ id: 'soft', entry }]);

    expect(result.failed).toEqual([]);
    expect(result.activated).toHaveLength(1);
    expect(root.tryGet<{ absent: unknown }>('soft-probe')!.absent).toBeUndefined();
  });
});

/* ---------------- inject 轮次激活（Kahn 式） ---------------- */

describe('loadPlugins inject 依赖驱动轮次激活', () => {
  it('依赖倒序装载：消费者在前、提供者在后，轮次激活补齐后双双成功', async () => {
    const dir = makeFixtureDir();
    const consumer = writePlugin(
      dir,
      'consumer.ts',
      [
        "export const name = 'consumer';",
        "export const inject = ['kahn-svc'];",
        'export default async function apply(ctx) {',
        '  const svc = ctx.get("kahn-svc");',
        '  ctx.provide("consumer-saw", { value: svc.value });',
        '}',
      ].join('\n'),
    );
    const provider = writePlugin(
      dir,
      'provider.ts',
      [
        "export const name = 'provider';",
        'export default async function apply(ctx) {',
        '  ctx.provide("kahn-svc", { value: 42 });',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const events = recordLifecycle(root);
    // 行序故意把消费者放前（首轮不可激活；提供者激活后第二轮补齐）
    const result = await loadPlugins(root, [
      { id: 'consumer', entry: consumer },
      { id: 'provider', entry: provider },
    ]);

    expect(result.failed).toEqual([]);
    expect(root.tryGet<{ value: number }>('consumer-saw')!.value).toBe(42);
    // 激活顺序：提供者先于消费者（轮次激活语义），事件序与清单序一致
    expect(result.activated.map((item) => item.id)).toEqual(['provider', 'consumer']);
    expect(events.filter((e) => e.kind === 'activated').map((e) => (e.payload as PluginActivatedPayload).id)).toEqual([
      'provider',
      'consumer',
    ]);
  });

  it('缺提供方：PLUGIN_INJECT_UNRESOLVED 响亮失败，列出缺失服务名', async () => {
    const dir = makeFixtureDir();
    const entry = writePlugin(
      dir,
      'waiter.ts',
      [
        "export const name = 'waiter';",
        "export const inject = ['no-such-service'];",
        'export default async function apply(ctx) {',
        '  ctx.provide("waiter-ran", true);',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadPlugins(root, [{ id: 'waiter', entry }]);

    expect(result.activated).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.code).toBe(PLUGIN_INJECT_UNRESOLVED);
    expect(result.failed[0]!.message).toContain('no-such-service');
    expect(root.tryGet('waiter-ran')).toBeUndefined(); // 未激活——无残骸
  });

  it('依赖环：双方 PLUGIN_INJECT_UNRESOLVED，诊断指明疑似依赖环', async () => {
    const dir = makeFixtureDir();
    const a = writePlugin(
      dir,
      'cyc-a.ts',
      [
        "export const name = 'cyc-a';",
        "export const inject = ['cyc-b-svc'];",
        'export default async function apply(ctx) { ctx.provide("cyc-a-svc", true); }',
      ].join('\n'),
    );
    const b = writePlugin(
      dir,
      'cyc-b.ts',
      [
        "export const name = 'cyc-b';",
        "export const inject = ['cyc-a-svc'];",
        'export default async function apply(ctx) { ctx.provide("cyc-b-svc", true); }',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadPlugins(root, [
      { id: 'cyc-a', entry: a },
      { id: 'cyc-b', entry: b },
    ]);

    expect(result.activated).toEqual([]);
    expect(result.failed.map((item) => item.id).sort()).toEqual(['cyc-a', 'cyc-b']);
    for (const item of result.failed) {
      expect(item.code).toBe(PLUGIN_INJECT_UNRESOLVED);
      // 两成因并列诊断：缺失名 + 全体 pending 行（缺失名都在对方 inject 里 = 环）
      expect(item.message).toContain('cyc-a、cyc-b');
      expect(item.message).toContain('缺提供方或依赖环');
    }
  });
});

/* ---------------- 形状与装载失败 ---------------- */

describe('loadPlugins 形状校验与 import 失败', () => {
  it('default 非函数 / name 缺失 / inject 非 string[]：三例皆 PLUGIN_SHAPE_INVALID', async () => {
    const dir = makeFixtureDir();
    const notFn = writePlugin(dir, 'not-fn.ts', ['export const name = "not-fn";', 'export default 42;'].join('\n'));
    const noName = writePlugin(
      dir,
      'no-name.ts',
      ['export default async function apply(ctx) { ctx.provide("no-name-leak", true); }'].join('\n'),
    );
    const badInject = writePlugin(
      dir,
      'bad-inject.ts',
      [
        'export const name = "bad-inject";',
        'export const inject = "not-an-array";',
        'export default async function apply(ctx) {}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadPlugins(root, [
      { id: 'not-fn', entry: notFn },
      { id: 'no-name', entry: noName },
      { id: 'bad-inject', entry: badInject },
    ]);

    expect(result.activated).toEqual([]);
    expect(result.failed).toHaveLength(3);
    // 单行失败不阻断其余行——三行全量诊断
    expect(result.failed.map((item) => [item.id, item.code])).toEqual([
      ['not-fn', PLUGIN_SHAPE_INVALID],
      ['no-name', PLUGIN_SHAPE_INVALID],
      ['bad-inject', PLUGIN_SHAPE_INVALID],
    ]);
    expect(root.tryGet('no-name-leak')).toBeUndefined(); // 形状不过——apply 从未执行
  });

  it('入口语法错误：PLUGIN_LOAD_FAILED（非 AppError 的 import 异常也归一入清单）', async () => {
    const dir = makeFixtureDir();
    const entry = writePlugin(dir, 'broken.ts', 'export const name = "broken";\nthis is ((( not valid\n');
    const root = makeRoot();
    const result = await loadPlugins(root, [{ id: 'broken', entry }]);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.code).toBe(PLUGIN_LOAD_FAILED);
    expect(result.failed[0]!.message).toContain('broken'); // 行 id 进诊断（归因）
  });

  it('虚拟面子路径猜错：import 门禁先拦，消息附六键白名单清单（探针 #12 回归锁 + P0-2 执法面）', async () => {
    const dir = makeFixtureDir();
    // npm 子路径直觉写法——虚拟面只有精确键，子路径既不在白名单也不可解析。
    // P0-2 起 transform 门禁先于 jiti 解析拦下（原 Cannot find → 现更早更准的
    // PLUGIN_IMPORT_FORBIDDEN，消息自带合法路——探针 #12 诉求在新形态下满足）
    const entry = writePlugin(
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
    const result = await loadPlugins(root, [{ id: 'subpath', entry }]);

    expect(result.activated).toEqual([]);
    expect(result.failed[0]!.code).toBe(PLUGIN_IMPORT_FORBIDDEN);
    // 错误自带合法路：六键白名单清单（含扩键后的 berryagent/llm、berryagent/sqlite）
    expect(result.failed[0]!.message).toContain(`'berryagent'`);
    expect(result.failed[0]!.message).toContain(`'typebox/value'`);
    expect(result.failed[0]!.message).toContain(`'berryagent/llm'`);
    expect(result.failed[0]!.message).toContain(`'berryagent/sqlite'`);
  });
});

/* ---------------- import 来源门禁执法（P0-2，契约篇 §1.2 执法面②） ---------------- */

describe('loadPlugins import 来源门禁', () => {
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
      const entry = writePlugin(
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
      const result = await loadPlugins(root, [{ id: 'steal-host', entry }]);

      expect(result.activated).toEqual([]);
      expect(result.failed[0]!.code).toBe(PLUGIN_IMPORT_FORBIDDEN);
      expect(result.failed[0]!.message).toContain('jiti');
      expect(result.failed[0]!.message).toContain('包解析逃逸出插件目录树');
      // 求值前拦截：副作用标记零触达（spike ② 的进程内复证）
      expect((globalThis as Record<string, unknown>).__stealHostEvaluated).toBeUndefined();
      delete (globalThis as Record<string, unknown>).__stealHostEvaluated;
    } finally {
      cleanupFixture(dir);
    }
  });

  it('不可解析裸名拒载：消息指路自捆分发（拼写错与未安装同路）', async () => {
    const dir = makeFixtureDir();
    const entry = writePlugin(
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
    const result = await loadPlugins(root, [{ id: 'ghost-dep', entry }]);

    expect(result.activated).toEqual([]);
    expect(result.failed[0]!.code).toBe(PLUGIN_IMPORT_FORBIDDEN);
    expect(result.failed[0]!.message).toContain('不可解析');
    expect(result.failed[0]!.message).toContain('自捆');
  });

  it('解析对账不等使用：import 了但未使用的越界说明符同样拒载', async () => {
    const dir = makeFixtureInsideHostTree();
    try {
      // jiti 转译会丢弃未使用 import（对照实验实证）——门禁在转译前扫源码，
      // 声明即拦（type-only import 同纪律：源码面统一，不留「未使用即豁免」旁门）
      const entry = writePlugin(
        dir,
        'unused-bind.ts',
        [
          'export const name = "unused-bind";',
          'im' + "port { createJiti } from 'jiti';",
          'export default async function apply() {}',
        ].join('\n'),
      );
      const root = makeRoot();
      const result = await loadPlugins(root, [{ id: 'unused-bind', entry }]);

      expect(result.activated).toEqual([]);
      expect(result.failed[0]!.code).toBe(PLUGIN_IMPORT_FORBIDDEN);
    } finally {
      cleanupFixture(dir);
    }
  });

  it('自捆依赖放行：插件目录树内 node_modules 的包正常 import（正门用例）', async () => {
    const dir = makeFixtureDir();
    // 造自捆包：fixture/node_modules/self-dep（树内解析——第三道白名单的正路形态）
    mkdirSync(join(dir, 'node_modules', 'self-dep'), { recursive: true });
    writeFileSync(
      join(dir, 'node_modules', 'self-dep', 'package.json'),
      JSON.stringify({ name: 'self-dep', version: '1.0.0', type: 'module' }),
    );
    writeFileSync(join(dir, 'node_modules', 'self-dep', 'index.js'), 'export const marker = "self-dep-ok";\n');
    const entry = writePlugin(
      dir,
      'bundled.ts',
      [
        'export const name = "bundled";',
        'im' + "port { marker } from 'self-dep';",
        'export default async function apply(ctx) { ctx.provide("bundled-marker", { marker }); }',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadPlugins(root, [{ id: 'bundled', entry }]);

    expect(result.failed).toEqual([]);
    expect(result.activated).toEqual([{ id: 'bundled', name: 'bundled' }]);
    expect(root.tryGet<{ marker: string }>('bundled-marker')!.marker).toBe('self-dep-ok');
  });

  it('相对路径树内放行 + 子文件逃逸拒载：全图扫描不只看入口（moduleCache:false 对账兜底）', async () => {
    // 树内 helper 正常引用（helper 再引裸内建——嵌套文件同过门禁）
    const okDir = makeFixtureDir();
    writePlugin(
      okDir,
      'helper.ts',
      ["import { join } from 'node:path';\nexport const combined = join('a', 'b');\n"].join(''),
    );
    const okEntry = writePlugin(
      okDir,
      'uses-helper.ts',
      [
        'export const name = "uses-helper";',
        'im' + "port { combined } from './helper.ts';",
        'export default async function apply(ctx) { ctx.provide("helper-marker", { combined }); }',
      ].join('\n'),
    );
    const okRoot = makeRoot();
    const okResult = await loadPlugins(okRoot, [{ id: 'uses-helper', entry: okEntry }]);
    expect(okResult.failed).toEqual([]);
    expect(okRoot.tryGet<{ combined: string }>('helper-marker')!.combined).toBe(join('a', 'b'));

    // 子文件相对路径跳出树根（../../ 指向 tmpdir 层的诱饵文件）——入口干净、依赖脏，同样拒
    const badDir = makeFixtureDir();
    // 子文件源码同样拆段防误扫（逃逸说明符 ../../../outside-dep.js 是执法测试的道具）
    writePlugin(
      badDir,
      'evil-helper.ts',
      ['im' + "port { x } from '../../../outside-dep.js';\nexport const x2 = x;\n"].join(''),
    );
    const badEntry = writePlugin(
      badDir,
      'uses-evil.ts',
      [
        'export const name = "uses-evil";',
        'im' + "port { x2 } from './evil-helper.ts';",
        'export default async function apply() { void x2; }',
      ].join('\n'),
    );
    const badRoot = makeRoot();
    const badResult = await loadPlugins(badRoot, [{ id: 'uses-evil', entry: badEntry }]);
    expect(badResult.activated).toEqual([]);
    expect(badResult.failed[0]!.code).toBe(PLUGIN_IMPORT_FORBIDDEN);
    expect(badResult.failed[0]!.message).toContain('相对路径解析逃逸出插件目录树');
    expect(badResult.failed[0]!.message).toContain('evil-helper');
  });

  it('node: 显式与裸内建放行：fs/path/crypto 等宿主运行时直用合法', async () => {
    const dir = makeFixtureDir();
    const entry = writePlugin(
      dir,
      'natives.ts',
      [
        'export const name = "natives";',
        "import { join } from 'node:path';",
        "import { isBuiltin } from 'node:module';",
        'im' + "port { basename } from 'path';", // 裸内建（无 node: 前缀）——插件允许的形态
        'export default async function apply(ctx) {',
        '  ctx.provide("natives-marker", { joined: join("x", "y"), builtin: isBuiltin("path"), base: basename("/a/b.ts") });',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadPlugins(root, [{ id: 'natives', entry }]);

    expect(result.failed).toEqual([]);
    const marker = root.tryGet<Record<string, unknown>>('natives-marker')!;
    expect(marker['joined']).toBe(join('x', 'y'));
    expect(marker['builtin']).toBe(true);
    expect(marker['base']).toBe('b.ts');
  });

  it('第五/六键注入物端到端：virtualFaces 传入即经 berryagent/llm、berryagent/sqlite 取得', async () => {
    const dir = makeFixtureDir();
    const entry = writePlugin(
      dir,
      'faces.ts',
      [
        'export const name = "faces";',
        "import { createProvider, hasApi } from 'berryagent/llm';",
        "import { openDatabase } from 'berryagent/sqlite';",
        'export default async function apply(ctx) {',
        '  ctx.provide("faces-marker", {',
        '    provider: createProvider({ id: "fake" }),',
        '    guard: hasApi({} as never, "fake"),',
        '    db: openDatabase(":memory:"),',
        '  });',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadPlugins(root, [{ id: 'faces', entry }], {
      virtualFaces: {
        llm: {
          createProvider: (options: { id: string }) => ({ kind: 'provider', ...options }),
          hasApi: () => true,
        },
        sqlite: { openDatabase: (path: string) => ({ kind: 'db', path }) },
      },
    });

    expect(result.failed).toEqual([]);
    const marker = root.tryGet<Record<string, unknown>>('faces-marker')!;
    expect(marker['provider']).toEqual({ kind: 'provider', id: 'fake' });
    expect(marker['guard']).toBe(true);
    expect(marker['db']).toEqual({ kind: 'db', path: ':memory:' });
  });

  it('virtualFaces 缺省：两键恒在虚拟面（import 不炸），面为空由插件自查', async () => {
    const dir = makeFixtureDir();
    const entry = writePlugin(
      dir,
      'empty-faces.ts',
      [
        'export const name = "empty-faces";',
        "import * as llmFace from 'berryagent/llm';",
        "import * as sqliteFace from 'berryagent/sqlite';",
        'export default async function apply(ctx) {',
        '  ctx.provide("empty-faces-marker", {',
        '    llmKeys: Object.keys(llmFace).length,',
        '    sqliteKeys: Object.keys(sqliteFace).length,',
        '  });',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadPlugins(root, [{ id: 'empty-faces', entry }]);

    expect(result.failed).toEqual([]);
    const marker = root.tryGet<Record<string, unknown>>('empty-faces-marker')!;
    expect(marker['llmKeys']).toBe(0);
    expect(marker['sqliteKeys']).toBe(0);
  });
});

/* ---------------- apply 抛错回卷与生命周期事件 ---------------- */

describe('loadPlugins apply 失败回卷与生命周期事件', () => {
  it('apply 抛错：先回卷本作用域（服务下架 + effect 清理执行）再 PLUGIN_APPLY_FAILED', async () => {
    const dir = makeFixtureDir();
    const entry = writePlugin(
      dir,
      'boom.ts',
      [
        'export const name = "boom";',
        'export default async function apply(ctx) {',
        '  ctx.provide("boom-svc", { on: true });',
        '  ctx.effect(() => () => { (globalThis).__boomCleaned = true; });',
        '  throw new Error("apply 炸了");',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadPlugins(root, [{ id: 'boom', entry }]);

    expect(result.activated).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.code).toBe(PLUGIN_APPLY_FAILED);
    expect(result.failed[0]!.message).toContain('apply 炸了');
    // 失败行不留残骸（§1.6）：半途 provide 已回卷、effect 清理已执行
    expect(root.tryGet('boom-svc')).toBeUndefined();
    expect((globalThis as Record<string, unknown>)['__boomCleaned']).toBe(true);
  });

  it('三态混合装载：生命周期事件逐行必发且与清单一致（§2.2 增补 1）', async () => {
    const dir = makeFixtureDir();
    const ok = writePlugin(
      dir,
      'ok.ts',
      ['export const name = "ok";', 'export default async function apply(ctx) { ctx.provide("ok-svc", true); }'].join(
        '\n',
      ),
    );
    const offEntry = writePlugin(
      dir,
      'off.ts',
      'export const name = "off";\nexport default async function apply() {}\n',
    );
    const root = makeRoot();
    const events = recordLifecycle(root);
    const rows: PluginPlanRow[] = [
      { id: 'ok', entry: ok },
      { id: 'off', skip: 'disabled' }, // 跳过行不 import——off.ts 存在与否无关
      { id: 'ghost', unresolved: '插件「ghost」入口无法解析' }, // 解析失败行不 import
    ];
    const result = await loadPlugins(root, rows);

    // 清单三态
    expect(result.activated.map((item) => item.id)).toEqual(['ok']);
    expect(result.skipped).toEqual([{ id: 'off', reason: 'disabled' }]);
    expect(result.failed.map((item) => [item.id, item.code])).toEqual([['ghost', 'PLUGIN_ENTRY_UNRESOLVED']]);
    // 事件逐行必发（push 诊断面）：序 = 装载序（跳过/失败在 import 阶段，激活在轮次阶段）
    expect(events.map((e) => `${e.kind}:${(e.payload as { id: string }).id}`)).toEqual([
      'skipped:off',
      'failed:ghost',
      'activated:ok',
    ]);
    expect(root.tryGet('ok-svc')).toBe(true);
  });
});

/* ---------------- 自定义事件词汇（events 第四件，§1.1 逃生口） ---------------- */

describe('loadPlugins 自定义事件词汇登记', () => {
  it('跨插件订阅无顺序洞：订阅行在前、声明行在后——词汇装载期入册，on 不炸、派发端到端送达', async () => {
    const dir = makeFixtureDir();
    const listener = writePlugin(
      dir,
      'listener.ts',
      [
        'export const name = "listener";',
        'export default async function apply(ctx) {',
        '  ctx.on("emitter/done", (payload: { n: number }) => {',
        '    ctx.provide("listener-saw", payload.n);',
        '  });',
        '}',
      ].join('\n'),
    );
    const emitter = writePlugin(
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
    // 订阅者的 on 不因声明行更晚激活而炸 EVENT_UNKNOWN（跨插件订阅无顺序洞回归锁）
    const result = await loadPlugins(root, [
      { id: 'listener', entry: listener },
      { id: 'emitter', entry: emitter },
    ]);

    expect(result.failed).toEqual([]);
    expect(result.activated).toHaveLength(2);
    expect(root.tryGet('listener-saw')).toBe(7); // on 在册通过 + emit 送达
  });

  it('events 声明非法（name 无 /、mode 非四值、缺 note）三例皆 PLUGIN_SHAPE_INVALID，apply 从未执行', async () => {
    const dir = makeFixtureDir();
    const noSlash = writePlugin(
      dir,
      'no-slash.ts',
      [
        'export const name = "no-slash";',
        'export const events = [{ name: "noslash", mode: "emit", note: "x" }];',
        'export default async function apply(ctx) { ctx.provide("no-slash-leak", true); }',
      ].join('\n'),
    );
    const badMode = writePlugin(
      dir,
      'bad-mode.ts',
      [
        'export const name = "bad-mode";',
        'export const events = [{ name: "bad/mode", mode: "fire", note: "x" }];',
        'export default async function apply() {}',
      ].join('\n'),
    );
    const noNote = writePlugin(
      dir,
      'no-note.ts',
      [
        'export const name = "no-note";',
        'export const events = [{ name: "no/note", mode: "emit" }];',
        'export default async function apply() {}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadPlugins(root, [
      { id: 'no-slash', entry: noSlash },
      { id: 'bad-mode', entry: badMode },
      { id: 'no-note', entry: noNote },
    ]);

    expect(result.activated).toEqual([]);
    expect(result.failed.map((item) => [item.id, item.code])).toEqual([
      ['no-slash', PLUGIN_SHAPE_INVALID],
      ['bad-mode', PLUGIN_SHAPE_INVALID],
      ['no-note', PLUGIN_SHAPE_INVALID],
    ]);
    // 归因单源：行 id 只在失败信封（item.id）与清单格式出现，消息体内不再重复
    // 前缀（探针 #14 回归锁——曾出现「hermes-core：hermes-core：」双前缀）
    for (const item of result.failed) {
      expect(item.message.startsWith(`${item.id}：`)).toBe(false);
    }
    expect(root.tryGet('no-slash-leak')).toBeUndefined(); // 声明面不过——apply 从未执行
  });

  it('effect 回调返回非函数：装载期即失败并带正确习语指引（探针 #13——jiti 无类型护栏的运行时补位）', async () => {
    const dir = makeFixtureDir();
    // 病灶习语：const d = …; ctx.effect(() => d())——注册即注销 + undefined 入栈
    const entry = writePlugin(
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
    const result = await loadPlugins(root, [{ id: 'bad-effect', entry }]);

    expect(result.activated).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.code).toBe(PLUGIN_APPLY_FAILED);
    // 指引链路：apply 失败消息内含 CONTEXT_EFFECT_INVALID 码与正确习语
    expect(result.failed[0]!.message).toContain('CONTEXT_EFFECT_INVALID');
    expect(result.failed[0]!.message).toContain('ctx.effect(d)');
  });

  it('撞名：两行声明同名 / 撞宿主目录名皆 EVENT_DUPLICATE——词汇表拒绝静默覆盖，先到者照常激活', async () => {
    const dir = makeFixtureDir();
    const first = writePlugin(
      dir,
      'twice-a.ts',
      [
        'export const name = "twice-a";',
        'export const events = [{ name: "twice/evt", mode: "emit", note: "先到" }];',
        'export default async function apply() {}',
      ].join('\n'),
    );
    const second = writePlugin(
      dir,
      'twice-b.ts',
      [
        'export const name = "twice-b";',
        'export const events = [{ name: "twice/evt", mode: "emit", note: "后到" }];',
        'export default async function apply() {}',
      ].join('\n'),
    );
    // 撞宿主目录名须选「格式合法且在目录」的名字（plugin/activated 含斜线小写合法）；
    // tools_change 类无斜线名先被格式检查拦下——宿主自留地由格式纪律防住，到不了撞名检查
    const catalogClash = writePlugin(
      dir,
      'catalog-clash.ts',
      [
        'export const name = "catalog-clash";',
        'export const events = [{ name: "plugin/activated", mode: "emit", note: "撞宿主目录名" }];',
        'export default async function apply() {}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadPlugins(root, [
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

/* ---------------- 技能目录注册回调（§1.2 第六件，2026-08-26 技能包插件纵切） ---------------- */

describe('loadPlugins 技能目录注册回调', () => {
  it('回调时序：行作用域 fork 后、apply 之前——回调先于 apply 收到完整行信息', async () => {
    const dir = makeFixtureDir();
    const entry = writePlugin(
      dir,
      'skillpack.ts',
      [
        "export const name = 'skillpack';",
        "export const skills = ['./skills'];",
        'export default async function apply(ctx) {',
        '  ctx.provide("skillpack-apply-ran", true);',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const seen: PluginSkillsInfo[] = [];
    const result = await loadPlugins(root, [{ id: 'skillpack', entry }], {
      registerSkills: (info) => {
        // 时序锚点：回调时 apply 尚未执行（fork 后 apply 前的登记位——冷读裁决）
        seen.push(info);
        expect(root.tryGet('skillpack-apply-ran')).toBeUndefined();
      },
    });

    expect(result.failed).toEqual([]);
    expect(result.activated).toEqual([{ id: 'skillpack', name: 'skillpack' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe('skillpack');
    expect(seen[0]!.packageRoot).toBe(dir); // 包根 = 入口文件所在目录
    expect(seen[0]!.dirs).toEqual(['./skills']);
    expect(seen[0]!.scope).toBeTruthy(); // 行作用域已 fork（回调可挂 effect）
    expect(root.tryGet('skillpack-apply-ran')).toBe(true); // apply 事后确实跑了
  });

  it('apply 抛错回卷：回调挂行作用域的 effect 随 dispose 回卷（技能是行资产，失败不留残骸）', async () => {
    const dir = makeFixtureDir();
    const entry = writePlugin(
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
    const result = await loadPlugins(root, [{ id: 'boom', entry }], {
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
    expect(result.failed[0]!.code).toBe(PLUGIN_APPLY_FAILED);
    expect(cleaned).toBe(true); // apply 抛错 → scope.dispose() → 注册 effect LIFO 回卷
  });

  it('未注入回调：skills 声明行照常激活（老调用方兼容面——回调是可选参数）', async () => {
    const dir = makeFixtureDir();
    const entry = writePlugin(
      dir,
      'nohook.ts',
      [
        "export const name = 'nohook';",
        "export const skills = ['./skills'];",
        'export default async function apply(ctx) {',
        '  ctx.provide("nohook-ran", true);',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadPlugins(root, [{ id: 'nohook', entry }]);

    expect(result.failed).toEqual([]);
    expect(result.activated).toEqual([{ id: 'nohook', name: 'nohook' }]);
    expect(root.tryGet('nohook-ran')).toBe(true);
  });

  it('纯技能包最小形态：name + skills + default 空实现三件零逻辑即合法插件', async () => {
    const dir = makeFixtureDir();
    const entry = writePlugin(
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
    const result = await loadPlugins(root, [{ id: 'pure', entry }], {
      registerSkills: () => {
        called = true;
      },
    });

    expect(result.failed).toEqual([]);
    expect(result.activated).toEqual([{ id: 'pure', name: 'pure' }]);
    expect(called).toBe(true); // 空实现也走技能注册（纯技能包的唯一起作用面）
  });

  it('skills 非 string[]：PLUGIN_SHAPE_INVALID，apply 不执行', async () => {
    const dir = makeFixtureDir();
    const entry = writePlugin(
      dir,
      'badskills.ts',
      [
        "export const name = 'badskills';",
        "export const skills = './skills';",
        'export default async function apply(ctx) {',
        '  ctx.provide("badskills-leak", true);',
        '}',
      ].join('\n'),
    );
    const root = makeRoot();
    const result = await loadPlugins(root, [{ id: 'badskills', entry }]);

    expect(result.activated).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.code).toBe(PLUGIN_SHAPE_INVALID);
    expect(result.failed[0]!.message).toContain('skills');
    expect(root.tryGet('badskills-leak')).toBeUndefined(); // 声明面不过——apply 从未执行
  });

  it('builtin 行声明 skills：回调收到 packageRoot undefined（宿主函数件无磁盘锚点）', async () => {
    const root = makeRoot();
    const seen: PluginSkillsInfo[] = [];
    const result = await loadPlugins(
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
    expect(result.activated).toEqual([{ id: 'builtin-demo', name: 'demo' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.packageRoot).toBeUndefined(); // builtin 行无入口文件——组合根侧跳过注册
    expect(root.tryGet('builtin-demo-ran')).toBe(true);
  });
});

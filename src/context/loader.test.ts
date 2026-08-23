/**
 * L1 context — 插件加载器本体测试（真实 jiti 直载 .ts fixture + 虚拟注入端到端）。
 *
 * 纪律对照：不 mock 加载器任何内部——fixture 是磁盘上的真 .ts 文件，经与生产
 * 完全相同的 jiti 路径（虚拟模块 berryagent/typebox）装载；断言面 = 返回清单 +
 * root 服务注册表 + root 事件序列。测试文件只引 context 模块与 contracts
 * （拓扑白名单边），fixture 不引宿主内部实现（零 import 面，契约篇 §3）。
 */

import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createContext } from './context.js';
import { loadPlugins } from './loader.js';
import type { ContextScope } from './types.js';
import {
  EVENT_DUPLICATE,
  PLUGIN_APPLY_FAILED,
  PLUGIN_CONFIG_INVALID,
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
    expect(root.tryGet('no-slash-leak')).toBeUndefined(); // 声明面不过——apply 从未执行
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

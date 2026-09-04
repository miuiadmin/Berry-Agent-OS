/**
 * L5 app — `--app-file` 快速试件回归锁（契约篇 §5.5；冷读 B1 补——
 * 落码时全仓零测试，B1（plan 行缺 entry → dirname(undefined) 装载必炸）
 * 因此漏网进主干。本文件锁死全部已拍板行为）。
 *
 * 覆盖面：
 * - 正路：注入 → jiti 真装载 → 工具注册（chat 应用域层可见）→ /apps 可见
 * - /reload 丢行：fresh 读盘不含 _quick_test（不变式 4）
 * - --no-apps 安全模式胜出：_quick_test 随 Ring 2 全跳（不变式 5）
 * - 路径校验：不存在 / 目录 → APP_ENTRY_UNRESOLVED（不变式 3）
 * - 撞名执法：overlay 已有 _quick_test 行 → COMPOSITION_ROW_INVALID（不变式 6）
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSessionEventType } from '../contracts/session-events.js';
import { createRuntime, type AppRuntime } from './assembly.js';

const runtimes: AppRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
});

/** 写一个最小测试应用（注册一个工具），返回入口文件绝对路径 */
function writeTestApp(root: string): string {
  const appDir = join(root, 'quick-test-app');
  return writeTestEntry(appDir);
}

/**
 * 在指定目录写最小测试应用入口（刀 H 测试用——布局自由：入口与清单的相对
 * 位置即被测变体），返回入口文件绝对路径。
 */
function writeTestEntry(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, 'index.ts');
  writeFileSync(
    entry,
    [
      'export const name = "quick-test";',
      'export const inject = ["tools"];',
      'export default async function apply(ctx) {',
      '  const tools = ctx.get("tools");',
      '  ctx.effect(() =>',
      '    tools.register({',
      '      name: "quick_tool",',
      '      description: "快速试件工具（回归锁）",',
      '      parameters: { type: "object", properties: {} },',
      '      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),',
      '    }),',
      '  );',
      '}',
    ].join('\n'),
  );
  return entry;
}

/** 写一份合法清单（带 api 块）到指定目录——刀 H 装载门测试的清单腿 */
function writeGatedManifest(dir: string, minApiVersion: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'quick-gated.app.yaml'),
    [
      'id: quick-gated',
      'label: 快速试件门测试',
      'components: [builtin:chat]',
      'api:',
      `  minApiVersion: "${minApiVersion}"`,
      '',
    ].join('\n'),
  );
}

describe('--app-file 快速试件（契约篇 §5.5 回归锁）', () => {
  it('正路：注入→jiti 真装载→工具注册（chat 应用域可见）→ /apps 状态可见', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-file-')));
    const entry = writeTestApp(root);

    const runtime = await createRuntime({
      dbPath: ':memory:',
      workspace: root,
      appFile: entry,
    });
    runtimes.push(runtime);

    // 行激活（装载管线走通——形状校验/import 门禁/Kahn/apply 全过）
    const row = runtime.appsService.list().find((r) => r.id === '_quick_test');
    expect(row?.status).toBe('activated');

    // 工具注册在 chat 应用域层（listFor 可见；全局口径不可见——挂 apps 行的语义）
    expect(runtime.tools.listFor('chat').map((t) => t.name)).toContain('quick_tool');
    expect(runtime.tools.list().map((t) => t.name)).not.toContain('quick_tool');
  });

  it('/reload 丢行：fresh 读盘不含 _quick_test（不变式 4——快试态丢失 = 预期）', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-file-reload-')));
    const entry = writeTestApp(root);

    const runtime = await createRuntime({
      dbPath: ':memory:',
      workspace: root,
      appFile: entry,
    });
    runtimes.push(runtime);

    expect(runtime.composition.rows.some((r) => r.id === '_quick_test')).toBe(true);
    const result = await runtime.reload();
    expect(result.error).toBeUndefined();
    expect(runtime.composition.rows.some((r) => r.id === '_quick_test')).toBe(false);
    expect(runtime.tools.listFor('chat').map((t) => t.name)).not.toContain('quick_tool');
  });

  it('--no-apps 安全模式胜出：_quick_test 随 Ring 2 全跳（不变式 5）', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-file-noapps-')));
    const entry = writeTestApp(root);

    const runtime = await createRuntime({
      dbPath: ':memory:',
      workspace: root,
      noApps: true,
      appFile: entry,
    });
    runtimes.push(runtime);

    // safeModeComposition 完全过滤非 Ring 1 行——不进 plan → 无装载 → apps list 不含
    const row = runtime.appsService.list().find((r) => r.id === '_quick_test');
    expect(row).toBeUndefined();
    expect(runtime.tools.listFor('chat').map((t) => t.name)).not.toContain('quick_tool');
  });

  it('路径不存在：APP_ENTRY_UNRESOLVED 拒启 + 文案指路', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-file-missing-')));
    const err = await createRuntime({
      dbPath: ':memory:',
      workspace: root,
      appFile: join(root, 'nonexistent', 'index.ts'),
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toBe('APP_ENTRY_UNRESOLVED');
    expect((err as { message?: string }).message).toContain('nonexistent');
  });

  it('目录路径（存在但非文件）：APP_ENTRY_UNRESOLVED + 文案「须为入口文件」', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-file-dir-')));
    const err = await createRuntime({
      dbPath: ':memory:',
      workspace: root,
      appFile: root, // 目录本身——existsSync 过但 isFile 不过
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toBe('APP_ENTRY_UNRESOLVED');
    expect((err as { message?: string }).message).toContain('须为入口文件');
  });

  it('撞名执法：overlay 已有 _quick_test 行 → COMPOSITION_ROW_INVALID 拒启（不变式 6）', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-file-clash-')));
    const entry = writeTestApp(root);
    const compositionDir = join(root, 'composition');
    mkdirSync(compositionDir, { recursive: true });
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: _quick_test\n    pkg: ${entry}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );

    const err = await createRuntime({
      dbPath: ':memory:',
      workspace: root,
      compositionDir,
      appFile: entry,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toBe('COMPOSITION_ROW_INVALID');
    expect((err as { message?: string }).message).toContain('_quick_test');
  });
});

describe('--app-file 装载门全入口同律（API 治理进化刀 H，契约篇 §6.13.4）', () => {
  it('min 地板拒载：清单在入口同目录 + minApiVersion 超宿主 → API_VERSION_MISMATCH 拒启（快试行不再绕门）', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-file-gate-')));
    const entry = writeTestEntry(join(root, 'quick-gated'));
    writeGatedManifest(join(root, 'quick-gated'), '99.0');

    const err = await createRuntime({
      dbPath: ':memory:',
      workspace: root,
      appFile: entry,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toBe('API_VERSION_MISMATCH');
    // 失败面文案指 --app-file（refuseBoot 直拒——快试行不进合成管线，无 unresolved 行面）
    expect((err as { message?: string }).message).toContain('--app-file 装载门拒载');
    expect((err as { message?: string }).message).toContain('99.0');
  });

  it('根公式单层上爬：清单在入口目录上一级（extensions/ 布局）→ 同拒', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-file-gate-up-')));
    // 入口深一层（dist/），清单在包根——第二腿（dirname 上爬）才读得到
    const entry = writeTestEntry(join(root, 'ext', 'quick', 'dist'));
    writeGatedManifest(join(root, 'ext', 'quick'), '99.0');

    const err = await createRuntime({
      dbPath: ':memory:',
      workspace: root,
      appFile: entry,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toBe('API_VERSION_MISMATCH');
    expect((err as { message?: string }).message).toContain('--app-file 装载门拒载');
  });

  it('再深不上爬（fail-closed）：清单在入口目录上两级 → 空门 → 照常激活（控制腿——无过度上爬）', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-file-gate-deep-')));
    const entry = writeTestEntry(join(root, 'ext', 'quick', 'dist'));
    // 清单放在 ext/（离入口两级）——根公式只上爬一层，读不到 = 空门 fail-closed
    writeGatedManifest(join(root, 'ext'), '99.0');

    const runtime = await createRuntime({
      dbPath: ':memory:',
      workspace: root,
      appFile: entry,
    });
    runtimes.push(runtime);
    const row = runtime.appsService.list().find((r) => r.id === '_quick_test');
    expect(row?.status).toBe('activated');
  });

  it('正路不破：带合法 api 块清单（min = 宿主当前）→ gate 随行照常激活', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-file-gate-ok-')));
    const entry = writeTestEntry(join(root, 'quick-ok'));
    writeGatedManifest(join(root, 'quick-ok'), '1.0');

    const runtime = await createRuntime({
      dbPath: ':memory:',
      workspace: root,
      appFile: entry,
    });
    runtimes.push(runtime);
    const row = runtime.appsService.list().find((r) => r.id === '_quick_test');
    expect(row?.status).toBe('activated');
  });

  it('废弃遥测词装配序在册：apps/deprecation-used 随 assembly 导入链注册（reserved——应用无从抢注）', () => {
    // 装配序显式导入腿的可观测面：assembly 模块图在册 ⇒ 任意应用装载（装载
    // 阶段① validateEventDefs 词汇登记窗）之前宿主保留词已占位（登记处重名
    // 即抛——应用侧抢注同名词只会自爆，词权不会旁落）
    const def = getSessionEventType('apps/deprecation-used');
    expect(def?.reserved).toBe(true);
    expect(def?.category).toBe('log-only');
  });
});

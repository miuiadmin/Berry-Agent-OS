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
import { createRuntime, type AppRuntime } from './assembly.js';

const runtimes: AppRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
});

/** 写一个最小测试应用（注册一个工具），返回入口文件绝对路径 */
function writeTestApp(root: string): string {
  const appDir = join(root, 'quick-test-app');
  mkdirSync(appDir, { recursive: true });
  const entry = join(appDir, 'index.ts');
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

import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb, closeDb } from '../memory/db.js';
import { PluginLoader } from './loader.js';
import { PluginRuntime } from './runtime.js';
import { PluginRegistry } from './generator.js';
import type { PluginManifest } from './types.js';

let tempDir: string;
let db: Database.Database;
let pluginsDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'berry-plugin-rt-'));
  const dbPath = join(tempDir, 'test.db');
  db = initDb(dbPath);
  pluginsDir = join(tempDir, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
});

afterEach(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

function createTestPlugin(name: string, toolCode: string): PluginManifest {
  const registry = new PluginRegistry(db, pluginsDir);
  registry.createDraft({ name, description: `测试插件 ${name}`, evidence: [], riskLevel: 'low' });
  const manifest = registry.get(name)!;

  const entryContent = `export default {
  name: '${name}',
  tools: {
    ${toolCode}
  },
};
`;
  writeFileSync(manifest.entryPath, entryContent);

  registry.validate(name);
  registry.enable(name);
  return registry.get(name)!;
}

describe('PluginRuntime', () => {
  it('加载有效插件并执行工具返回正确结果', async () => {
    const manifest = createTestPlugin('echo-test', `
    'echo_test_run': async (input) => {
      return { ok: true, message: input.input };
    },`);

    const loader = new PluginLoader();
    const runtime = new PluginRuntime(db, loader);
    await runtime.initialize([manifest]);

    const result = await runtime.execute('echo-test', 'echo_test_run', { input: 'hello' });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ ok: true, message: 'hello' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('插件 handler 抛异常时返回 error', async () => {
    const manifest = createTestPlugin('error-test', `
    'error_test_run': async () => {
      throw new Error('故意失败');
    },`);

    const loader = new PluginLoader();
    const runtime = new PluginRuntime(db, loader);
    await runtime.initialize([manifest]);

    const result = await runtime.execute('error-test', 'error_test_run', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('故意失败');
  });

  it('disabled 插件不被加载', async () => {
    const registry = new PluginRegistry(db, pluginsDir);
    registry.createDraft({ name: 'disabled-test', description: '测试', evidence: [], riskLevel: 'low' });
    const manifest = registry.get('disabled-test')!;
    writeFileSync(manifest.entryPath, `export default { name: 'disabled-test', tools: {} };`);
    registry.validate('disabled-test');

    const loader = new PluginLoader();
    const runtime = new PluginRuntime(db, loader);
    await runtime.initialize([registry.get('disabled-test')!]);

    expect(loader.getLoaded().size).toBe(0);
  });

  it('getPluginTools() 返回正确的 ToolDefinition', async () => {
    const manifest = createTestPlugin('tools-test', `
    'tools_test_run': async (input) => {
      return { result: 'ok' };
    },`);

    const loader = new PluginLoader();
    const runtime = new PluginRuntime(db, loader);
    await runtime.initialize([manifest]);

    const tools = runtime.getPluginTools();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('plugin:tools-test:tools_test_run');
    expect(tools[0].description).toContain('tools-test');
    expect(tools[0].dangerLevel).toBe('safe');
  });

  it('execute 更新使用统计', async () => {
    const manifest = createTestPlugin('stats-test', `
    'stats_test_run': async () => {
      return { ok: true };
    },`);

    const loader = new PluginLoader();
    const runtime = new PluginRuntime(db, loader);
    await runtime.initialize([manifest]);

    await runtime.execute('stats-test', 'stats_test_run', {});
    await runtime.execute('stats-test', 'stats_test_run', {});

    const row = db.prepare(`SELECT use_count, success_count FROM plugins_meta WHERE name = ?`)
      .get('stats-test') as { use_count: number; success_count: number };
    expect(row.use_count).toBe(2);
    expect(row.success_count).toBe(2);
  });

  it('不存在的插件返回 error', async () => {
    const loader = new PluginLoader();
    const runtime = new PluginRuntime(db, loader);
    await runtime.initialize([]);

    const result = await runtime.execute('nonexistent', 'tool', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未加载');
  });

  it('不存在的工具返回 error', async () => {
    const manifest = createTestPlugin('no-tool-test', `
    'no_tool_test_run': async () => {
      return { ok: true };
    },`);

    const loader = new PluginLoader();
    const runtime = new PluginRuntime(db, loader);
    await runtime.initialize([manifest]);

    const result = await runtime.execute('no-tool-test', 'nonexistent', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不存在');
  });

  it('ToolDefinition 的 execute 可调用', async () => {
    const manifest = createTestPlugin('exec-test', `
    'exec_test_run': async (input) => {
      return { doubled: input.value * 2 };
    },`);

    const loader = new PluginLoader();
    const runtime = new PluginRuntime(db, loader);
    await runtime.initialize([manifest]);

    const tools = runtime.getPluginTools();
    const result = await tools[0].execute({ value: 21 });
    expect(result.content).toContain('"doubled":42');
    expect(result.isError).toBeUndefined();
  });
});

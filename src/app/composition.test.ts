/**
 * L5 app — 组合树测试（overlay 装载/拒绝式校验/合成/入口解析/目录与插件服务）。
 *
 * 全部用真实临时目录 + 真实 overlay.yaml（「装什么/在哪」的纯合成面——无 LLM
 * 无进程交互，不需要 mock 层）；入口解析覆盖路径直引、装机子树裸名、
 * harness 字段与约定目录回退、禁用行不解析（挂载休眠）。
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError, COMPOSITION_ROW_INVALID } from '../contracts/errors.js';
import type { PluginLoadResult } from '../contracts/plugin.js';
import { loadComposition, resolvePluginEntry } from './composition.js';
import { createPathsService, createPluginsService } from './composition.js';

/* ---------------- 测试基建 ---------------- */

/** 临时数据目录（overlay 与装机子树的根） */
function makeDataDir(): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-comp-')));
}

/** 写 overlay.yaml（rows 数组直接序列化为 YAML 文本） */
function writeOverlay(dataDir: string, rowsSource: string): void {
  writeFileSync(join(dataDir, 'overlay.yaml'), `rows:\n${rowsSource}`);
}

/** 最小合法插件入口（合成测试只关心文件存在，内容不 import） */
function writeEntryFile(dir: string, file = 'entry.ts'): string {
  writeFileSync(join(dir, file), 'export const name = "stub";\nexport default async function apply() {}\n');
  return join(dir, file);
}

/* ---------------- overlay 装载与拒绝式校验 ---------------- */

describe('overlay 装载与拒绝式校验', () => {
  it('overlay 不存在 = 空 overlay：零配置首启合法（空树）', () => {
    const report = loadComposition(makeDataDir());
    expect(report.rows).toEqual([]);
    expect(report.plan).toEqual([]);
  });

  it('insert 行带路径引用：行进树、入口解析为该文件绝对路径', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: local\n    plugin: ${entry}\n`);
    const report = loadComposition(dataDir);
    expect(report.rows).toEqual([{ id: 'local', plugin: entry }]);
    expect(report.plan).toEqual([{ id: 'local', entry }]);
  });

  it('未知字段 / 缺 id / 顶层形状错：COMPOSITION_ROW_INVALID 拒绝式（不误读）', () => {
    const unknownField = makeDataDir();
    writeOverlay(unknownField, '  - id: a\n    pluginx: y\n');
    expect(() => loadComposition(unknownField)).toThrowError(/未知字段「pluginx」/);

    const noId = makeDataDir();
    writeOverlay(noId, '  - plugin: x\n');
    expect(() => loadComposition(noId)).toThrowError(/id 必填/);

    const badTop = makeDataDir();
    writeFileSync(join(badTop, 'overlay.yaml'), 'just-a-string\n');
    expect(() => loadComposition(badTop)).toThrowError(/顶层必须是/);
  });

  it('insert 行缺 plugin 引用：合成期即拒（无官方层引用可沿用）', () => {
    const dataDir = makeDataDir();
    writeOverlay(dataDir, '  - id: ghost-row\n');
    try {
      loadComposition(dataDir);
      expect.unreachable('insert 缺 plugin 必须合成期拒绝');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(COMPOSITION_ROW_INVALID);
      expect((err as AppError).message).toContain('insert 新行必须自带 plugin');
    }
  });

  it('overlay 设置 fixed 字段：拒绝（安全栈强制点只能官方层携带）', () => {
    const dataDir = makeDataDir();
    writeOverlay(dataDir, '  - id: x\n    plugin: p\n    fixed: true\n');
    expect(() => loadComposition(dataDir)).toThrowError(/fixed 只能出现在官方默认层/);
  });

  it('disabled 类型拒绝式：非 true 非平台名即拒', () => {
    const dataDir = makeDataDir();
    writeOverlay(dataDir, '  - id: x\n    plugin: p\n    disabled: maybe\n');
    expect(() => loadComposition(dataDir)).toThrowError(/disabled 必须是 true 或平台名/);
  });
});

/* ---------------- 禁用解析与挂载休眠 ---------------- */

describe('禁用解析（挂载休眠）', () => {
  it('disabled:true 跳过行不解析入口：插件未安装也不失败', () => {
    const dataDir = makeDataDir();
    // plugin 指向不存在的裸名——禁用行不要求已装
    writeOverlay(dataDir, '  - id: dormant\n    plugin: never-installed-pkg\n    disabled: true\n');
    const report = loadComposition(dataDir);
    expect(report.plan).toEqual([{ id: 'dormant', skip: 'disabled' }]);
  });

  it('平台门控：命中当前平台 → platform 跳过；他平台 → 照常激活', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    const other = process.platform === 'win32' ? 'linux' : 'win32';
    writeOverlay(
      dataDir,
      `  - id: gated\n    plugin: never-installed\n    disabled: ${process.platform}\n` +
        `  - id: ungated\n    plugin: ${entry}\n    disabled: ${other}\n`,
    );
    const report = loadComposition(dataDir);
    expect(report.plan).toEqual([
      { id: 'gated', skip: 'platform' }, // 命中当前平台——不解析入口
      { id: 'ungated', entry }, // 他平台门控不生效——照常激活
    ]);
  });
});

/* ---------------- 入口解析（裸名装机子树 + harness 字段） ---------------- */

describe('插件入口解析', () => {
  it('裸名 → <数据目录>/plugins/node_modules/<包名> + package.json harness.extensions 首选', () => {
    const dataDir = makeDataDir();
    const pkgDir = join(dataDir, 'plugins', 'node_modules', 'fake-pkg');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ harness: { extensions: ['custom-entry.ts'] } }));
    writeEntryFile(pkgDir, 'custom-entry.ts');

    expect(resolvePluginEntry('fake-pkg', dataDir)).toBe(join(pkgDir, 'custom-entry.ts'));
    // 经组合树同路径（overlay 裸名行全链路）
    writeOverlay(dataDir, '  - id: p1\n    plugin: fake-pkg\n');
    expect(loadComposition(dataDir).plan[0]).toEqual({ id: 'p1', entry: join(pkgDir, 'custom-entry.ts') });
  });

  it('无 harness 字段 → 约定目录 extensions/index.ts 回退 → 包根 index.ts 兜底', () => {
    const dataDir = makeDataDir();
    // 仅有约定目录
    const pkgA = join(dataDir, 'plugins', 'node_modules', 'pkg-a');
    mkdirSync(join(pkgA, 'extensions'), { recursive: true });
    writeEntryFile(join(pkgA, 'extensions'), 'index.ts');
    expect(resolvePluginEntry('pkg-a', dataDir)).toBe(join(pkgA, 'extensions', 'index.ts'));

    // 约定目录也无、包根 index.ts 在
    const pkgB = join(dataDir, 'plugins', 'node_modules', 'pkg-b');
    mkdirSync(pkgB, { recursive: true });
    writeEntryFile(pkgB, 'index.js');
    expect(resolvePluginEntry('pkg-b', dataDir)).toBe(join(pkgB, 'index.js'));

    // 全无 → undefined（→ unresolved 行进启动断言——加载器永不自动安装）
    expect(resolvePluginEntry('pkg-c', dataDir)).toBeUndefined();
  });

  it('未安装裸名行：unresolved 计划行，信息明示永不自动安装', () => {
    const dataDir = makeDataDir();
    writeOverlay(dataDir, '  - id: missing\n    plugin: absent-pkg\n');
    const report = loadComposition(dataDir);
    expect(report.plan).toHaveLength(1);
    expect(report.plan[0]!.id).toBe('missing');
    expect(report.plan[0]!.unresolved).toContain('永不自动安装');
    expect(report.plan[0]!.entry).toBeUndefined();
  });
});

/* ---------------- 目录服务与插件管理服务 ---------------- */

describe('目录服务（ctx.paths）与插件管理服务（ctx.plugins）', () => {
  it('pluginDataDir 首取即建目录、幂等缓存；dataDir 返回根', () => {
    const dataDir = makeDataDir();
    const paths = createPathsService(dataDir);
    expect(paths.dataDir()).toBe(dataDir);
    const first = paths.pluginDataDir('memory');
    expect(first).toBe(join(dataDir, 'plugins', 'memory'));
    // 首取已建——目录真实存在
    expect(existsSync(first)).toBe(true);
    // 再取同路径（幂等，不重复 mkdir 抛错）
    expect(paths.pluginDataDir('memory')).toBe(first);
  });

  it('plugins.list：装载结果映射 + planned 兜底，行序 = 组合树行序', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(
      dataDir,
      `  - id: ok\n    plugin: ${entry}\n` + '  - id: dormant\n    plugin: p\n    disabled: true\n',
    );
    const composition = loadComposition(dataDir);
    // 装载结果最小面（真装载行为在 loader.test——此处只验映射）
    const load: PluginLoadResult = {
      activated: [{ id: 'ok', name: 'stub' }],
      failed: [],
      skipped: [{ id: 'dormant', reason: 'disabled' }],
    };
    const plugins = createPluginsService(composition, load);
    expect(plugins.list()).toEqual([
      { id: 'ok', status: 'activated', name: 'stub' },
      { id: 'dormant', status: 'skipped', reason: 'disabled' },
    ]);
    // 装载前视角（如 dump-config 纯合成路径）——planned 兜底
    const planned = createPluginsService(composition, { activated: [], failed: [], skipped: [] });
    expect(planned.list().map((row) => [row.id, row.status])).toEqual([
      ['ok', 'planned'],
      ['dormant', 'planned'],
    ]);
  });
});

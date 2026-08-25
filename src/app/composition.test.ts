/**
 * L5 app — 组合树测试（overlay 装载/拒绝式校验/合成/入口解析/目录与插件服务）。
 *
 * 全部用真实临时目录 + 真实 overlay.yaml（「装什么/在哪」的纯合成面——无 LLM
 * 无进程交互，不需要 mock 层）；入口解析覆盖路径直引、装机子树裸名、
 * harness 字段与约定目录回退、禁用行不解析（挂载休眠）。
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError, COMPOSITION_ROW_INVALID } from '../contracts/errors.js';
import type { PluginLoadResult } from '../contracts/plugin.js';
import { loadComposition, resolvePluginEntry } from './composition.js';
import { createPathsService, saveOverlayRows, toggleOverlayRow, upsertOverlayPluginRef } from './composition.js';

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

/* ---------------- 官方默认层隔离 ---------------- */

/** 官方默认层行 id 集（chat 首行 + memory 次行 + subagent 第三行 + goal 第四行 + scheduler 第五行 + mcp 第六行——契约篇 §5.1/§5.4/§6.6） */
const DEFAULT_LAYER_IDS = new Set(['chat', 'memory', 'subagent', 'goal', 'scheduler', 'mcp']);

/**
 * 装载并滤除官方默认层行：overlay/入口解析语义测试只断言用户层（官方行进
 * dedicated 测试——两关注点不混断言）。无注册表调用 → 官方 builtin: 行为
 * unresolved（对用户层断言无影响）。
 */
function loadUserComposition(dataDir: string): { rows: unknown[]; plan: unknown[] } {
  const report = loadComposition(dataDir);
  return {
    rows: report.rows.filter((row) => !DEFAULT_LAYER_IDS.has(row.id)),
    plan: report.plan.filter((row) => !DEFAULT_LAYER_IDS.has(row.id)),
  };
}

/* ---------------- overlay 装载与拒绝式校验 ---------------- */

describe('overlay 装载与拒绝式校验', () => {
  it('overlay 不存在 = 空 overlay：零配置首启合法（用户层空树；官方默认层照常打底）', () => {
    const dataDir = makeDataDir();
    const report = loadComposition(dataDir);
    // 官方默认层六行：chat 首行（应用面第一纵切——对话是应用）+ memory 次行 +
    // subagent 第三行 + goal 第四行 + scheduler 第五行 + mcp 第六行（客户端桥
    // 第一刀——契约篇 §5.1/§5.4/§6.6）——无注册表解析 = unresolved（诊断诚实）
    expect(report.rows).toEqual([
      { id: 'chat', plugin: 'builtin:chat' },
      { id: 'memory', plugin: 'builtin:memory' },
      { id: 'subagent', plugin: 'builtin:subagent' },
      { id: 'goal', plugin: 'builtin:goal' },
      { id: 'scheduler', plugin: 'builtin:scheduler' },
      { id: 'mcp', plugin: 'builtin:mcp' },
    ]);
    expect(report.plan).toHaveLength(6);
    expect(report.plan[0]!.id).toBe('chat');
    expect(report.plan[0]!.unresolved).toContain('保留前缀');
    expect(report.plan[1]!.id).toBe('memory');
    expect(report.plan[1]!.unresolved).toContain('保留前缀');
    expect(report.plan[2]!.id).toBe('subagent');
    expect(report.plan[2]!.unresolved).toContain('保留前缀');
    expect(report.plan[3]!.id).toBe('goal');
    expect(report.plan[3]!.unresolved).toContain('保留前缀');
    expect(report.plan[4]!.id).toBe('scheduler');
    expect(report.plan[4]!.unresolved).toContain('保留前缀');
    expect(report.plan[5]!.id).toBe('mcp');
    expect(report.plan[5]!.unresolved).toContain('保留前缀');
    // 用户层为空
    expect(loadUserComposition(dataDir)).toEqual({ rows: [], plan: [] });
  });

  it('insert 行带路径引用：行进树、入口解析为该文件绝对路径', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: local\n    plugin: ${entry}\n`);
    const report = loadUserComposition(dataDir);
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
    const report = loadUserComposition(dataDir);
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
    const report = loadUserComposition(dataDir);
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
    expect(loadUserComposition(dataDir).plan[0]).toEqual({ id: 'p1', entry: join(pkgDir, 'custom-entry.ts') });
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
    const report = loadUserComposition(dataDir);
    expect(report.plan).toHaveLength(1);
    expect((report.plan[0] as { id: string }).id).toBe('missing');
    expect((report.plan[0] as { unresolved?: string }).unresolved).toContain('永不自动安装');
    expect((report.plan[0] as { entry?: string }).entry).toBeUndefined();
  });
});

/* ---------------- 目录服务与插件管理服务 ---------------- */

describe('目录服务（ctx.paths）', () => {
  it('pluginDataDir 首取即建目录、幂等缓存；dataDir 返回根', () => {
    const dataDir = makeDataDir();
    const paths = createPathsService(dataDir, process.cwd());
    expect(paths.dataDir()).toBe(dataDir);
    const first = paths.pluginDataDir('memory');
    expect(first).toBe(join(dataDir, 'plugins', 'memory'));
    // 首取已建——目录真实存在
    expect(existsSync(first)).toBe(true);
    // 再取同路径（幂等，不重复 mkdir 抛错）
    expect(paths.pluginDataDir('memory')).toBe(first);
  });

  it('workspaceRoot() = canonical 工作区根（git 仓库内回 git 根；永不 undefined）', () => {
    const dataDir = makeDataDir();
    // 测试进程 cwd 在 berry git 仓库内——canonical 推导必回仓库根（含本仓库真实路径断言）
    const paths = createPathsService(dataDir, process.cwd());
    const root = paths.workspaceRoot();
    expect(typeof root).toBe('string');
    expect(root.length).toBeGreaterThan(0);
    expect(existsSync(join(root, '.git'))).toBe(true);
    // 非 git 目录回退 resolved cwd（兜底口径——永不 undefined）
    const fallback = createPathsService(dataDir, dataDir);
    expect(fallback.workspaceRoot()).toBe(resolve(dataDir));
  });
});

/* ---------------- overlay 写回（install/toggle 持久化半边，§6.3 往返硬规则） ---------------- */

describe('overlay 写回：saveOverlayRows / toggleOverlayRow / upsertOverlayPluginRef', () => {
  it('往返零字段损失：save→load 深相等（parse→stringify→parse 幂等，含 config 嵌套值）', () => {
    const dataDir = makeDataDir();
    const rows = [
      { id: 'bare-pkg', plugin: 'some-package' },
      {
        id: 'with-config',
        plugin: './local',
        config: { port: 8080, label: '你好: world', nested: { list: [1, 'two', true] } },
      },
      { id: 'gated', plugin: 'x', disabled: 'win32' },
      { id: 'off', plugin: 'y', disabled: true },
    ];
    saveOverlayRows(dataDir, rows);
    // 装载面（validateRow 拒绝式）原样读回——四行全字段无损失
    const report = loadUserComposition(dataDir);
    expect(report.rows).toEqual(rows);
    // 二次往返（save(load(save))) 仍幂等
    saveOverlayRows(dataDir, [...(report.rows as never[])]);
    expect(loadUserComposition(dataDir).rows).toEqual(rows);
  });

  it('空行集写回：合法空 overlay（rows: []），用户层为空树（官方层照常打底）', () => {
    const dataDir = makeDataDir();
    saveOverlayRows(dataDir, []);
    expect(loadUserComposition(dataDir).rows).toEqual([]);
  });

  it('toggle 翻转：启用→禁用保留 plugin/config；禁用→启用删键、纯禁用行整行移除', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(
      dataDir,
      `  - id: live\n    plugin: ${entry}\n` + '  - id: pure-off\n    plugin: p\n    disabled: true\n',
    );
    // 现禁用行（pure-off，带 plugin）→ 启用：删键保留行
    expect(toggleOverlayRow(dataDir, 'pure-off')).toBe(false);
    expect(loadUserComposition(dataDir).rows).toEqual([
      { id: 'live', plugin: entry },
      { id: 'pure-off', plugin: 'p' },
    ]);
    // 再翻 → 禁用：保留 plugin 只置 disabled
    expect(toggleOverlayRow(dataDir, 'pure-off')).toBe(true);
    expect(loadUserComposition(dataDir).rows).toEqual([
      { id: 'live', plugin: entry },
      { id: 'pure-off', plugin: 'p', disabled: true },
    ]);
    // live 行不带 plugin 字段的纯禁用路径：先手工写一行只含 id+disabled 的行
    writeOverlay(dataDir, `  - id: live\n    plugin: ${entry}\n` + '  - id: flag-only\n    disabled: true\n');
    // 等等——flag-only 是 insert 行但无 plugin：装载面本就拒绝；写回面删键后应整行移除
    expect(toggleOverlayRow(dataDir, 'live')).toBe(true); // live → 禁用（保留 plugin）
    expect(toggleOverlayRow(dataDir, 'live')).toBe(false); // 再启回（保留 plugin）
    expect(toggleOverlayRow(dataDir, 'flag-only')).toBe(false); // 纯禁用行 → 启用 = 整行移除
    expect(loadUserComposition(dataDir).rows).toEqual([{ id: 'live', plugin: entry }]);
  });

  it('toggle 未知行 id：COMPOSITION_ROW_INVALID 即时即响（不静默写一条无人认领的行）', () => {
    const dataDir = makeDataDir();
    try {
      toggleOverlayRow(dataDir, 'ghost');
      expect.unreachable('未知 id 应抛');
    } catch (err) {
      expect((err as AppError).code).toBe(COMPOSITION_ROW_INVALID);
    }
  });

  it('upsertOverlayPluginRef：insert 自带 plugin；重装只换 plugin 引用（config/disabled 状态不动）', () => {
    const dataDir = makeDataDir();
    upsertOverlayPluginRef(dataDir, 'fresh', 'some-package');
    expect(loadUserComposition(dataDir).rows).toEqual([{ id: 'fresh', plugin: 'some-package' }]);
    // 已有行带 config/disabled——重装只替换 plugin 引用，启停与配置保留
    writeOverlay(
      dataDir,
      '  - id: fresh\n    plugin: some-package\n' +
        '  - id: pkg\n    plugin: old-name\n    config: { k: v }\n    disabled: true\n',
    );
    upsertOverlayPluginRef(dataDir, 'pkg', 'new-name');
    expect(loadUserComposition(dataDir).rows).toEqual([
      { id: 'fresh', plugin: 'some-package' },
      { id: 'pkg', plugin: 'new-name', config: { k: 'v' }, disabled: true },
    ]);
  });
});

/* ---------------- builtin: 前缀解析（契约篇 §6.1，纵切五） ---------------- */

describe('builtin: 保留前缀解析', () => {
  /** 测试替身官方件（形状合法即可——合成面不调 apply） */
  const stubBuiltin = { name: 'memory-stub', apply: async () => {} };

  it('注册表命中：计划行带 builtin 模块引用与行 config（不经 jiti）', () => {
    const dataDir = makeDataDir();
    writeOverlay(dataDir, '  - id: memory\n    config: { recallTopK: 5 }\n');
    // 默认层六键全给（chat/subagent/goal/scheduler/mcp 行同解析——不带 config 的纯净形态对照）
    const stubChat = { name: 'chat-stub', apply: async () => {} };
    const stubSubagent = { name: 'subagent-stub', apply: async () => {} };
    const stubGoal = { name: 'goal-stub', apply: async () => {} };
    const stubScheduler = { name: 'scheduler-stub', apply: async () => {} };
    const stubMcp = { name: 'mcp-stub', apply: async () => {} };
    const report = loadComposition(dataDir, {
      'builtin:chat': stubChat,
      'builtin:memory': stubBuiltin,
      'builtin:subagent': stubSubagent,
      'builtin:goal': stubGoal,
      'builtin:scheduler': stubScheduler,
      'builtin:mcp': stubMcp,
    });
    expect(report.rows).toEqual([
      { id: 'chat', plugin: 'builtin:chat' },
      { id: 'memory', plugin: 'builtin:memory', config: { recallTopK: 5 } },
      { id: 'subagent', plugin: 'builtin:subagent' },
      { id: 'goal', plugin: 'builtin:goal' },
      { id: 'scheduler', plugin: 'builtin:scheduler' },
      { id: 'mcp', plugin: 'builtin:mcp' },
    ]);
    expect(report.plan).toEqual([
      { id: 'chat', builtin: stubChat },
      { id: 'memory', builtin: stubBuiltin, config: { recallTopK: 5 } },
      { id: 'subagent', builtin: stubSubagent },
      { id: 'goal', builtin: stubGoal },
      { id: 'scheduler', builtin: stubScheduler },
      { id: 'mcp', builtin: stubMcp },
    ]);
  });

  it('注册表未命中：unresolved 响亮——保留前缀仅官方随包件可用（overlay 不能伪装）', () => {
    const dataDir = makeDataDir();
    const report = loadComposition(dataDir, {});
    expect(report.plan[0]!.unresolved).toContain('不在宿主注册表');
    expect(report.plan[0]!.unresolved).toContain('保留前缀');
  });

  it('overlay 替换引用：memory 行 plugin 换本地路径 → 走文件插件解析（builtin 语义可换源）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: memory\n    plugin: ${entry}\n`);
    const report = loadComposition(dataDir, { 'builtin:memory': stubBuiltin });
    // chat 行（首行）此注册表未给 → unresolved 占 plan[0]；memory 行在 plan[1]
    expect(report.plan[1]).toEqual({ id: 'memory', entry });
  });

  it('overlay 禁用 memory 行：非 fixed 行真·可卸（skip，不要求注册表命中）', () => {
    const dataDir = makeDataDir();
    writeOverlay(dataDir, '  - id: memory\n    disabled: true\n');
    const report = loadComposition(dataDir, {});
    expect(report.plan[1]).toEqual({ id: 'memory', skip: 'disabled' });
  });
});

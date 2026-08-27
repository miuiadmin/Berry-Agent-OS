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
import {
  assertRing1Required,
  diffRing1Rows,
  RING1_REQUIRED_ROW_IDS,
  createPathsService,
  loadComposition,
  pluginDataDirOf,
  resolvePluginEntry,
  RESERVED_SUBTREE_NAMES,
  loadOverlayRows,
  saveOverlayRows,
  toggleOverlayRow,
  upsertOverlayPluginRef,
  writeOverlayRowConfig,
} from './composition.js';

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

/** 官方默认层行 id 集（chat 首行 + memory 次行 + subagent 第三行 + goal 第四行 + scheduler 第五行 + mcp 第六行 + tools 第七行〔Ring 1 行树化起算〕 + web 第八行 + compaction 第九行 + admin 第十行——契约篇 §5.1/§5.4/§6.6/§1.5.2/内核边界篇席 20/§3.4） */
const DEFAULT_LAYER_IDS = new Set([
  'chat',
  'memory',
  'subagent',
  'goal',
  'scheduler',
  'mcp',
  'tools',
  'web',
  'compaction',
  'admin',
]);

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
    // 官方默认层十行：chat 首行（应用面第一纵切——对话是应用）+ memory 次行 +
    // subagent 第三行 + goal 第四行 + scheduler 第五行 + mcp 第六行（客户端桥
    // 第一刀）+ tools 第七行（Ring 1 行树化起算行——契约篇 §5.1 节奏表）
    // + web 第八行（web 刀一批三件——契约篇 §1.5.2）+ compaction 第九行
    // + admin 第十行（平台管理面第一刀——契约篇 §3.4）
    // ——无注册表解析 = unresolved（诊断诚实）
    expect(report.rows).toEqual([
      { id: 'chat', plugin: 'builtin:chat' },
      { id: 'memory', plugin: 'builtin:memory' },
      { id: 'subagent', plugin: 'builtin:subagent' },
      { id: 'goal', plugin: 'builtin:goal' },
      { id: 'scheduler', plugin: 'builtin:scheduler' },
      { id: 'mcp', plugin: 'builtin:mcp' },
      { id: 'tools', plugin: 'builtin:tools' },
      { id: 'web', plugin: 'builtin:web' },
      { id: 'compaction', plugin: 'builtin:compaction' },
      { id: 'admin', plugin: 'builtin:admin' },
    ]);
    expect(report.plan).toHaveLength(10);
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
    expect(report.plan[6]!.id).toBe('tools');
    expect(report.plan[6]!.unresolved).toContain('保留前缀');
    // 用户层为空
    expect(loadUserComposition(dataDir)).toEqual({ rows: [], plan: [] });
  });

  it('insert 行带路径引用：行进树、入口解析为该文件绝对路径', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: local\n    plugin: ${entry}\n`);
    const report = loadUserComposition(dataDir);
    expect(report.rows).toEqual([{ id: 'local', plugin: entry }]);
    // plugin 引用透传（第三纵切 join 键：应用内存预算按行命中 worker 行）
    expect(report.plan).toEqual([{ id: 'local', plugin: entry, entry }]);
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

/* ---------------- runtime 运行域字段（第二十七批刀二 K3-b1，契约篇 §1.7） ---------------- */

describe('runtime 运行域字段', () => {
  it('insert 行 runtime: worker：进树且计划行透传（声明面零变化，执行域换轨）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: demo\n    plugin: ${entry}\n    runtime: worker\n`);
    const report = loadUserComposition(dataDir);
    expect(report.rows).toEqual([{ id: 'demo', plugin: entry, runtime: 'worker' }]);
    expect(report.plan).toEqual([{ id: 'demo', plugin: entry, entry, runtime: 'worker' }]);
  });

  it('runtime 显式 main：与缺省同义（合法值域之一，不制造第二形态）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: demo\n    plugin: ${entry}\n    runtime: main\n`);
    const report = loadUserComposition(dataDir);
    expect(report.plan).toEqual([{ id: 'demo', plugin: entry, entry, runtime: 'main' }]);
  });

  it('值域拒绝式：external（案三预留词未开闸）与非法类型一律 COMPOSITION_ROW_INVALID', () => {
    const reserved = makeDataDir();
    const entry = writeEntryFile(reserved);
    writeOverlay(reserved, `  - id: demo\n    plugin: ${entry}\n    runtime: external\n`);
    expect(() => loadComposition(reserved)).toThrowError(/runtime 必须是 'main' 或 'worker'/);

    const badType = makeDataDir();
    const entry2 = writeEntryFile(badType);
    writeOverlay(badType, `  - id: demo\n    plugin: ${entry2}\n    runtime: 3\n`);
    expect(() => loadComposition(badType)).toThrowError(/runtime 必须是 'main' 或 'worker'/);
  });

  it('builtin 官方行声明 worker：机器执法即响（官方随包件恒 main 域，§1.7）', () => {
    const dataDir = makeDataDir();
    // 替换官方层 memory 行只改 runtime——字段合法但 builtin 执法面拦截
    // （注册表须命中才走到执法点：unresolved 行在拦截之前分流）
    writeOverlay(dataDir, '  - id: memory\n    runtime: worker\n');
    const officialStub = { name: 'memory-stub', apply: async () => {} };
    try {
      loadComposition(dataDir, { 'builtin:memory': officialStub });
      expect.unreachable('builtin 行声明 worker 必须即响');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(COMPOSITION_ROW_INVALID);
      expect((err as AppError).message).toContain('builtin 官方件不可声明 runtime: worker');
    }
  });

  it('写回往返零字段损失：runtime 随行序列化（parse→stringify→parse 幂等）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    saveOverlayRows(dataDir, [
      { id: 'demo', plugin: entry, runtime: 'worker' },
      { id: 'plain', plugin: entry },
    ]);
    const reloaded = loadOverlayRows(dataDir);
    expect(reloaded).toEqual([
      { id: 'demo', plugin: entry, runtime: 'worker' },
      { id: 'plain', plugin: entry },
    ]);
  });

  it('toggle 禁用→启用：runtime 字段存续（纯 runtime 替换行不误删）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    saveOverlayRows(dataDir, [{ id: 'demo', plugin: entry, runtime: 'worker', config: { k: 1 } }]);
    toggleOverlayRow(dataDir, 'demo'); // → 禁用
    toggleOverlayRow(dataDir, 'demo'); // → 启用（删 disabled 键，runtime/config 存续）
    const row = loadOverlayRows(dataDir).find((r) => r.id === 'demo');
    expect(row).toEqual({ id: 'demo', plugin: entry, runtime: 'worker', config: { k: 1 } });
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
      { id: 'gated', skip: 'platform' }, // 命中当前平台——不解析入口（skip 行不带 plugin）
      { id: 'ungated', plugin: entry, entry }, // 他平台门控不生效——照常激活
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
    expect(loadUserComposition(dataDir).plan[0]).toEqual({
      id: 'p1',
      plugin: 'fake-pkg',
      entry: join(pkgDir, 'custom-entry.ts'),
    });
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
    // 未解析行也带 plugin 引用（归因完整——join 键在场上，无消费面而已）
    expect((report.plan[0] as { plugin?: string }).plugin).toBe('absent-pkg');
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

  it('数据根保留名闸收口 pluginDataDirOf 单点：撞装机子树名即拒（公共面/收割写/删根同径）', () => {
    const dataDir = makeDataDir();
    const paths = createPathsService(dataDir, process.cwd());
    // 保留名对逐名验：原语直接取址抛 COMPOSITION_ROW_INVALID（布局闸单点）
    for (const reserved of RESERVED_SUBTREE_NAMES) {
      let thrown: unknown;
      try {
        pluginDataDirOf(dataDir, reserved);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe(COMPOSITION_ROW_INVALID);
      // 公共面 ctx.paths.pluginDataDir 同闸（曾自复刻 join 零闸——复盘批收口的口子）
      expect(() => paths.pluginDataDir(reserved)).toThrow(AppError);
    }
    // 拒绝不落痕迹：撞名取址失败后不建任何目录（mkdir 前抛）
    expect(existsSync(join(dataDir, 'plugins', 'git'))).toBe(false);
    // 合法 id 原语面 = 纯路径拼接（不建目录——建目录是服务面首取职责）
    expect(pluginDataDirOf(dataDir, 'memory')).toBe(join(dataDir, 'plugins', 'memory'));
    expect(existsSync(join(dataDir, 'plugins', 'memory'))).toBe(false);
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
    // 默认层十键全给（chat/subagent/goal/scheduler/mcp/tools/web/admin 行同解析——不带 config 的纯净形态对照）
    const stubChat = { name: 'chat-stub', apply: async () => {} };
    const stubSubagent = { name: 'subagent-stub', apply: async () => {} };
    const stubGoal = { name: 'goal-stub', apply: async () => {} };
    const stubScheduler = { name: 'scheduler-stub', apply: async () => {} };
    const stubMcp = { name: 'mcp-stub', apply: async () => {} };
    const stubTools = { name: 'tools-stub', apply: async () => {} };
    const stubWeb = { name: 'web-stub', apply: async () => {} };
    const stubCompaction = { name: 'compaction-stub', apply: async () => {} };
    const stubAdmin = { name: 'admin-stub', apply: async () => {} };
    const report = loadComposition(dataDir, {
      'builtin:chat': stubChat,
      'builtin:memory': stubBuiltin,
      'builtin:subagent': stubSubagent,
      'builtin:goal': stubGoal,
      'builtin:scheduler': stubScheduler,
      'builtin:mcp': stubMcp,
      'builtin:tools': stubTools,
      'builtin:web': stubWeb,
      'builtin:compaction': stubCompaction,
      'builtin:admin': stubAdmin,
    });
    expect(report.rows).toEqual([
      { id: 'chat', plugin: 'builtin:chat' },
      { id: 'memory', plugin: 'builtin:memory', config: { recallTopK: 5 } },
      { id: 'subagent', plugin: 'builtin:subagent' },
      { id: 'goal', plugin: 'builtin:goal' },
      { id: 'scheduler', plugin: 'builtin:scheduler' },
      { id: 'mcp', plugin: 'builtin:mcp' },
      { id: 'tools', plugin: 'builtin:tools' },
      { id: 'web', plugin: 'builtin:web' },
      { id: 'compaction', plugin: 'builtin:compaction' },
      { id: 'admin', plugin: 'builtin:admin' },
    ]);
    expect(report.plan).toEqual([
      { id: 'chat', plugin: 'builtin:chat', builtin: stubChat },
      { id: 'memory', plugin: 'builtin:memory', builtin: stubBuiltin, config: { recallTopK: 5 } },
      { id: 'subagent', plugin: 'builtin:subagent', builtin: stubSubagent },
      { id: 'goal', plugin: 'builtin:goal', builtin: stubGoal },
      { id: 'scheduler', plugin: 'builtin:scheduler', builtin: stubScheduler },
      { id: 'mcp', plugin: 'builtin:mcp', builtin: stubMcp },
      { id: 'tools', plugin: 'builtin:tools', builtin: stubTools },
      { id: 'web', plugin: 'builtin:web', builtin: stubWeb },
      { id: 'compaction', plugin: 'builtin:compaction', builtin: stubCompaction },
      { id: 'admin', plugin: 'builtin:admin', builtin: stubAdmin },
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
    expect(report.plan[1]).toEqual({ id: 'memory', plugin: entry, entry });
  });

  it('overlay 禁用 memory 行：非 fixed 行真·可卸（skip，不要求注册表命中）', () => {
    const dataDir = makeDataDir();
    writeOverlay(dataDir, '  - id: memory\n    disabled: true\n');
    const report = loadComposition(dataDir, {});
    expect(report.plan[1]).toEqual({ id: 'memory', skip: 'disabled' });
  });
});

/* ---------------- Ring 1 必备行断言与差异（行树化批，契约篇 §5.1 节奏表） ---------------- */

describe('Ring 1 必备行：assertRing1Required / diffRing1Rows', () => {
  /** 全八行 stub 注册表（健康形态——行行可解析） */
  const stubRegistry = () => ({
    'builtin:chat': { name: 'chat-stub', apply: async () => {} },
    'builtin:memory': { name: 'memory-stub', apply: async () => {} },
    'builtin:subagent': { name: 'subagent-stub', apply: async () => {} },
    'builtin:goal': { name: 'goal-stub', apply: async () => {} },
    'builtin:scheduler': { name: 'scheduler-stub', apply: async () => {} },
    'builtin:mcp': { name: 'mcp-stub', apply: async () => {} },
    'builtin:tools': { name: 'tools-stub', apply: async () => {} },
    'builtin:web': { name: 'web-stub', apply: async () => {} },
    'builtin:compaction': { name: 'compaction-stub', apply: async () => {} },
  });

  it('起算清单：RING1_REQUIRED_ROW_IDS = [tools]（后续行树化纵切逐行累加）', () => {
    expect(RING1_REQUIRED_ROW_IDS).toEqual(['tools']);
  });

  it('健康树：全行可解析 → 零违规', () => {
    const dataDir = makeDataDir();
    expect(assertRing1Required(loadComposition(dataDir, stubRegistry()))).toEqual([]);
  });

  it('overlay 禁用 tools 行：kind=disabled 违规（Ring 1 行不可卸——换实现走引用替换）', () => {
    const dataDir = makeDataDir();
    writeOverlay(dataDir, '  - id: tools\n    disabled: true\n');
    const violations = assertRing1Required(loadComposition(dataDir, stubRegistry()));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ id: 'tools', kind: 'disabled' });
    expect(violations[0]!.detail).toContain('替换行引用');
  });

  it('平台门控禁用 tools 行：kind=platform 违规（Ring 1 行无平台豁免语义）', () => {
    const dataDir = makeDataDir();
    writeOverlay(dataDir, `  - id: tools\n    disabled: ${process.platform}\n`);
    const violations = assertRing1Required(loadComposition(dataDir, stubRegistry()));
    expect(violations[0]).toMatchObject({ id: 'tools', kind: 'platform' });
  });

  it('引用解析失败：kind=unresolved 违规（注册表未命中也是拒启事由）', () => {
    const dataDir = makeDataDir();
    // 空注册表：builtin:tools 不在 → tools 行 unresolved（第一类断言看不见、第二类拒启）
    const violations = assertRing1Required(loadComposition(dataDir, {}));
    expect(violations[0]).toMatchObject({ id: 'tools', kind: 'unresolved' });
  });

  it('行缺失：kind=missing 违规（官方默认层结构性缺失——合成面正常不可达，断言函数单点兜底）', () => {
    // 直接构造缺行报告（loadComposition 必含默认层七行——missing 只在默认层
    // 定义漂移时出现；纯函数面单测锁死该分支的拒启事实）
    const report = loadComposition(makeDataDir(), stubRegistry());
    const mutilated = {
      rows: report.rows.filter((row) => row.id !== 'tools'),
      plan: report.plan.filter((row) => row.id !== 'tools'),
    };
    const violations = assertRing1Required(mutilated);
    expect(violations[0]).toMatchObject({ id: 'tools', kind: 'missing' });
    expect(violations[0]!.detail).toContain('结构性错误');
  });

  it('diffRing1Rows：无变化 → []；行 config 变化 → [tools]（/reload 报告「需重启生效」）', () => {
    const dataDir = makeDataDir();
    const registry = stubRegistry();
    const before = loadComposition(dataDir, registry);
    expect(diffRing1Rows(before, loadComposition(dataDir, registry))).toEqual([]);
    // overlay 给 tools 行加 config——合成字段变化 → 该行需重启生效
    writeOverlay(dataDir, '  - id: tools\n    config: { maxBytes: 1 }\n');
    expect(diffRing1Rows(before, loadComposition(dataDir, registry))).toEqual(['tools']);
  });
});

/* ---------------- 行 app 键：挂载目标两档（D1 清单投影批，契约篇 §5.1） ---------------- */

describe('行 app 键：挂载目标两档执法', () => {
  /** 断言 loadComposition 抛 COMPOSITION_ROW_INVALID 且 message 含关键词 */
  function expectRowInvalid(dataDir: string, knownAppIds: ReadonlySet<string>, keyword: string): void {
    try {
      loadComposition(dataDir, {}, knownAppIds);
      expect.unreachable('携带非法 app 键的行应拒绝式即响');
    } catch (err) {
      expect((err as AppError).code).toBe(COMPOSITION_ROW_INVALID);
      expect((err as AppError).message).toContain(keyword);
    }
  }

  it('validateRow 类型拒绝式：app 非字符串 / 空串即 COMPOSITION_ROW_INVALID（不误读）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: bad-type\n    plugin: ${entry}\n    app: 42\n`);
    expectRowInvalid(dataDir, new Set(), 'app 必须是非空字符串');
    writeOverlay(dataDir, `  - id: bad-empty\n    plugin: ${entry}\n    app: ''\n`);
    expectRowInvalid(dataDir, new Set(), 'app 必须是非空字符串');
  });

  it('触发①：未知应用 id 即拒——缺省空集 = 拒绝式缺省（裸调不传清单集，任何 app 行都过不了）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: thing\n    plugin: ${entry}\n    app: chat\n`);
    // 不传第三参（缺省空集）：app 恒未知——测试面直接裸调即测「未知应用」路径
    expectRowInvalid(dataDir, new Set(), '未知应用 id「chat」');
    // 在册集不含目标 id：同样触发①（message 披露在册集——自助排错）
    expectRowInvalid(dataDir, new Set(['hermes']), '未知应用 id「chat」');
  });

  it('触发③：Ring 1 必备行带 app 即拒（tools 行——换实现可、换母体不可）', () => {
    const dataDir = makeDataDir();
    // 省略 plugin = 沿用官方层 builtin:tools 引用；chat 在册使触发①先过、③后响
    writeOverlay(dataDir, '  - id: tools\n    app: chat\n');
    expectRowInvalid(dataDir, new Set(['chat']), 'Ring 1 必备行不可携带 app');
  });

  it('触发④：官方引用行带 app 即拒——显式 builtin: 引用与省略沿用官方层两形态同判', () => {
    const dataDir = makeDataDir();
    // 形态一：insert 行显式 builtin: 引用（官方件身份不可借 app 改母体）
    writeOverlay(dataDir, '  - id: fake-official\n    plugin: builtin:web\n    app: chat\n');
    expectRowInvalid(dataDir, new Set(['chat']), '官方件行（builtin:web）不可携带 app');
    // 形态二：overlay 替换官方层行省略 plugin——合成后沿用 builtin:memory，判源
    // 不需特判「省略」形态（合成产物已带前缀）
    writeOverlay(dataDir, '  - id: memory\n    app: chat\n');
    expectRowInvalid(dataDir, new Set(['chat']), '官方件行（builtin:memory）不可携带 app');
  });

  it('合法 app 行：在册 id + 第三方引用 → 行进树携带 app（触发②〔第三方行缺省挂系统拒〕随 D2 装机两态同批落）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: my-thing\n    plugin: ${entry}\n    app: chat\n`);
    const report = loadComposition(dataDir, {}, new Set(['chat']));
    const row = report.rows.find((r) => r.id === 'my-thing');
    expect(row).toMatchObject({ id: 'my-thing', plugin: entry, app: 'chat' });
    // 计划行正常解析（app 不影响装载计划——执法在合成期，过了即常规行）
    expect(report.plan.find((r) => r.id === 'my-thing')?.entry).toBe(entry);
  });

  it('disabled 行同样执法：潜伏配置预先即拒（不留「toggle 启用才炸」陷阱）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: off-app\n    plugin: ${entry}\n    app: ghost\n    disabled: true\n`);
    expectRowInvalid(dataDir, new Set(['chat']), '未知应用 id「ghost」');
  });

  it('合成语义：app 字段级后写胜出（省略沿用前值、给定即替换）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    const known = new Set(['chat', 'hermes']);
    // 同 id 两行顺序应用：第二行省略 app → 沿用第一行的 chat
    writeOverlay(dataDir, `  - id: thing\n    plugin: ${entry}\n    app: chat\n  - id: thing\n    plugin: ${entry}\n`);
    expect(loadComposition(dataDir, {}, known).rows.find((r) => r.id === 'thing')?.app).toBe('chat');
    // 第二行给定 app → 替换为 hermes
    writeOverlay(
      dataDir,
      `  - id: thing\n    plugin: ${entry}\n    app: chat\n  - id: thing\n    plugin: ${entry}\n    app: hermes\n`,
    );
    expect(loadComposition(dataDir, {}, known).rows.find((r) => r.id === 'thing')?.app).toBe('hermes');
  });

  it('写回往返零字段损失：app 随行序列化（parse→stringify→parse 幂等）', () => {
    const dataDir = makeDataDir();
    const rows = [
      { id: 'sys-row', plugin: 'some-package' },
      { id: 'app-row', plugin: './local', app: 'chat' },
    ];
    saveOverlayRows(dataDir, rows);
    // 装载面已知 chat 在册——深相等往返（app 无损失）
    expect(loadOverlayRows(dataDir)).toEqual(rows);
  });

  it('toggle 禁用→启用：app 字段存续（带 plugin 的 app 行删 disabled 键后 app 保留）', () => {
    const dataDir = makeDataDir();
    writeOverlay(dataDir, '  - id: approw\n    plugin: p\n    app: chat\n    disabled: true\n');
    expect(toggleOverlayRow(dataDir, 'approw')).toBe(false);
    expect(loadOverlayRows(dataDir)).toEqual([{ id: 'approw', plugin: 'p', app: 'chat' }]);
  });

  it('toggle 纯 {id, app} 残留行整行移除：无 plugin 的 app 行不可能是合法行（残留即装载地雷）', () => {
    const dataDir = makeDataDir();
    writeOverlay(dataDir, '  - id: appres\n    app: chat\n    disabled: true\n');
    expect(toggleOverlayRow(dataDir, 'appres')).toBe(false);
    expect(loadOverlayRows(dataDir)).toEqual([]);
  });

  it('configure 删 config 键：app 存续于带 plugin 行；{id, app} 残留行整行移除（同 toggle 谓词）', () => {
    const dataDir = makeDataDir();
    writeOverlay(
      dataDir,
      '  - id: cfg-app\n    plugin: p\n    config: { a: 1 }\n    app: chat\n' +
        '  - id: cfg-res\n    config: { a: 1 }\n    app: chat\n',
    );
    writeOverlayRowConfig(dataDir, 'cfg-app', {});
    writeOverlayRowConfig(dataDir, 'cfg-res', {});
    expect(loadOverlayRows(dataDir)).toEqual([{ id: 'cfg-app', plugin: 'p', app: 'chat' }]);
  });
});

/**
 * L5 app — 组合树测试（overlay 装载/拒绝式校验/合成/入口解析/目录与应用服务）。
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
import type { AppPlanRow } from '../contracts/app.js';
import {
  assertRing1Required,
  diffRing1Rows,
  partitionPlan,
  RING1_REQUIRED_ROW_IDS,
  createPathsService,
  loadComposition,
  appDataDirOf,
  resolveAppEntry,
  RESERVED_SUBTREE_NAMES,
  loadOverlayRows,
  saveOverlayRows,
  toggleOverlayRow,
  insertOverlayRow,
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

/** 最小合法应用入口（合成测试只关心文件存在，内容不 import） */
function writeEntryFile(dir: string, file = 'entry.ts'): string {
  writeFileSync(join(dir, file), 'export const name = "stub";\nexport default async function apply() {}\n');
  return join(dir, file);
}

/* ---------------- 官方默认层隔离 ---------------- */

/** 官方默认层行 id 集（chat 首行 + memory 次行 + subagent 第三行 + goal 第四行 + scheduler 第五行 + mcp 第六行 + tools 第七行〔Ring 1 行树化起算〕 + web 第八行 + compaction 第九行 + admin 第十行 + checkpoint 第十一行 + lsp 第十二行 + channels 第十三行〔Ring 1 第二行树化〕 + webui 第十四行 + obs 第十五行 + browser 第十六行 + desktop 第十七行〔Ring 1 第三行树化——契约篇 §6.11 批 C〕 + assistant 第十八行〔系统助手 Ring 2——批 E 默认应答者〕——契约篇 §5.1/§5.4/§6.6/§1.5.2/内核边界篇席 20/§3.4/会话篇 §5.3/契约篇 §6.7/§6.8/价值主张篇） */
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
  'checkpoint',
  'lsp',
  'channels',
  'webui',
  'obs',
  'browser',
  'desktop',
  'assistant',
]);

/**
 * 测试面在册应用集（chat/hermes 两官方清单——触发①取值域）。D2 触发②开闸后
 * 第三方行必须带 app 键，语义测试（runtime/禁用/解析）统一挂 chat；空集缺省
 * 只在执法测试显式传（裸调不传清单集 = 任何 app 行都过不了触发①）。
 */
const KNOWN_APPS = new Set(['chat', 'hermes']);

/**
 * 装载并滤除官方默认层行：overlay/入口解析语义测试只断言用户层（官方行进
 * dedicated 测试——两关注点不混断言）。无注册表调用 → 官方 builtin: 行为
 * unresolved（对用户层断言无影响）。
 */
function loadUserComposition(
  dataDir: string,
  knownAppIds: ReadonlySet<string> = KNOWN_APPS,
): { rows: unknown[]; plan: unknown[] } {
  const report = loadComposition(dataDir, {}, knownAppIds);
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
    // 官方默认层十四行：chat 首行（应用面第一纵切——对话是应用）+ memory 次行 +
    // subagent 第三行 + goal 第四行 + scheduler 第五行 + mcp 第六行（客户端桥
    // 第一刀）+ tools 第七行（Ring 1 行树化起算行——契约篇 §5.1 节奏表）
    // + web 第八行（web 刀一批三件——契约篇 §1.5.2）+ compaction 第九行
    // + admin 第十行（平台管理面第一刀——契约篇 §3.4）
    // + checkpoint 第十一行（工作区快照·回退——会话篇 §5.3）
    // + lsp 第十二行（语言服务器件——契约篇 §6.7）
    // + channels 第十三行（Ring 1 第二行树化——契约篇 §6.8）
    // + webui 第十四行（Web 通道件——契约篇 §6.8）
    // + obs 第十五行（观测件——契约篇 §6.9）
    // + browser 第十六行（浏览器自动化件——契约篇 §6.10）
    // + desktop 第十七行（系统桌面服务面——Ring 1 第三行树化，契约篇 §6.11 批 C）
    // + assistant 第十八行（系统助手——Ring 2 纯清单行，批 E 桌面默认应答者）
    // ——无注册表解析 = unresolved（诊断诚实）
    expect(report.rows).toEqual([
      { id: 'chat', pkg: 'builtin:chat' },
      { id: 'memory', pkg: 'builtin:memory' },
      { id: 'subagent', pkg: 'builtin:subagent' },
      { id: 'goal', pkg: 'builtin:goal' },
      { id: 'scheduler', pkg: 'builtin:scheduler' },
      { id: 'mcp', pkg: 'builtin:mcp' },
      { id: 'tools', pkg: 'builtin:tools' },
      { id: 'web', pkg: 'builtin:web' },
      { id: 'compaction', pkg: 'builtin:compaction' },
      { id: 'admin', pkg: 'builtin:admin' },
      { id: 'checkpoint', pkg: 'builtin:checkpoint' },
      { id: 'lsp', pkg: 'builtin:lsp' },
      { id: 'channels', pkg: 'builtin:channels' },
      { id: 'webui', pkg: 'builtin:webui' },
      { id: 'obs', pkg: 'builtin:obs' },
      { id: 'browser', pkg: 'builtin:browser' },
      { id: 'desktop', pkg: 'builtin:desktop' },
      { id: 'assistant', pkg: 'builtin:assistant' },
    ]);
    expect(report.plan).toHaveLength(18);
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

  it('insert 行带路径引用：行进树、入口解析为该文件绝对路径（第三方行带 app 键）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: local\n    pkg: ${entry}\n    apps: [chat]\n`);
    const report = loadUserComposition(dataDir);
    expect(report.rows).toEqual([{ id: 'local', pkg: entry, apps: ['chat'] }]);
    // plugin 引用透传（第三纵切 join 键：应用内存预算按行命中 worker 行）+
    // apps 透传（D3 装载分面分区判据——计划行携带分区归属，单区 reload 依赖）
    expect(report.plan).toEqual([{ id: 'local', pkg: entry, entry, apps: ['chat'] }]);
  });

  it('未知字段 / 缺 id / 顶层形状错：COMPOSITION_ROW_INVALID 拒绝式（不误读）', () => {
    const unknownField = makeDataDir();
    writeOverlay(unknownField, '  - id: a\n    pluginx: y\n');
    expect(() => loadComposition(unknownField)).toThrowError(/未知字段「pluginx」/);

    const noId = makeDataDir();
    writeOverlay(noId, '  - pkg: x\n');
    expect(() => loadComposition(noId)).toThrowError(/id 必填/);

    const badTop = makeDataDir();
    writeFileSync(join(badTop, 'overlay.yaml'), 'just-a-string\n');
    expect(() => loadComposition(badTop)).toThrowError(/顶层必须是/);
  });

  it('insert 行缺 pkg 引用：合成期即拒（无官方层引用可沿用）', () => {
    const dataDir = makeDataDir();
    writeOverlay(dataDir, '  - id: ghost-row\n');
    try {
      loadComposition(dataDir);
      expect.unreachable('insert 缺 pkg 必须合成期拒绝');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(COMPOSITION_ROW_INVALID);
      expect((err as AppError).message).toContain('insert 新行必须自带 pkg 引用');
    }
  });

  it('overlay 设置 fixed 字段：拒绝（安全栈强制点只能官方层携带）', () => {
    const dataDir = makeDataDir();
    writeOverlay(dataDir, '  - id: x\n    pkg: p\n    fixed: true\n');
    expect(() => loadComposition(dataDir)).toThrowError(/fixed 只能出现在官方默认层/);
  });

  it('disabled 类型拒绝式：非 true 非平台名即拒', () => {
    const dataDir = makeDataDir();
    writeOverlay(dataDir, '  - id: x\n    pkg: p\n    disabled: maybe\n');
    expect(() => loadComposition(dataDir)).toThrowError(/disabled 必须是 true、平台名/);
  });
});

/* ---------------- sandbox 载体块（第二十七批刀二 K3-b1 引入 runtime；第三十七批升维块状） ---------------- */

describe('sandbox 载体块（契约篇 §1.7 第三十七批）', () => {
  it('insert 行 sandbox: worker：进树且计划行透传（声明面零变化，执行域换轨）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: demo\n    pkg: ${entry}\n    sandbox: { carrier: worker }\n    apps: [chat]\n`);
    const report = loadUserComposition(dataDir);
    expect(report.rows).toEqual([{ id: 'demo', pkg: entry, sandbox: { carrier: 'worker' }, apps: ['chat'] }]);
    expect(report.plan).toEqual([{ id: 'demo', pkg: entry, entry, sandbox: { carrier: 'worker' }, apps: ['chat'] }]);
  });

  it('sandbox 显式 main：与缺省同义（合法值域之一，不制造第二形态）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: demo\n    pkg: ${entry}\n    sandbox: { carrier: main }\n    apps: [chat]\n`);
    const report = loadUserComposition(dataDir);
    expect(report.plan).toEqual([{ id: 'demo', pkg: entry, entry, sandbox: { carrier: 'main' }, apps: ['chat'] }]);
  });

  it('carrier external：行 schema 合法进树（装载期 fail-closed 拒载——冻结在加载器不在 schema）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: demo\n    pkg: ${entry}\n    sandbox: { carrier: external }\n    apps: [chat]\n`);
    const report = loadUserComposition(dataDir);
    // 第三十七批闩一缺省两分派：external 是三值枚举合法值（出生即进程墙的目标态），
    // 过渡冻结发生在装载面（loader 拒载），组合树声明面照常合成透传
    expect(report.plan).toEqual([{ id: 'demo', pkg: entry, entry, sandbox: { carrier: 'external' }, apps: ['chat'] }]);
  });

  it('块形状拒绝式：非对象/未知子键/半块缺 carrier/net 声明即拒——一律 COMPOSITION_ROW_INVALID', () => {
    // 非对象（裸值块）
    const badType = makeDataDir();
    writeOverlay(badType, `  - id: demo\n    pkg: ${writeEntryFile(badType)}\n    sandbox: 3\n`);
    expect(() => loadComposition(badType)).toThrowError(/sandbox 必须是对象/);
    // 未知子键（扩展词汇先过规范）
    const unknownKey = makeDataDir();
    writeOverlay(
      unknownKey,
      `  - id: demo\n    pkg: ${writeEntryFile(unknownKey)}\n    sandbox: { carrier: main, extra: 1 }\n`,
    );
    expect(() => loadComposition(unknownKey)).toThrowError(/sandbox 未知子键「extra」/);
    // 半块：缺 carrier（有效块必带载体声明）
    const half = makeDataDir();
    writeOverlay(half, `  - id: demo\n    pkg: ${writeEntryFile(half)}\n    sandbox: { fs: {} }\n`);
    expect(() => loadComposition(half)).toThrowError(/sandbox\.carrier 必填/);
    // net 子键声明即拒（闩二推论：v1 无 net 执法基线，收了不执行的声明 = 宣示与现实脱节）
    const net = makeDataDir();
    writeOverlay(
      net,
      `  - id: demo\n    pkg: ${writeEntryFile(net)}\n    sandbox: { carrier: main, net: { allow: [] } }\n`,
    );
    expect(() => loadComposition(net)).toThrowError(/sandbox\.net 声明即拒/);
    // carrier 非法值（三值枚举外）
    const badCarrier = makeDataDir();
    writeOverlay(
      badCarrier,
      `  - id: demo\n    pkg: ${writeEntryFile(badCarrier)}\n    sandbox: { carrier: quantum }\n`,
    );
    expect(() => loadComposition(badCarrier)).toThrowError(/sandbox\.carrier 必填/);
  });

  it('fs/caps 形状执法（fs 子键 external carrier 落码批定形；caps 只校验纯对象）', () => {
    const fsBad = makeDataDir();
    writeOverlay(fsBad, `  - id: demo\n    pkg: ${writeEntryFile(fsBad)}\n    sandbox: { carrier: main, fs: [] }\n`);
    expect(() => loadComposition(fsBad)).toThrowError(/sandbox\.fs 必须是对象/);
    // fs 未知子键拒绝式（本批定形：只收 writableRoots——与块级同纪律）
    const fsKeyBad = makeDataDir();
    writeOverlay(
      fsKeyBad,
      `  - id: demo\n    pkg: ${writeEntryFile(fsKeyBad)}\n    sandbox: { carrier: worker, fs: { roots: [] } }\n`,
    );
    expect(() => loadComposition(fsKeyBad)).toThrowError(/sandbox\.fs 未知子键「roots」/);
    // writableRoots 坏元素拒（形状层：数组 + 非空字符串；基线交集闩二在装载消费面另测）
    const rootsBad = makeDataDir();
    writeOverlay(
      rootsBad,
      `  - id: demo\n    pkg: ${writeEntryFile(rootsBad)}\n    sandbox: { carrier: worker, fs: { writableRoots: ['/tmp', ''] } }\n`,
    );
    expect(() => loadComposition(rootsBad)).toThrowError(/writableRoots 必须是非空字符串数组/);
    const capsBad = makeDataDir();
    writeOverlay(
      capsBad,
      `  - id: demo\n    pkg: ${writeEntryFile(capsBad)}\n    sandbox: { carrier: main, caps: 'rw' }\n`,
    );
    expect(() => loadComposition(capsBad)).toThrowError(/sandbox\.caps 必须是对象/);
    // 合法形状：writableRoots 数组过、块值原样保留（apps 同行——触发② 执法另测）
    const ok = makeDataDir();
    const entry = writeEntryFile(ok);
    const wsRoot = join(ok, 'ws');
    writeOverlay(
      ok,
      `  - id: demo\n    pkg: ${entry}\n    apps: [chat]\n    sandbox: { carrier: external, fs: { writableRoots: ['${wsRoot}'] }, caps: {} }\n`,
    );
    expect(loadUserComposition(ok).plan).toEqual([
      {
        id: 'demo',
        pkg: entry,
        entry,
        sandbox: { carrier: 'external', fs: { writableRoots: [wsRoot] }, caps: {} },
        apps: ['chat'],
      },
    ]);
  });

  it('builtin 官方行声明块（任何 carrier）：机器执法即响（官方随包件恒 main 域，§1.7）', () => {
    // 形态一：overlay 行显式带 builtin pkg 引用——第一执法点（validateRow 原貌）即拒
    const explicit = makeDataDir();
    writeOverlay(explicit, '  - id: memory\n    pkg: builtin:memory\n    sandbox: { carrier: main }\n');
    try {
      loadComposition(explicit);
      expect.unreachable('builtin 行显式引用携块必须即响');
    } catch (err) {
      expect((err as AppError).code).toBe(COMPOSITION_ROW_INVALID);
      expect((err as AppError).message).toContain('不可声明 sandbox 块');
    }

    // 形态二：替换官方层行省略 pkg——合成后 mergeRows 补刀拦下
    const dataDir = makeDataDir();
    writeOverlay(dataDir, '  - id: memory\n    sandbox: { carrier: worker }\n');
    const officialStub = { name: 'memory-stub', apply: async () => {} };
    try {
      loadComposition(dataDir, { 'builtin:memory': officialStub });
      expect.unreachable('builtin 行换壳夹带 sandbox 块必须即响');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(COMPOSITION_ROW_INVALID);
      expect((err as AppError).message).toContain('合成后携带 sandbox 块');
    }
  });

  it('写回往返零字段损失：sandbox 块随行序列化（parse→stringify→parse 幂等）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    saveOverlayRows(dataDir, [
      { id: 'demo', pkg: entry, sandbox: { carrier: 'worker' } },
      { id: 'plain', pkg: entry },
    ]);
    const reloaded = loadOverlayRows(dataDir);
    expect(reloaded).toEqual([
      { id: 'demo', pkg: entry, sandbox: { carrier: 'worker' } },
      { id: 'plain', pkg: entry },
    ]);
  });

  it('toggle 禁用→启用：sandbox 块存续（纯 sandbox 替换行不误删）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    saveOverlayRows(dataDir, [{ id: 'demo', pkg: entry, sandbox: { carrier: 'worker' }, config: { k: 1 } }]);
    toggleOverlayRow(dataDir, 'demo'); // → 禁用
    toggleOverlayRow(dataDir, 'demo'); // → 启用（删 disabled 键，sandbox/config 存续）
    const row = loadOverlayRows(dataDir).find((r) => r.id === 'demo');
    expect(row).toEqual({ id: 'demo', pkg: entry, sandbox: { carrier: 'worker' }, config: { k: 1 } });
  });
});

/* ---------------- 禁用解析与挂载休眠 ---------------- */

describe('禁用解析（挂载休眠）', () => {
  it('disabled:true 跳过行不解析入口：应用未安装也不失败（禁用行同样过触发②执法）', () => {
    const dataDir = makeDataDir();
    // plugin 指向不存在的裸名——禁用行不要求已装；第三方行带 app（执法全行统一）
    writeOverlay(dataDir, '  - id: dormant\n    pkg: never-installed-pkg\n    disabled: true\n    apps: [chat]\n');
    const report = loadUserComposition(dataDir);
    expect(report.plan).toEqual([{ id: 'dormant', skip: 'disabled', apps: ['chat'] }]);
  });

  it('平台门控：命中当前平台 → platform 跳过；他平台 → 照常激活', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    const other = process.platform === 'win32' ? 'linux' : 'win32';
    writeOverlay(
      dataDir,
      `  - id: gated\n    pkg: never-installed\n    disabled: ${process.platform}\n    apps: [chat]\n` +
        `  - id: ungated\n    pkg: ${entry}\n    disabled: ${other}\n    apps: [chat]\n`,
    );
    const report = loadUserComposition(dataDir);
    expect(report.plan).toEqual([
      { id: 'gated', skip: 'platform', apps: ['chat'] }, // 命中当前平台——不解析入口（skip 行不带 plugin）
      { id: 'ungated', pkg: entry, entry, apps: ['chat'] }, // 他平台门控不生效——照常激活
    ]);
  });
});

/* ---------------- 入口解析（裸名装机子树 + harness 字段） ---------------- */

describe('应用入口解析', () => {
  it('裸名 → <数据目录>/apps/node_modules/<包名> + package.json harness.extensions 首选', () => {
    const dataDir = makeDataDir();
    const pkgDir = join(dataDir, 'apps', 'node_modules', 'fake-pkg');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ harness: { extensions: ['custom-entry.ts'] } }));
    writeEntryFile(pkgDir, 'custom-entry.ts');

    expect(resolveAppEntry('fake-pkg', dataDir)).toBe(join(pkgDir, 'custom-entry.ts'));
    // 经组合树同路径（overlay 裸名行全链路——第三方裸名行同样带 app 键）
    writeOverlay(dataDir, '  - id: p1\n    pkg: fake-pkg\n    apps: [chat]\n');
    expect(loadUserComposition(dataDir).plan[0]).toEqual({
      id: 'p1',
      pkg: 'fake-pkg',
      entry: join(pkgDir, 'custom-entry.ts'),
      apps: ['chat'],
    });
  });

  it('无 harness 字段 → 约定目录 extensions/index.ts 回退 → 包根 index.ts 兜底', () => {
    const dataDir = makeDataDir();
    // 仅有约定目录
    const pkgA = join(dataDir, 'apps', 'node_modules', 'pkg-a');
    mkdirSync(join(pkgA, 'extensions'), { recursive: true });
    writeEntryFile(join(pkgA, 'extensions'), 'index.ts');
    expect(resolveAppEntry('pkg-a', dataDir)).toBe(join(pkgA, 'extensions', 'index.ts'));

    // 约定目录也无、包根 index.ts 在
    const pkgB = join(dataDir, 'apps', 'node_modules', 'pkg-b');
    mkdirSync(pkgB, { recursive: true });
    writeEntryFile(pkgB, 'index.js');
    expect(resolveAppEntry('pkg-b', dataDir)).toBe(join(pkgB, 'index.js'));

    // 全无 → undefined（→ unresolved 行进启动断言——加载器永不自动安装）
    expect(resolveAppEntry('pkg-c', dataDir)).toBeUndefined();
  });

  it('未安装裸名行：unresolved 计划行，信息明示永不自动安装', () => {
    const dataDir = makeDataDir();
    writeOverlay(dataDir, '  - id: missing\n    pkg: absent-pkg\n    apps: [chat]\n');
    const report = loadUserComposition(dataDir);
    expect(report.plan).toHaveLength(1);
    expect((report.plan[0] as { id: string }).id).toBe('missing');
    expect((report.plan[0] as { unresolved?: string }).unresolved).toContain('永不自动安装');
    expect((report.plan[0] as { entry?: string }).entry).toBeUndefined();
    // 未解析行也带 pkg 引用（归因完整——join 键在场上，无消费面而已）
    expect((report.plan[0] as { pkg?: string }).pkg).toBe('absent-pkg');
  });
});

/* ---------------- 目录服务与应用管理服务 ---------------- */

describe('目录服务（ctx.paths）', () => {
  it('appDataDir 首取即建目录、幂等缓存；dataDir 返回根', () => {
    const dataDir = makeDataDir();
    const paths = createPathsService(dataDir, process.cwd());
    expect(paths.dataDir()).toBe(dataDir);
    const first = paths.appDataDir('memory');
    expect(first).toBe(join(dataDir, 'apps', 'memory'));
    // 首取已建——目录真实存在
    expect(existsSync(first)).toBe(true);
    // 再取同路径（幂等，不重复 mkdir 抛错）
    expect(paths.appDataDir('memory')).toBe(first);
  });

  it('数据根保留名闸收口 appDataDirOf 单点：撞装机子树名即拒（公共面/收割写/删根同径）', () => {
    const dataDir = makeDataDir();
    const paths = createPathsService(dataDir, process.cwd());
    // 保留名对逐名验：原语直接取址抛 COMPOSITION_ROW_INVALID（布局闸单点）
    for (const reserved of RESERVED_SUBTREE_NAMES) {
      let thrown: unknown;
      try {
        appDataDirOf(dataDir, reserved);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe(COMPOSITION_ROW_INVALID);
      // 公共面 ctx.paths.appDataDir 同闸（曾自复刻 join 零闸——复盘批收口的口子）
      expect(() => paths.appDataDir(reserved)).toThrow(AppError);
    }
    // 拒绝不落痕迹：撞名取址失败后不建任何目录（mkdir 前抛）
    expect(existsSync(join(dataDir, 'apps', 'git'))).toBe(false);
    // 合法 id 原语面 = 纯路径拼接（不建目录——建目录是服务面首取职责）
    expect(appDataDirOf(dataDir, 'memory')).toBe(join(dataDir, 'apps', 'memory'));
    expect(existsSync(join(dataDir, 'apps', 'memory'))).toBe(false);
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

describe('overlay 写回：saveOverlayRows / toggleOverlayRow / insertOverlayRow', () => {
  it('往返零字段损失：save→load 深相等（parse→stringify→parse 幂等，含 config 嵌套值）', () => {
    const dataDir = makeDataDir();
    const rows = [
      { id: 'bare-pkg', pkg: 'some-package', apps: ['chat'] },
      {
        id: 'with-config',
        pkg: './local',
        apps: ['chat'],
        config: { port: 8080, label: '你好: world', nested: { list: [1, 'two', true] } },
      },
      { id: 'gated', pkg: 'x', apps: ['chat'], disabled: 'win32' },
      { id: 'off', pkg: 'y', apps: ['chat'], disabled: true },
    ];
    saveOverlayRows(dataDir, rows);
    // 写读面（validateRow 拒绝式）原样读回——四行全字段无损失（往返纪律只关
    // 写读保真，合成/挂载执法面另测；D2 触发②后第三方行往返同携 app 键）
    const loaded = loadOverlayRows(dataDir);
    expect(loaded).toEqual(rows);
    // 二次往返（save(load(save))) 仍幂等
    saveOverlayRows(dataDir, [...loaded]);
    expect(loadOverlayRows(dataDir)).toEqual(rows);
  });

  it('空行集写回：合法空 overlay（rows: []），用户层为空树（官方层照常打底）', () => {
    const dataDir = makeDataDir();
    saveOverlayRows(dataDir, []);
    expect(loadUserComposition(dataDir).rows).toEqual([]);
  });

  it('toggle 翻转：启用→禁用保留 app/config；禁用→启用删键、纯禁用行整行移除', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(
      dataDir,
      `  - id: live\n    pkg: ${entry}\n    apps: [chat]\n` +
        '  - id: pure-off\n    pkg: p\n    apps: [chat]\n    disabled: true\n',
    );
    // 现禁用行（pure-off，带 plugin）→ 启用：删键保留行
    expect(toggleOverlayRow(dataDir, 'pure-off')).toBe(false);
    expect(loadOverlayRows(dataDir)).toEqual([
      { id: 'live', pkg: entry, apps: ['chat'] },
      { id: 'pure-off', pkg: 'p', apps: ['chat'] },
    ]);
    // 再翻 → 禁用：保留 plugin 只置 disabled
    expect(toggleOverlayRow(dataDir, 'pure-off')).toBe(true);
    expect(loadOverlayRows(dataDir)).toEqual([
      { id: 'live', pkg: entry, apps: ['chat'] },
      { id: 'pure-off', pkg: 'p', apps: ['chat'], disabled: true },
    ]);
    // live 行不带 plugin 字段的纯禁用路径：先手工写一行只含 id+disabled 的行
    writeOverlay(
      dataDir,
      `  - id: live\n    pkg: ${entry}\n    apps: [chat]\n` + '  - id: flag-only\n    disabled: true\n',
    );
    // 等等——flag-only 是 insert 行但无 plugin：装载面本就拒绝；写回面删键后应整行移除
    expect(toggleOverlayRow(dataDir, 'live')).toBe(true); // live → 禁用（保留 plugin）
    expect(toggleOverlayRow(dataDir, 'live')).toBe(false); // 再启回（保留 plugin）
    expect(toggleOverlayRow(dataDir, 'flag-only')).toBe(false); // 纯禁用行 → 启用 = 整行移除
    expect(loadOverlayRows(dataDir)).toEqual([{ id: 'live', pkg: entry, apps: ['chat'] }]);
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

  it('insertOverlayRow：纯追加挂载行（mount 持久化半边——撞名在服务面先裁，本面不悄悄改既有行）', () => {
    const dataDir = makeDataDir();
    // 首挂：空 overlay 追加 {id, pkg, apps, config}（mount 全字段形态）
    insertOverlayRow(dataDir, { id: 'fresh', pkg: 'some-package', apps: ['chat'], config: { k: 1 } });
    expect(loadOverlayRows(dataDir)).toEqual([{ id: 'fresh', pkg: 'some-package', apps: ['chat'], config: { k: 1 } }]);
    // 追加不触碰既有行（第二应用挂载 = 第二行，同包两行共存——D2 多应用挂载形态）
    insertOverlayRow(dataDir, { id: 'second', pkg: 'some-package', apps: ['hermes'] });
    expect(loadOverlayRows(dataDir)).toEqual([
      { id: 'fresh', pkg: 'some-package', apps: ['chat'], config: { k: 1 } },
      { id: 'second', pkg: 'some-package', apps: ['hermes'] },
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
    // 默认层十四键全给（其余官方行同解析——不带 config 的纯净形态对照）
    const stubChat = { name: 'chat-stub', apply: async () => {} };
    const stubSubagent = { name: 'subagent-stub', apply: async () => {} };
    const stubGoal = { name: 'goal-stub', apply: async () => {} };
    const stubScheduler = { name: 'scheduler-stub', apply: async () => {} };
    const stubMcp = { name: 'mcp-stub', apply: async () => {} };
    const stubTools = { name: 'tools-stub', apply: async () => {} };
    const stubWeb = { name: 'web-stub', apply: async () => {} };
    const stubCompaction = { name: 'compaction-stub', apply: async () => {} };
    const stubAdmin = { name: 'admin-stub', apply: async () => {} };
    const stubCheckpoint = { name: 'checkpoint-stub', apply: async () => {} };
    const stubLsp = { name: 'lsp-stub', apply: async () => {} };
    const stubChannels = { name: 'channels-stub', apply: async () => {} };
    const stubWebui = { name: 'webui-stub', apply: async () => {} };
    const stubObs = { name: 'obs-stub', apply: async () => {} };
    const stubBrowser = { name: 'browser-stub', apply: async () => {} };
    const stubDesktop = { name: 'desktop-stub', apply: async () => {} };
    const stubAssistant = { name: 'assistant-stub', apply: async () => {} };
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
      'builtin:checkpoint': stubCheckpoint,
      'builtin:lsp': stubLsp,
      'builtin:channels': stubChannels,
      'builtin:webui': stubWebui,
      'builtin:obs': stubObs,
      'builtin:browser': stubBrowser,
      'builtin:desktop': stubDesktop,
      'builtin:assistant': stubAssistant,
    });
    expect(report.rows).toEqual([
      { id: 'chat', pkg: 'builtin:chat' },
      { id: 'memory', pkg: 'builtin:memory', config: { recallTopK: 5 } },
      { id: 'subagent', pkg: 'builtin:subagent' },
      { id: 'goal', pkg: 'builtin:goal' },
      { id: 'scheduler', pkg: 'builtin:scheduler' },
      { id: 'mcp', pkg: 'builtin:mcp' },
      { id: 'tools', pkg: 'builtin:tools' },
      { id: 'web', pkg: 'builtin:web' },
      { id: 'compaction', pkg: 'builtin:compaction' },
      { id: 'admin', pkg: 'builtin:admin' },
      { id: 'checkpoint', pkg: 'builtin:checkpoint' },
      { id: 'lsp', pkg: 'builtin:lsp' },
      { id: 'channels', pkg: 'builtin:channels' },
      { id: 'webui', pkg: 'builtin:webui' },
      { id: 'obs', pkg: 'builtin:obs' },
      { id: 'browser', pkg: 'builtin:browser' },
      { id: 'desktop', pkg: 'builtin:desktop' },
      { id: 'assistant', pkg: 'builtin:assistant' },
    ]);
    expect(report.plan).toEqual([
      { id: 'chat', pkg: 'builtin:chat', builtin: stubChat },
      { id: 'memory', pkg: 'builtin:memory', builtin: stubBuiltin, config: { recallTopK: 5 } },
      { id: 'subagent', pkg: 'builtin:subagent', builtin: stubSubagent },
      { id: 'goal', pkg: 'builtin:goal', builtin: stubGoal },
      { id: 'scheduler', pkg: 'builtin:scheduler', builtin: stubScheduler },
      { id: 'mcp', pkg: 'builtin:mcp', builtin: stubMcp },
      { id: 'tools', pkg: 'builtin:tools', builtin: stubTools },
      { id: 'web', pkg: 'builtin:web', builtin: stubWeb },
      { id: 'compaction', pkg: 'builtin:compaction', builtin: stubCompaction },
      { id: 'admin', pkg: 'builtin:admin', builtin: stubAdmin },
      { id: 'checkpoint', pkg: 'builtin:checkpoint', builtin: stubCheckpoint },
      { id: 'lsp', pkg: 'builtin:lsp', builtin: stubLsp },
      { id: 'channels', pkg: 'builtin:channels', builtin: stubChannels },
      { id: 'webui', pkg: 'builtin:webui', builtin: stubWebui },
      { id: 'obs', pkg: 'builtin:obs', builtin: stubObs },
      { id: 'browser', pkg: 'builtin:browser', builtin: stubBrowser },
      { id: 'desktop', pkg: 'builtin:desktop', builtin: stubDesktop },
      { id: 'assistant', pkg: 'builtin:assistant', builtin: stubAssistant },
    ]);
  });

  it('注册表未命中：unresolved 响亮——保留前缀仅官方随包件可用（overlay 不能伪装）', () => {
    const dataDir = makeDataDir();
    const report = loadComposition(dataDir, {});
    expect(report.plan[0]!.unresolved).toContain('不在宿主注册表');
    expect(report.plan[0]!.unresolved).toContain('保留前缀');
  });

  it('overlay 替换引用：memory 行 plugin 换本地路径 → 走文件应用解析（D2 后 = 换实现+换作用域，行须带 app）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    // 触发②开闸后：替换官方层 id 的第三方行按 app 键归区（契约篇 §5.1 分区
    // 规则——换实现 + 换作用域）；不带 app 的第三方替换行即触发②拒绝
    writeOverlay(dataDir, `  - id: memory\n    pkg: ${entry}\n    apps: [chat]\n`);
    const report = loadComposition(dataDir, { 'builtin:memory': stubBuiltin }, KNOWN_APPS);
    // chat 行（首行）此注册表未给 → unresolved 占 plan[0]；memory 行在 plan[1]
    //（apps 透传：替换行按 app 键归区——分区判据在计划行上）
    expect(report.plan[1]).toEqual({ id: 'memory', pkg: entry, entry, apps: ['chat'] });
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
  /** 全行 stub 注册表（健康形态——行行可解析） */
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
    'builtin:admin': { name: 'admin-stub', apply: async () => {} },
    'builtin:checkpoint': { name: 'checkpoint-stub', apply: async () => {} },
    'builtin:lsp': { name: 'lsp-stub', apply: async () => {} },
    'builtin:channels': { name: 'channels-stub', apply: async () => {} },
    'builtin:webui': { name: 'webui-stub', apply: async () => {} },
    'builtin:obs': { name: 'obs-stub', apply: async () => {} },
    'builtin:browser': { name: 'browser-stub', apply: async () => {} },
    'builtin:desktop': { name: 'desktop-stub', apply: async () => {} },
  });

  it('起算清单：RING1_REQUIRED_ROW_IDS = [tools, channels, desktop]（后续行树化纵切逐行累加）', () => {
    expect(RING1_REQUIRED_ROW_IDS).toEqual(['tools', 'channels', 'desktop']);
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

  it('validateRow 类型拒绝式：apps 非数组 / 空串元素 / 空数组 / 重复元素即 COMPOSITION_ROW_INVALID（不误读）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    // 非数组（旧单值形态 = 类型拒绝——数组化后不静默归一）
    writeOverlay(dataDir, `  - id: bad-type\n    pkg: ${entry}\n    apps: 42\n`);
    expectRowInvalid(dataDir, new Set(), 'apps 必须是非空字符串数组');
    // 空串元素（不符应用 id 形状）
    writeOverlay(dataDir, `  - id: bad-empty\n    pkg: ${entry}\n    apps: ['']\n`);
    expectRowInvalid(dataDir, new Set(), '不符应用 id 形状');
    // 空数组 = 拒行（零语义键值不落盘——全局作用域 = 省略 apps 键）
    writeOverlay(dataDir, `  - id: bad-none\n    pkg: ${entry}\n    apps: []\n`);
    expectRowInvalid(dataDir, new Set(), 'apps 空数组 = 拒行');
    // 重复元素（重复挂载 = 配置面笔误，拒绝式不静默去重）
    writeOverlay(dataDir, `  - id: bad-dup\n    pkg: ${entry}\n    apps: [chat, chat]\n`);
    expectRowInvalid(dataDir, new Set(['chat']), 'apps 重复元素「chat」');
  });

  it('触发①：未知应用 id 即拒——缺省空集 = 拒绝式缺省（裸调不传清单集，任何 app 行都过不了）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: thing\n    pkg: ${entry}\n    apps: [chat]\n`);
    // 不传第三参（缺省空集）：app 恒未知——测试面直接裸调即测「未知应用」路径
    expectRowInvalid(dataDir, new Set(), '未知应用 id「chat」');
    // 在册集不含目标 id：同样触发①（message 披露在册集——自助排错）
    expectRowInvalid(dataDir, new Set(['hermes']), '未知应用 id「chat」');
    // 多元素数组：任一未知即拒（逐元素执法——共享件不因多数合法而放过少数）
    writeOverlay(dataDir, `  - id: multi\n    pkg: ${entry}\n    apps: [chat, hermes]\n`);
    expectRowInvalid(dataDir, new Set(['hermes']), '未知应用 id「chat」');
  });

  it('触发③：Ring 1 必备行带 app 即拒（tools 行——换实现可、换作用域不可）', () => {
    const dataDir = makeDataDir();
    // 省略 plugin = 沿用官方层 builtin:tools 引用；chat 在册使触发①先过、③后响
    writeOverlay(dataDir, '  - id: tools\n    apps: [chat]\n');
    expectRowInvalid(dataDir, new Set(['chat']), 'Ring 1 必备行不可携带 apps');
  });

  it('触发④：官方引用行带 app 即拒——显式 builtin: 引用与省略沿用官方层两形态同判', () => {
    const dataDir = makeDataDir();
    // 形态一：insert 行显式 builtin: 引用（官方件身份不可借 app 改作用域）
    writeOverlay(dataDir, '  - id: fake-official\n    pkg: builtin:web\n    apps: [chat]\n');
    expectRowInvalid(dataDir, new Set(['chat']), '官方件行（builtin:web）不可携带 apps');
    // 形态二：overlay 替换官方层行省略 plugin——合成后沿用 builtin:memory，判源
    // 不需特判「省略」形态（合成产物已带前缀）
    writeOverlay(dataDir, '  - id: memory\n    apps: [chat]\n');
    expectRowInvalid(dataDir, new Set(['chat']), '官方件行（builtin:memory）不可携带 apps');
  });

  it('触发②：第三方行缺省挂系统即拒——D2 开闸（install 不再写行，全局作用域 v1 官方专属）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    // 路径引用形（local）：第三方行籍随行引用形（非 builtin: 前缀即第三方）
    writeOverlay(dataDir, `  - id: rogue\n    pkg: ${entry}\n`);
    expectRowInvalid(dataDir, new Set(['chat']), '缺省挂系统');
    // npm 裸名引用形同判；禁用行同样执法（潜伏配置预先即拒）
    writeOverlay(dataDir, '  - id: rogue-npm\n    pkg: some-pkg\n    disabled: true\n');
    expectRowInvalid(dataDir, new Set(['chat']), '缺省挂系统');
    // 官方行缺省挂系统 = 合法形态（对照——执法只对第三方行籍）
    writeOverlay(dataDir, '  - id: memory\n    config: { k: 1 }\n');
    expect(loadComposition(dataDir, {}, new Set(['chat'])).rows.find((r) => r.id === 'memory')).toMatchObject({
      id: 'memory',
    });
  });

  it('合法 apps 行：在册 id + 第三方引用 → 行进树携带 apps（计划行不带 apps——合成行按 id 联查）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: my-thing\n    pkg: ${entry}\n    apps: [chat, hermes]\n`);
    const report = loadComposition(dataDir, {}, new Set(['chat', 'hermes']));
    const row = report.rows.find((r) => r.id === 'my-thing');
    // 多元素数组 = 共享件（一行投多 app）：合成行按数组原样携带
    expect(row).toMatchObject({ id: 'my-thing', pkg: entry, apps: ['chat', 'hermes'] });
    // 计划行正常解析（apps 不影响装载计划——执法在合成期，过了即常规行）
    expect(report.plan.find((r) => r.id === 'my-thing')?.entry).toBe(entry);
  });

  it('disabled 行同样执法：潜伏配置预先即拒（不留「toggle 启用才炸」陷阱）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: off-app\n    pkg: ${entry}\n    apps: [ghost]\n    disabled: true\n`);
    expectRowInvalid(dataDir, new Set(['chat']), '未知应用 id「ghost」');
  });

  it('合成语义：apps 字段级后写胜出（省略沿用前值、给定即替换）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    const known = new Set(['chat', 'hermes']);
    // 同 id 两行顺序应用：第二行省略 apps → 沿用第一行的 [chat]
    writeOverlay(dataDir, `  - id: thing\n    pkg: ${entry}\n    apps: [chat]\n  - id: thing\n    pkg: ${entry}\n`);
    expect(loadComposition(dataDir, {}, known).rows.find((r) => r.id === 'thing')?.apps).toEqual(['chat']);
    // 第二行给定 apps → 整体替换（数组是单值字段——整体替换不并集）
    writeOverlay(
      dataDir,
      `  - id: thing\n    pkg: ${entry}\n    apps: [chat]\n  - id: thing\n    pkg: ${entry}\n    apps: [hermes]\n`,
    );
    expect(loadComposition(dataDir, {}, known).rows.find((r) => r.id === 'thing')?.apps).toEqual(['hermes']);
  });

  it('写回往返零字段损失：app 随行序列化（parse→stringify→parse 幂等）', () => {
    const dataDir = makeDataDir();
    const rows = [
      { id: 'sys-row', pkg: 'some-package' },
      { id: 'app-row', pkg: './local', apps: ['chat'] },
    ];
    saveOverlayRows(dataDir, rows);
    // 装载面已知 chat 在册——深相等往返（app 无损失）
    expect(loadOverlayRows(dataDir)).toEqual(rows);
  });

  it('toggle 禁用→启用：app 字段存续（带 plugin 的 app 行删 disabled 键后 app 保留）', () => {
    const dataDir = makeDataDir();
    writeOverlay(dataDir, '  - id: approw\n    pkg: p\n    apps: [chat]\n    disabled: true\n');
    expect(toggleOverlayRow(dataDir, 'approw')).toBe(false);
    expect(loadOverlayRows(dataDir)).toEqual([{ id: 'approw', pkg: 'p', apps: ['chat'] }]);
  });

  it('toggle 纯 {id, app} 残留行整行移除：无 plugin 的 app 行不可能是合法行（残留即装载地雷）', () => {
    const dataDir = makeDataDir();
    writeOverlay(dataDir, '  - id: appres\n    apps: [chat]\n    disabled: true\n');
    expect(toggleOverlayRow(dataDir, 'appres')).toBe(false);
    expect(loadOverlayRows(dataDir)).toEqual([]);
  });

  it('configure 删 config 键：app 存续于带 plugin 行；{id, app} 残留行整行移除（同 toggle 谓词）', () => {
    const dataDir = makeDataDir();
    writeOverlay(
      dataDir,
      '  - id: cfg-app\n    pkg: p\n    config: { a: 1 }\n    apps: [chat]\n' +
        '  - id: cfg-res\n    config: { a: 1 }\n    apps: [chat]\n',
    );
    writeOverlayRowConfig(dataDir, 'cfg-app', {});
    writeOverlayRowConfig(dataDir, 'cfg-res', {});
    expect(loadOverlayRows(dataDir)).toEqual([{ id: 'cfg-app', pkg: 'p', apps: ['chat'] }]);
  });
});

/* ---------------- 装载计划分区（D3 装载分面分区，契约篇 §5.1，2026-08-29） ---------------- */

describe('partitionPlan：装载计划分区', () => {
  /** 最小计划行构造（分区判据只看 id/apps 两键——纯函数直测免合成链） */
  const row = (id: string, apps?: readonly string[]): AppPlanRow => ({ id, ...(apps ? { apps } : {}) });

  it('判据两步：Ring 1 必备行先剔（独立维持现状），再按 apps 归区', () => {
    const part = partitionPlan([
      row('tools'), // Ring 1 必备行——进 ring1 袋不进分区账
      row('sys-official'), // 官方默认层行（apps 缺席）→ 系统区
      row('app-only', ['chat']), // 恰一元素 → app:chat 独占
      row('shared', ['chat', 'code']), // 多元素 → 跨区行（挂系统相位）
    ]);
    expect(part.ring1.map((r) => r.id)).toEqual(['tools']);
    expect(part.system.map((r) => r.id)).toEqual(['sys-official', 'shared']);
    expect(part.zoneRows.get('chat')!.map((r) => r.id)).toEqual(['app-only']);
    expect(part.appIds).toEqual(['chat']);
  });

  it('appIds 字典序（装载序契约面：系统相位先行后依此序串行——与行入序无关）', () => {
    const part = partitionPlan([row('z', ['zeta']), row('a', ['alpha']), row('m', ['mid'])]);
    expect(part.appIds).toEqual(['alpha', 'mid', 'zeta']);
    expect([...part.zoneRows.keys()]).toEqual(['zeta', 'alpha', 'mid']); // 行表保入序（区内装载序）
  });

  it('skip 行同样按 apps 归区（单区 reload 重发 skipped 需要分区归属）', () => {
    const part = partitionPlan([{ id: 'dormant', skip: 'disabled', apps: ['chat'] }]);
    expect(part.zoneRows.get('chat')!.map((r) => r.id)).toEqual(['dormant']);
    expect(part.system).toEqual([]);
  });

  it('与 loadComposition 透传衔接：合成计划行携带 apps 后分区即得（全链路）', () => {
    const dataDir = makeDataDir();
    const entry = writeEntryFile(dataDir);
    writeOverlay(dataDir, `  - id: mountable\n    pkg: ${entry}\n    apps: [chat]\n`);
    // 空注册表：官方默认层行 unresolved 但照进 plan（行原貌分区——不按激活态）
    const report = loadComposition(dataDir, {}, KNOWN_APPS);
    const part = partitionPlan(report.plan);
    // Ring 1 必备行先剔（tools/channels/desktop 三行 → ring1 袋——独立装载锚维持现状）
    expect(part.ring1.map((r) => r.id)).toEqual(['tools', 'channels', 'desktop']);
    // 其余官方默认层行（apps 缺席）+ 无 apps 用户行全数归系统区
    expect(part.system.every((r) => r.apps === undefined)).toBe(true);
    expect(part.zoneRows.get('chat')!.map((r) => r.id)).toEqual(['mountable']);
  });
});

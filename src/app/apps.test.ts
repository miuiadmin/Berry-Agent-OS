/**
 * L5 app — 应用管理服务测试（ctx.apps install/mount/unmount/toggle/update，
 * 契约篇 §6.1 装机两态 + §1.5 表尾落码）。
 *
 * D2 两态语义（2026-08-27 第三十批）：install = 仓库态零行写入（代码进装机
 * 子树 + provenance 全源账本落账）；mount = 写组合行生效动词（行带 app 键）；
 * unmount = 删行保码；update/uninstall 键域 = 装机推导 id（非组合树行 id）。
 *
 * 纪律对照：装机子进程执行器 / 入口一次性装载 / git commit 采集是**注入边**
 * （mock 只停在这一层——它们就是外部进程面，等价于模型层的 faux provider）；
 * overlay 读写 / provenance 账本 / 组合树装载全真（临时目录真文件）。
 */

import {
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { type AppError, COMPOSITION_ROW_INVALID, APP_CONFIG_INVALID, APP_INSTALL_FAILED } from '../contracts/errors.js';
import type { AppLoadResult } from '../contracts/app.js';
import { Type } from '../contracts/typebox.js';
import {
  createAppsService,
  spawnRunner,
  sweepAppTmpDirs,
  npmSpawnPlan,
  type ConfigureReport,
  type EntryLoader,
  type InstallRunner,
  type ReloadOutcome,
  type UninstalledEventData,
} from './apps.js';
import { loadComposition, loadOverlayRows } from './composition.js';
// 升权词汇单一归宿锁的两极（admin 件镜像常量 ↔ safety 权威词表）：admin 边只有
// contracts 不开 admin→safety——app 是两侧唯一合法会师点，锁测试住本文件
import { PRIVILEGE_REQUEST_TARGETS } from '../admin/write-tools.js';
import { ESCALATION_TARGETS } from '../safety/sandbox.js';

/* ---------------- 测试基建 ---------------- */

/** 临时数据目录（overlay 与装机子树的根） */
function makeDataDir(): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-apps-')));
}

/** 在册应用 id 集（组合树 app 键取值域——官方两应用，与 composition.test 同值域） */
const KNOWN_APPS = new Set(['chat', 'hermes']);

/**
 * 装载组合树（knownAppIds 恒传——挂载行带 app 键，bare 调用在有第三方行时
 * 会触发①未知应用 id 误炸；本文件装载只为行对账，不为执法面测试）
 */
function loadCompositionFor(dataDir: string): ReturnType<typeof loadComposition> {
  return loadComposition(dataDir, {}, KNOWN_APPS);
}

/**
 * 装载并滤除官方默认层行（chat 首行 + memory 次行 + subagent 第三行 + goal 第四行 +
 * scheduler 第五行 + mcp 第六行 + tools 第七行〔Ring 1 行树化起算〕+ web 第八行 +
 * compaction 第九行 + admin 第十行 + checkpoint 第十一行 + lsp 第十二行 + channels
 * 第十三行〔Ring 1 第二行树化〕+ webui 第十四行 + obs 第十五行 + browser 第十六行〔2026-08-31 第四十九批〕+
 * desktop 第十七行〔Ring 1 第三行树化——契约篇 §6.11 批 C〕——契约篇
 * §5.1/§1.5.2/§6.6/§3.4/§6.7/§6.8）：本文件测 overlay 对账语义（用户层写什么/读回什么），
 * 官方行进 composition.test 专属测试——两关注点不混断言。
 */
function userRows(dataDir: string): unknown[] {
  return loadCompositionFor(dataDir).rows.filter(
    (row) =>
      row.id !== 'chat' &&
      row.id !== 'memory' &&
      row.id !== 'subagent' &&
      row.id !== 'goal' &&
      row.id !== 'scheduler' &&
      row.id !== 'mcp' &&
      row.id !== 'tools' &&
      row.id !== 'web' &&
      row.id !== 'compaction' &&
      row.id !== 'admin' &&
      row.id !== 'checkpoint' &&
      row.id !== 'lsp' &&
      row.id !== 'channels' &&
      row.id !== 'webui' &&
      row.id !== 'obs' &&
      row.id !== 'browser' &&
      row.id !== 'desktop' &&
      row.id !== 'assistant',
  );
}

/** 读 provenance 全源账本（D2 两态——`<数据目录>/apps/sources.json`） */
function readLedger(dataDir: string): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(join(dataDir, 'apps', 'sources.json'), 'utf8')) as Record<
    string,
    Record<string, unknown>
  >;
}

/** runner 替身：记录每次调用；可选 scripted 失败（按命令名命中即抛） */
function fakeRunner(failures: Record<string, string> = {}) {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const runner: InstallRunner = async (command, args, opts) => {
    calls.push({ command, args: [...args], cwd: opts.cwd });
    const failure = failures[command];
    if (failure !== undefined) throw new Error(failure);
  };
  return { calls, runner };
}

/** git commit 采集替身（provenance 精确版本注入边——免真 git 仓） */
const fakeCommit: (dir: string) => Promise<string | undefined> = async () => 'deadbeef1234';

/** 最小装载结果（applyLoad 测试面） */
const emptyLoad: AppLoadResult = { activated: [], failed: [], skipped: [] };

/* ---------------- install 三源分发（仓库态：零行写入 + provenance 落账） ---------------- */

describe('install 三源分发（D2 仓库态）', () => {
  it('npm 源：--prefix 装机子树 + provenance 落账；**不写组合行 = 零生效**，报告指引 mount', async () => {
    const dataDir = makeDataDir();
    const { calls, runner } = fakeRunner();
    const apps = createAppsService({ dataDir, runner, gitCommitOf: fakeCommit });

    const report = await apps.install('some-pkg@^2.1.0');

    expect(report.id).toBe('some-pkg'); // npm spec 剥版本段
    expect(report.source).toBe('npm');
    expect(report.appRef).toBe('some-pkg'); // npm 装机引用 = 裸包名（mount 写行时沿用）
    expect(report.message).toContain('/apps-mount'); // 断头路指引：装了没挂 = 不可用
    expect(calls).toEqual([
      {
        command: 'npm',
        args: ['install', '--prefix', join(dataDir, 'apps'), '--legacy-peer-deps', '--omit=peer', 'some-pkg@^2.1.0'],
        cwd: dataDir,
      },
    ]);
    // 仓库态零行：install 不写 overlay（写行生效是 mount 的独立动词）
    expect(userRows(dataDir)).toEqual([]);
    // provenance 落账：键 = 装机物定位串（node_modules/<pkg>），记录含原始 spec
    expect(readLedger(dataDir)).toEqual({
      'node_modules/some-pkg': {
        source: 'npm',
        ref: 'some-pkg@^2.1.0',
        id: 'some-pkg',
        installedAt: expect.any(String) as string,
      },
    });
  });

  it('npm 精确版本落账：package.json version + .package-lock.json integrity（dist-tag 不算凭证，落盘的才算）', async () => {
    const dataDir = makeDataDir();
    // 预置装机产物形态（fake runner 不真装——readNpmPin 在 runner 后读盘）
    const pkgDir = join(dataDir, 'apps', 'node_modules', 'some-pkg');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ version: '2.1.3' }));
    writeFileSync(
      join(dataDir, 'apps', '.package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/some-pkg': { integrity: 'sha512-abc=' } } }),
    );
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, gitCommitOf: fakeCommit });

    await apps.install('some-pkg@^2');

    expect(readLedger(dataDir)['node_modules/some-pkg']).toMatchObject({
      version: '2.1.3',
      integrity: 'sha512-abc=',
    });
  });

  it('npm scoped 包名解析：@scope/pkg@1.2 → id=@scope/pkg（不丢 scope 不带版本）', async () => {
    const dataDir = makeDataDir();
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, gitCommitOf: fakeCommit });
    const report = await apps.install('@scope/pkg@1.2.3');
    expect(report.id).toBe('@scope/pkg');
  });

  it('git 源（https .git 尾）：clone 到 host/首段/repo 分层目录，provenance 记源含 commit（注入采集面）', async () => {
    const dataDir = makeDataDir();
    const { calls, runner } = fakeRunner();
    const apps = createAppsService({ dataDir, runner, gitCommitOf: fakeCommit });

    const report = await apps.install('https://github.com/foo/bar.git', { gitRef: 'v1.2' });

    const expectedDir = join(dataDir, 'apps', 'git', 'github.com', 'foo', 'bar');
    expect(report.id).toBe('bar');
    expect(report.appRef).toBe(expectedDir);
    expect(report.source).toBe('git');
    expect(calls).toEqual([
      {
        command: 'git',
        args: ['clone', '--branch', 'v1.2', '--', 'https://github.com/foo/bar.git', expectedDir],
        cwd: dataDir,
      },
    ]);
    // 全源账本落账：键 git/<relDir>，ref+gitRef+commit 双落（update 按账本重走）
    expect(readLedger(dataDir)).toEqual({
      'git/github.com/foo/bar': {
        source: 'git',
        ref: 'https://github.com/foo/bar.git',
        gitRef: 'v1.2',
        id: 'bar',
        commit: 'deadbeef1234',
        installedAt: expect.any(String) as string,
      },
    });
    expect(userRows(dataDir)).toEqual([]); // 仓库态零行
  });

  it('git commit 采集失败容忍：记录缺 commit 键（ref 锁定仍是凭证面——缺席只降精度不阻断）', async () => {
    const dataDir = makeDataDir();
    const apps = createAppsService({
      dataDir,
      runner: fakeRunner().runner,
      gitCommitOf: async () => undefined,
    });
    await apps.install('https://github.com/foo/bar.git');
    expect(Object.hasOwn(readLedger(dataDir)['git/github.com/foo/bar']!, 'commit')).toBe(false);
  });

  it('git 源（git@ 形态、无 ref）：默认分支 clone；重复 install 先清目录（幂等不留半装残骸）', async () => {
    const dataDir = makeDataDir();
    const { calls, runner } = fakeRunner();
    const apps = createAppsService({ dataDir, runner, gitCommitOf: async () => undefined });

    await apps.install('git@gitlab.example.com:group/sub/repo.git');
    // git@ 形态拆解：host / 首路径段 group / repo（深层组取首段防撞名）
    expect(calls[0]!.args).toEqual([
      'clone',
      '--',
      'git@gitlab.example.com:group/sub/repo.git',
      join(dataDir, 'apps', 'git', 'gitlab.example.com', 'group', 'repo'),
    ]);
    // 二装幂等：目录先被清（fake runner 不建目录——用残留哨兵文件验证 rm 发生过）
    const target = join(dataDir, 'apps', 'git', 'gitlab.example.com', 'group', 'repo');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'stale.txt'), '半装残骸');
    await apps.install('git@gitlab.example.com:group/sub/repo.git');
    expect(existsSync(join(target, 'stale.txt'))).toBe(false); // rmSync 先清生效
  });

  it('local 源：直引落 provenance 零子进程；路径不存在即时即响', async () => {
    const dataDir = makeDataDir();
    const { calls, runner } = fakeRunner();
    const apps = createAppsService({ dataDir, runner, gitCommitOf: fakeCommit });
    // 真建本地应用目录（local 面零子进程——calls 必须为空）；绝对路径是最稳的测试
    // 形态（相对形态按进程 cwd 解析，测试 cwd 即仓库根不可控）
    const localDir = join(dataDir, 'my-plugin');
    mkdirSync(localDir);

    const report = await apps.install(localDir);

    expect(calls).toEqual([]); // local = 直引登记，零子进程
    expect(report.source).toBe('local');
    expect(report.appRef).toBe(localDir); // 绝对化（resolve 归一）
    expect(userRows(dataDir)).toEqual([]); // 仓库态零行
    // local 键 = 绝对路径本身（账本键 → 装机物路径的往返一致性：local 原样返回）
    expect(readLedger(dataDir)).toEqual({
      [localDir]: { source: 'local', ref: localDir, id: 'my-plugin', installedAt: expect.any(String) as string },
    });

    // 路径不存在 → COMPOSITION_ROW_INVALID（装不进一条指空的路）
    try {
      await apps.install(join(dataDir, 'no-such-dir'));
      expect.unreachable('不存在的 local 路径应抛');
    } catch (err) {
      expect((err as AppError).code).toBe(COMPOSITION_ROW_INVALID);
    }
  });

  it('装机子进程失败：统一 APP_INSTALL_FAILED，message 载命令与原因；账本不落（失败不记装机）', async () => {
    const dataDir = makeDataDir();
    const { runner } = fakeRunner({ npm: '退出码 1\nENOENT no such package' });
    const apps = createAppsService({ dataDir, runner, gitCommitOf: fakeCommit });

    try {
      await apps.install('ghost-pkg');
      expect.unreachable('子进程失败应抛');
    } catch (err) {
      expect((err as AppError).code).toBe(APP_INSTALL_FAILED);
      expect((err as AppError).message).toContain('npm install');
      expect((err as AppError).message).toContain('ENOENT no such package');
    }
    // 失败装机零落账：行不写、provenance 不记
    expect(userRows(dataDir)).toEqual([]);
    expect(existsSync(join(dataDir, 'apps', 'sources.json'))).toBe(false);
  });
});

/* ---------------- mount / unmount（两态生效动词） ---------------- */

describe('mount / unmount（两态生效动词）', () => {
  /**
   * 造一个 local 应用目录（install 三源里唯一零子进程面——测试最稳形态）：
   * 真建 index.ts（resolveAppEntry 解析依据）+ 可选 loadEntry 替身收割
   * name/events/config（注入边 mock 纪律——与 runner 同层）。
   */
  function setupLocalApp(
    dataDir: string,
    opts: { events?: Array<{ name: string }>; config?: object } = {},
  ): { localDir: string; loadEntry: EntryLoader; emitted: UninstalledEventData[] } {
    const localDir = join(dataDir, 'my-plugin');
    mkdirSync(localDir);
    writeFileSync(join(localDir, 'index.ts'), 'export const name = "my-plugin";\nexport default () => {};\n');
    const loadEntry: EntryLoader = async () => ({
      name: 'my-plugin',
      ...(opts.events === undefined ? {} : { events: opts.events }),
      ...(opts.config === undefined ? {} : { config: opts.config }),
    });
    const emitted: UninstalledEventData[] = [];
    return { localDir, loadEntry, emitted };
  }

  it('mount happy path：写行带 apps 键生效；报告载目标与 appRef，提示 /reload', async () => {
    const dataDir = makeDataDir();
    const { localDir, loadEntry } = setupLocalApp(dataDir);
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, loadEntry });
    await apps.install(localDir);

    const report = await apps.mount('my-plugin', { apps: ['chat'], carrier: 'main' });

    expect(report).toMatchObject({
      id: 'my-plugin',
      apps: ['chat'],
      source: 'local',
      appRef: localDir,
    });
    expect(report.message).toContain('/reload');
    // 行写回：pkg 沿用装机推导（local 绝对路径），apps 键 + sandbox 块（显式降格）落地
    expect(userRows(dataDir)).toEqual([
      { id: 'my-plugin', pkg: localDir, apps: ['chat'], sandbox: { carrier: 'main' } },
    ]);
    // 装机物与账本保留（unmount 后重挂的本钱）
    expect(readLedger(dataDir)[localDir]).toBeDefined();
  });

  it('mount 挂载目标必填：全局作用域 v1 官方专属——无 apps 即拒（第三方挂系统无正路）', async () => {
    const dataDir = makeDataDir();
    const { localDir, loadEntry } = setupLocalApp(dataDir);
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, loadEntry });
    await apps.install(localDir);
    await expect(apps.mount('my-plugin', { carrier: 'main' })).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('--apps'),
    });
  });

  it('mount apps 值域预校验（R4 行为小刀）：未知应用 id 写行前即拒——坏行不落盘（boot 拒启陷阱前移，修复前必红）', async () => {
    const dataDir = makeDataDir();
    const { localDir, loadEntry } = setupLocalApp(dataDir);
    const apps = createAppsService({
      dataDir,
      runner: fakeRunner().runner,
      loadEntry,
      // 在册清单面注入（assembly 正路同源：loadOfficialApps 键集闭包）
      knownAppIds: () => new Set(['chat', 'code']),
    });
    await apps.install(localDir);

    // 混入未知 id：写行前即拒（原形态 = 落盘成功，下次 boot 才被
    // assertRowAppTargets 拒——「错行落盘后 boot 拒启」与 config 面「错配置
    // 不落盘」目标相反，正是本刀前移的陷阱）
    await expect(apps.mount('my-plugin', { apps: ['chat', 'ghost'], carrier: 'main' })).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('ghost'),
    });
    // 坏行不落盘：overlay 零行
    expect(userRows(dataDir)).toEqual([]);
    // 在册 id 照常放行（预校验只挡值域，不是新门）
    await expect(apps.mount('my-plugin', { apps: ['chat'], carrier: 'main' })).resolves.toMatchObject({
      apps: ['chat'],
    });
  });

  it('mount 解冻（R1 复盘批 2026-08-29）：缺 carrier = 闩一缺省 external——成功落行且零 sandbox 块', async () => {
    const dataDir = makeDataDir();
    const { localDir, loadEntry } = setupLocalApp(dataDir);
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, loadEntry });
    await apps.install(localDir);
    // 缺 carrier 不再拒（原「过渡冻结」分支已删）：闩一装载期推 external——
    // 出生即进程墙是缺省态，operator 无需声明
    const report = await apps.mount('my-plugin', { apps: ['chat'] });
    expect(report.message).toContain('external'); // 回执点名缺省载体
    // 落盘零 sandbox 块：缺省不落块是合法形态（闩一按 pkg 引用形分派）
    expect(userRows(dataDir)).toEqual([{ id: 'my-plugin', pkg: localDir, apps: ['chat'] }]);
  });

  it('mount config 对分域行拒写（R1 P0-3）：显式 external / 显式 worker / 缺省 external（闩一）皆拒——宿主不代校验域侧 schema', async () => {
    const dataDir = makeDataDir();
    const schema = Type.Object({ limit: Type.Number() });
    const { localDir, loadEntry } = setupLocalApp(dataDir, { config: schema });
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, loadEntry });
    await apps.install(localDir);
    // 显式 external + config → 拒（修复前：宿主 loadEntry 求值第三方入口 = 主进程
    // jiti 执行第三方码，打穿宪章七进程墙）
    await expect(
      apps.mount('my-plugin', { apps: ['chat'], carrier: 'external', config: { limit: 5 } }),
    ).rejects.toMatchObject({
      code: APP_CONFIG_INVALID,
      message: expect.stringContaining('分域行'),
    });
    // 缺省（闩一即 external）+ config → 同拒
    await expect(apps.mount('my-plugin', { apps: ['chat'], config: { limit: 5 } })).rejects.toMatchObject({
      code: APP_CONFIG_INVALID,
      message: expect.stringContaining('分域行'),
    });
    // 显式 worker + config → 同拒（worker 拒面 R1 前已有，此处三值同锁）
    await expect(
      apps.mount('my-plugin', { apps: ['chat'], carrier: 'worker', config: { limit: 5 } }),
    ).rejects.toMatchObject({
      code: APP_CONFIG_INVALID,
      message: expect.stringContaining('分域行'),
    });
    // 皆拒且不写行
    expect(userRows(dataDir)).toEqual([]);
    // 对照：显式 main + 合法 config 仍走宿主校验落盘（main 路不受影响）
    await apps.mount('my-plugin', { apps: ['chat'], carrier: 'main', config: { limit: 5 } });
    expect(userRows(dataDir)).toEqual([
      { id: 'my-plugin', pkg: localDir, apps: ['chat'], sandbox: { carrier: 'main' }, config: { limit: 5 } },
    ]);
  });

  it('mount apps 数组：多值 = 共享件一行投多应用（行写回数组原样、报告全列）', async () => {
    const dataDir = makeDataDir();
    const { localDir, loadEntry } = setupLocalApp(dataDir);
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, loadEntry });
    await apps.install(localDir);

    const report = await apps.mount('my-plugin', { apps: ['chat', 'hermes'], carrier: 'main' });

    expect(report.apps).toEqual(['chat', 'hermes']); // 回执全列（共享面一眼可辨）
    expect(userRows(dataDir)).toEqual([
      { id: 'my-plugin', pkg: localDir, apps: ['chat', 'hermes'], sandbox: { carrier: 'main' } },
    ]);
  });

  it('mount 未知装机 id / 同 id 歧义（账本唯一事实源——缺失与多条皆响亮）', async () => {
    const dataDir = makeDataDir();
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, gitCommitOf: fakeCommit });
    await expect(apps.mount('ghost', { apps: ['chat'], carrier: 'main' })).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('未知装机 id'),
    });
    // 歧义：npm 包 some-pkg + git repo 同名 some-pkg 两条记录
    await apps.install('some-pkg');
    await apps.install('https://github.com/x/some-pkg.git');
    await expect(apps.mount('some-pkg', { apps: ['chat'], carrier: 'main' })).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('歧义'),
    });
  });

  it('mount 同包两应用：rowId 显式命名第二行（行 id 是行键不是包键）+ 词表账本补齐行数据根', async () => {
    const dataDir = makeDataDir();
    const { localDir, loadEntry } = setupLocalApp(dataDir, { events: [{ name: 'demo/one' }] });
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, loadEntry });
    await apps.install(localDir);

    await apps.mount('my-plugin', { apps: ['chat'], carrier: 'main' });
    const second = await apps.mount('my-plugin', { apps: ['hermes'], carrier: 'main', rowId: 'my-plugin-2' });

    expect(second.id).toBe('my-plugin-2'); // 行 id = 显式命名（非装机 id）
    expect(userRows(dataDir)).toEqual([
      { id: 'my-plugin', pkg: localDir, apps: ['chat'], sandbox: { carrier: 'main' } },
      { id: 'my-plugin-2', pkg: localDir, apps: ['hermes'], sandbox: { carrier: 'main' } },
    ]);
    // 自定义行 id 词表账本对齐：uninstall 检视词表档不缺角（行数据根也有 data.json）
    expect(existsSync(join(dataDir, 'apps', 'my-plugin-2', 'data.json'))).toBe(true);
  });

  it('mount 收割按载体分派（R1 复盘批二 11c）：分域行补档零宿主 loadEntry——复制装机档到行数据根；main 行照旧宿主收割（修复前必红）', async () => {
    const dataDir = makeDataDir();
    const { localDir, loadEntry } = setupLocalApp(dataDir, { events: [{ name: 'demo/one' }] });
    // 宿主执行计数器（分域行入口禁宿主求值——打穿宪章七的路径必须零调用）
    let hostLoads = 0;
    const countingLoader: EntryLoader = async (entry) => {
      hostLoads += 1;
      return loadEntry(entry);
    };
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, loadEntry: countingLoader });
    await apps.install(localDir); // 装机通尾收割（1 次宿主装载——装机显式信任前提）
    const afterInstall = hostLoads;
    expect(afterInstall).toBe(1);

    // 分域行（缺省闩一 external）显式 rowId：补档 = 复制装机档，零宿主装载
    //（修复前：refreshLedger 对行入口走宿主 loadEntry → +1 必红）
    await apps.mount('my-plugin', { apps: ['chat'], rowId: 'my-plugin-ext' });
    expect(hostLoads).toBe(afterInstall);
    // 行数据根补档内容 = 装机档原样复制（词表是包属性非行属性——同包多行同词表）
    expect(readFileSync(join(dataDir, 'apps', 'my-plugin-ext', 'data.json'), 'utf8')).toBe(
      readFileSync(join(dataDir, 'apps', 'my-plugin', 'data.json'), 'utf8'),
    );
    expect(
      JSON.parse(readFileSync(join(dataDir, 'apps', 'my-plugin-ext', 'data.json'), 'utf8')).declaredEvents,
    ).toEqual(['demo/one']);

    // 对照：main 行显式 rowId 照旧宿主收割（main 域本就宿主进程执行——信任面内）
    await apps.mount('my-plugin', { apps: ['hermes'], carrier: 'main', rowId: 'my-plugin-main' });
    expect(hostLoads).toBe(afterInstall + 1);

    // 装机档缺席兜底（异常形态——install 通尾必落档，手删模拟损坏）：行根落
    // null 档，检视面按 unknown 档最坏假设警示
    rmSync(join(dataDir, 'apps', 'my-plugin', 'data.json'));
    await apps.mount('my-plugin', { apps: ['goal'], rowId: 'my-plugin-orphan' });
    expect(JSON.parse(readFileSync(join(dataDir, 'apps', 'my-plugin-orphan', 'data.json'), 'utf8'))).toEqual({
      app: 'my-plugin-orphan',
      declaredEvents: null,
    });
  });

  it('mount 撞名双层拒：overlay 同 id 行 / 官方默认层同 id 行（replace-via-mount 皆拒）', async () => {
    const dataDir = makeDataDir();
    const { localDir, loadEntry } = setupLocalApp(dataDir);
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, loadEntry });
    await apps.install(localDir);
    await apps.mount('my-plugin', { apps: ['chat'], carrier: 'main' });
    // overlay 撞名
    await expect(apps.mount('my-plugin', { apps: ['hermes'], carrier: 'main' })).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('已被占用'),
    });
    // 官方默认层撞名（rowId 命中官方行 id）
    await expect(apps.mount('my-plugin', { apps: ['chat'], carrier: 'main', rowId: 'memory' })).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('官方默认层'),
    });
  });

  it('mount config 校验：schema 过则随行落盘；不过/未声明/校验面不可得皆拒不写（防 boot 拒启陷阱）', async () => {
    const dataDir = makeDataDir();
    const schema = Type.Object({ limit: Type.Number() });
    const { localDir, loadEntry } = setupLocalApp(dataDir, { config: schema });
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, loadEntry });
    await apps.install(localDir);

    // 合法 config：随行落盘
    await apps.mount('my-plugin', { apps: ['chat'], carrier: 'main', config: { limit: 5 } });
    expect(userRows(dataDir)).toEqual([
      { id: 'my-plugin', pkg: localDir, apps: ['chat'], sandbox: { carrier: 'main' }, config: { limit: 5 } },
    ]);

    // schema 不过：拒且不写行（配置面不变——重挂不携带即可）
    await apps.unmount('my-plugin');
    await expect(
      apps.mount('my-plugin', { apps: ['chat'], carrier: 'main', config: { limit: 'x' } }),
    ).rejects.toMatchObject({
      code: APP_CONFIG_INVALID,
    });
    expect(userRows(dataDir)).toEqual([]);

    // 应用未声明 config schema：携带即拒（装载面不可校验）
    const bare = makeDataDir();
    const bareSetup = setupLocalApp(bare); // 无 config 声明
    const bareApps = createAppsService({
      dataDir: bare,
      runner: fakeRunner().runner,
      loadEntry: bareSetup.loadEntry,
    });
    await bareApps.install(bareSetup.localDir);
    await expect(
      bareApps.mount('my-plugin', { apps: ['chat'], carrier: 'main', config: { a: 1 } }),
    ).rejects.toMatchObject({
      code: APP_CONFIG_INVALID,
      message: expect.stringContaining('未声明'),
    });

    // 校验面不可得（宿主未注入 loadEntry）：拒绝带非空 config 的写——宁拒不误读
    const noEntry = createAppsService({ dataDir: bare, runner: fakeRunner().runner });
    await expect(
      noEntry.mount('my-plugin', { apps: ['chat'], carrier: 'main', config: { a: 1 } }),
    ).rejects.toMatchObject({
      code: APP_CONFIG_INVALID,
    });
  });

  it('unmount：删行保码——行删·装机物与账本留；重挂可再走 mount', async () => {
    const dataDir = makeDataDir();
    const { localDir, loadEntry } = setupLocalApp(dataDir);
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, loadEntry });
    await apps.install(localDir);
    await apps.mount('my-plugin', { apps: ['chat'], carrier: 'main' });

    const report = await apps.unmount('my-plugin');

    expect(report.id).toBe('my-plugin');
    expect(report.message).toContain('重挂');
    expect(userRows(dataDir)).toEqual([]); // 行删
    expect(readLedger(dataDir)[localDir]).toBeDefined(); // 账本留（装机物同理——local 本就直引）

    // 重挂：mount 再走一遍（删行保码的兑现）
    await apps.mount('my-plugin', { apps: ['hermes'], carrier: 'main' });
    expect(userRows(dataDir)).toEqual([
      { id: 'my-plugin', pkg: localDir, apps: ['hermes'], sandbox: { carrier: 'main' } },
    ]);
  });

  it('unmount 未知行 / 官方默认层行：响亮拒绝（官方行不可卸挂载）', async () => {
    const dataDir = makeDataDir();
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner });
    await expect(apps.unmount('ghost')).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('overlay 无此行'),
    });
    await expect(apps.unmount('memory')).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('官方默认层行不可卸挂载'),
    });
  });

  it('unmount 受影响会话警示：词表账本档 + 注入计数逐词点名（uninstall inspect 同款推导）', async () => {
    const dataDir = makeDataDir();
    const { localDir, loadEntry } = setupLocalApp(dataDir, { events: [{ name: 'demo/one' }] });
    const apps = createAppsService({
      dataDir,
      runner: fakeRunner().runner,
      loadEntry,
      affectedSessionCounts: async () => ({ 'demo/one': 3 }),
    });
    await apps.install(localDir);
    await apps.mount('my-plugin', { apps: ['chat'], carrier: 'main' });

    const report = await apps.unmount('my-plugin');
    expect(report.warnings.some((w) => w.includes('demo/one') && w.includes('3'))).toBe(true);
  });
});

/* ---------------- toggle / update（update 键域 = 装机 id） ---------------- */

describe('toggle 与 update', () => {
  it('toggle 翻转挂载行禁用状态（持久化半边语义在 composition.test 已锁——此处验服务面回传）', async () => {
    const dataDir = makeDataDir();
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, gitCommitOf: fakeCommit });
    await apps.install('some-pkg');
    await apps.mount('some-pkg', { apps: ['chat'], carrier: 'main' }); // toggle 吃行——两态下先挂载

    expect(apps.toggle('some-pkg')).toBe(true); // → 禁用
    expect(userRows(dataDir)).toEqual([
      { id: 'some-pkg', pkg: 'some-pkg', apps: ['chat'], sandbox: { carrier: 'main' }, disabled: true },
    ]);
    expect(apps.toggle('some-pkg')).toBe(false); // → 启用（删键）
    expect(userRows(dataDir)).toEqual([
      { id: 'some-pkg', pkg: 'some-pkg', apps: ['chat'], sandbox: { carrier: 'main' } },
    ]);
  });

  it('update 按源分派（键域 = 装机 id——仓库态未挂载件同样可更新）：npm 重装 / git 按账本 ref 重克隆 / local no-op', async () => {
    const dataDir = makeDataDir();
    const localDir = join(dataDir, 'my-plugin');
    mkdirSync(localDir);
    const { calls, runner } = fakeRunner();
    const apps = createAppsService({ dataDir, runner, gitCommitOf: fakeCommit });
    await apps.install('some-pkg');
    await apps.install('https://github.com/foo/bar.git', { gitRef: 'v1' });
    await apps.install(localDir);
    // 零挂载——D2 键域迁装机 id 后 update 不再依赖行在场
    expect(userRows(dataDir)).toEqual([]);
    calls.length = 0; // 装机调用已断言过——update 阶段从零记

    // npm 源：按账本原 ref 重装（重新解析版本）
    const npmReport = await apps.update('some-pkg');
    expect(npmReport.source).toBe('npm');
    expect(calls.at(-1)).toEqual({
      command: 'npm',
      args: ['install', '--prefix', join(dataDir, 'apps'), '--legacy-peer-deps', '--omit=peer', 'some-pkg'],
      cwd: dataDir,
    });

    // git 源：删目录按账本 gitRef 重克隆（branch=v1 来自 provenance 记录，非记忆）
    const gitDir = join(dataDir, 'apps', 'git', 'github.com', 'foo', 'bar');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'old-checkout.txt'), '旧检出');
    const gitReport = await apps.update('bar');
    expect(gitReport.source).toBe('git');
    expect(calls.at(-1)).toEqual({
      command: 'git',
      args: ['clone', '--branch', 'v1', '--', 'https://github.com/foo/bar.git', gitDir],
      cwd: dataDir,
    });
    expect(existsSync(join(gitDir, 'old-checkout.txt'))).toBe(false); // 先删后克隆

    // local 源：no-op（零子进程）——但账本仍重收割（词表随磁盘代码漂移对齐）
    const localCallsBefore = calls.length;
    const localReport = await apps.update('my-plugin');
    expect(localReport.source).toBe('local');
    expect(localReport.message).toContain('改动');
    expect(calls.length).toBe(localCallsBefore);
  });

  it('update 未知装机 id：COMPOSITION_ROW_INVALID（键域已迁——行 id 不再是 update 的钥匙）', async () => {
    const dataDir = makeDataDir();
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, gitCommitOf: fakeCommit });
    await expect(apps.update('ghost')).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('未知装机 id'),
    });
  });

  it('update 歧义：同 id 多条装机记录（同包多源）——点名记录键，不做「猜一条」', async () => {
    const dataDir = makeDataDir();
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, gitCommitOf: fakeCommit });
    await apps.install('some-pkg');
    await apps.install('https://github.com/x/some-pkg.git');
    await expect(apps.update('some-pkg')).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('歧义'),
    });
  });
});

/* ---------------- 装机面安全（隔离案一第一刀：P33 路径穿越 + P32 子进程护栏） ---------------- */

describe('装机面安全（隔离案一第一刀 #15/#16）', () => {
  /**
   * 独立沙箱：root 下建 data 数据目录与 canary 哨兵——穿越 rmSync 若可达，
   * `git@..:../..` 形态归一后落在 root 本身，哨兵必被抹掉（红转绿的爆炸半径证明）。
   */
  function makeSandbox(): { root: string; dataDir: string; canary: string } {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-apps-sec-')));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const canary = join(root, 'canary.txt');
    writeFileSync(canary, '数据目录父级哨兵——穿越删除若可达必先抹掉我');
    return { root, dataDir, canary };
  }

  it('P33 表驱动子弹：穿越/不安全段 URL 全拒（COMPOSITION_ROW_INVALID），哨兵完好', async () => {
    // 修复前 `git@..:../..` 拼出 relDir `../../..` → install 幂等 rmSync 整删数据目录父级
    const bullets = [
      'git@..:../..', // host 与路径段全是 ..——最烈形态（修复前可整删家园）
      'git@..:a/b', // host 为 ..（relDir=../a/b 逃出 git 子树）
      'git@host:../escape.git', // 首路径段 ..
      'git@github.com:foo/../bar.git', // 中段 ..
      'git@github.com:fo o/bar.git', // 段内空格（字符集白名单外）
      'https://github.com/foo/bar%2E%2E.git', // 编码形态 ..（%2E%2E）——字符集白名单连带拦住
    ];
    for (const url of bullets) {
      const { dataDir, canary } = makeSandbox();
      const apps = createAppsService({
        dataDir,
        runner: fakeRunner().runner,
        gitCommitOf: async () => undefined,
      });
      try {
        await apps.install(url);
        expect.unreachable(`穿越子弹应拒：${url}`);
      } catch (err) {
        expect((err as AppError).code).toBe(COMPOSITION_ROW_INVALID);
      }
      expect(existsSync(canary)).toBe(true); // 数据目录父级哨兵完好
    }
  });

  it('P33 纵深（update 面）：账本定位串手改越界——拒绝且目标目录完好、记录不被误清', async () => {
    const { dataDir } = makeSandbox();
    // 手改全源账本：定位串带字面 `../`（归一后逃出 git 子树——模拟污染的
    // sources.json）。注意不可用 join 拼——join 会词法归一掉 `..`，恶意形态须
    // 手工拼串原样落盘。防线按归一路径执法不看字面。
    const escapeDir = join(dataDir, 'apps', 'escape');
    mkdirSync(escapeDir, { recursive: true });
    writeFileSync(join(escapeDir, 'victim.txt'), '越界 rmSync 的潜在受害者');
    mkdirSync(join(dataDir, 'apps'), { recursive: true });
    writeFileSync(
      join(dataDir, 'apps', 'sources.json'),
      JSON.stringify({ 'git/../escape': { source: 'git', ref: 'git@h:o/r.git', id: 'evil' } }),
    );
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, gitCommitOf: async () => undefined });

    try {
      await apps.update('evil');
      expect.unreachable('越界引用应拒');
    } catch (err) {
      expect((err as AppError).code).toBe(COMPOSITION_ROW_INVALID);
      expect((err as AppError).message).toContain('越界');
    }
    expect(existsSync(join(escapeDir, 'victim.txt'))).toBe(true); // 目标目录完好
    // 账本记录不被误清（防线先于删目录与删记录——失败路径零副作用）
    expect(readLedger(dataDir)['git/../escape']).toBeDefined();
  });

  it('P32 超时硬顶：卡死子进程被强杀，拒绝消息带超时说明（修复前永挂）', async () => {
    await expect(
      spawnRunner(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: process.cwd(), timeoutMs: 200 }),
    ).rejects.toThrow(/超时.*强杀/u);
  });

  it('P32 输出滚动尾窗：超 1MiB 截断保尾，失败消息含标注与尾部标记', async () => {
    // 子进程写完留 600ms 排空窗再退出——process.exit 不等写队列，立刻退会连
    // 未冲刷输出一并丢掉（Node 语义），截断分支需要子进程活着把 3MiB 流完
    const script =
      'process.stderr.write("a".repeat(3 * 1024 * 1024) + "TAILMARK"); setTimeout(() => process.exit(1), 600)';
    const err = await spawnRunner(process.execPath, ['-e', script], { cwd: process.cwd() }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('退出码 1');
    expect(err!.message).toContain('已截断'); // 截断标注如实呈现
    expect(err!.message).toContain('TAILMARK'); // 尾部保诊断
    expect(err!.message.length).toBeLessThan(2 * 1024 * 1024); // 无界积累已封顶
  });
});

/* ---------------- npm 装机平台归一（遗漏大扫 20260901 O-7） ---------------- */

describe('npm 装机平台归一（遗漏大扫 20260901 O-7）：win32 裸 spawn npm 必败修死', () => {
  it('plan 四象限：win32 cli 在场 → execPath 直跑（零 shell）；win32 缺席 → npm.cmd+shell；unix 在场 → execPath 直跑；unix 缺席 → 裸 npm 照旧', () => {
    // win32 官方布局：node_modules 与 node.exe 同目录（第二候选命中）。
    // 路径用正斜杠书写——join/dirname 的分隔符处理是宿主平台语义，纯函数
    // 测的是候选序与 shell 判型，不锁 win32 分隔符形
    const winNode = 'C:/Program Files/nodejs/node.exe';
    const winCli = 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js';
    expect(npmSpawnPlan('win32', winNode, (p) => p === winCli)).toEqual({
      command: winNode,
      args: [winCli],
      shell: false,
    });
    // win32 cli 全缺席（拆包布局）→ 回退 npm.cmd + shell（CVE-2024-27980 后
    // .cmd 无 shell 直接 EINVAL——upgrade.ts 自升级同款）
    expect(npmSpawnPlan('win32', winNode, () => false)).toEqual({
      command: 'npm.cmd',
      args: [],
      shell: true,
    });
    // unix 官方/Homebrew/nvm 布局：../lib/node_modules（第一候选命中）
    const macNode = '/opt/homebrew/bin/node';
    const macCli = '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js';
    expect(npmSpawnPlan('darwin', macNode, (p) => p === macCli)).toEqual({
      command: macNode,
      args: [macCli],
      shell: false,
    });
    // unix 拆包（Debian nodejs/npm 分包等）→ 裸 npm 照旧（PATH 解析——既有可跑面不动）
    expect(npmSpawnPlan('linux', '/usr/bin/node', () => false)).toEqual({
      command: 'npm',
      args: [],
      shell: false,
    });
  });

  it('spawnRunner 接线：npm 命令过 plan 归一（同步可断言），非 npm 命令原样透传', async () => {
    // 录制型 spawn：立即 0 退出收场（不出真子进程——接线面断言）
    const seen: Array<{ command: string; args: string[]; shell: boolean | undefined }> = [];
    const rec = ((command: string, args: readonly string[], opts: { shell?: boolean }) => {
      seen.push({ command, args: [...args], shell: opts.shell });
      // 结构面替身：EventEmitter 骨架 + stdout/stderr 挂点 + 微任务 0 退出
      const fake = new EventEmitter() as unknown as Record<string, unknown>;
      fake['stdout'] = new EventEmitter();
      fake['stderr'] = new EventEmitter();
      queueMicrotask(() => (fake as unknown as EventEmitter).emit('close', 0));
      return fake as unknown as ChildProcess;
    }) as unknown as typeof spawn;
    // npm 腿：命令面 = 本机 plan（execPath 形或裸 npm——与本机真实布局一致即接线成立）
    const npmRun = spawnRunner('npm', ['install', '--legacy-peer-deps'], {
      cwd: process.cwd(),
      spawnFn: rec,
    });
    void npmRun.catch(() => undefined); // 红期护栏：旧码无注入面时真 spawn 的 reject 不成孤儿
    expect(seen).toHaveLength(1);
    const plan = npmSpawnPlan(process.platform, process.execPath, (p) => existsSync(p));
    expect(seen[0]!.command).toBe(plan.command);
    expect(seen[0]!.args).toEqual([...plan.args, 'install', '--legacy-peer-deps']);
    expect(seen[0]!.shell).toBe(plan.shell);
    await npmRun;
    // 非 npm 腿：原样透传（git/local 等既有调用面零变化）
    seen.length = 0;
    const gitRun = spawnRunner('git', ['clone', 'x'], { cwd: process.cwd(), spawnFn: rec });
    await gitRun;
    expect(seen).toEqual([{ command: 'git', args: ['clone', 'x'], shell: undefined }]);
  });
});

/* ---------------- list 与 applyLoad（有状态单例 + 仓库态差集） ---------------- */

describe('list 与 applyLoad（boot 与 /reload 同一实例就地更新）', () => {
  it('applyLoad 回灌装载状态：activated/failed/skipped 映射 + planned 兜底 + 行序 = 组合树序', async () => {
    const dataDir = makeDataDir();
    const { runner } = fakeRunner();
    const apps = createAppsService({ dataDir, runner, gitCommitOf: fakeCommit });
    await apps.install('ok-pkg');
    await apps.mount('ok-pkg', { apps: ['chat'], carrier: 'main' }); // 两态：装载态清单吃行——先挂载
    await apps.install('dormant-pkg');
    await apps.mount('dormant-pkg', { apps: ['chat'], carrier: 'main' });
    apps.toggle('dormant-pkg'); // → 禁用
    // 组合树含官方默认层十七行（本测试无官方件注册表 → unresolved/planned）——滤除
    // 只留用户行：本测试锁 applyLoad 映射语义，官方行装载态在 assembly 全栈锁
    const composition = loadCompositionFor(dataDir);
    const userComposition = {
      ...composition,
      plan: composition.plan.filter(
        (row) =>
          row.id !== 'chat' &&
          row.id !== 'memory' &&
          row.id !== 'subagent' &&
          row.id !== 'goal' &&
          row.id !== 'scheduler' &&
          row.id !== 'mcp' &&
          row.id !== 'tools' &&
          row.id !== 'web' &&
          row.id !== 'compaction' &&
          row.id !== 'admin' &&
          row.id !== 'checkpoint' &&
          row.id !== 'lsp' &&
          row.id !== 'channels' &&
          row.id !== 'webui' &&
          row.id !== 'obs' &&
          row.id !== 'browser' &&
          row.id !== 'desktop' &&
          row.id !== 'assistant',
      ),
    };

    apps.applyLoad(userComposition, {
      activated: [{ id: 'ok-pkg', name: 'stub', applyMs: 1 }],
      failed: [],
      skipped: [{ id: 'dormant-pkg', reason: 'disabled' }],
    });
    // applyMs 为装载计时（刀〇a 打点面）——activated 行带值，toMatchObject 不断言精确数
    expect(apps.list()).toMatchObject([
      { id: 'ok-pkg', status: 'activated', name: 'stub' },
      { id: 'dormant-pkg', status: 'skipped', reason: 'disabled' },
    ]);

    // /reload 后再次回灌：同实例新状态（旧状态整体替换——不留陈旧行）
    apps.applyLoad(userComposition, {
      activated: [],
      failed: [{ id: 'ok-pkg', code: 'APP_APPLY_FAILED', message: '炸了' }],
      skipped: [{ id: 'dormant-pkg', reason: 'disabled' }],
    });
    expect(apps.list().map((row) => [row.id, row.status])).toEqual([
      ['ok-pkg', 'failed'],
      ['dormant-pkg', 'skipped'],
    ]);

    // boot 前视角：plan 空（装载未发生）——仓库态差集仍按账本可见（全部装机
    // 物呈现 installed-unmounted——applyLoad 回灌合成行后差集才收敛；真装配
    // 序里 applyLoad 紧随 boot，此窗口仅测试面可见）
    const fresh = createAppsService({ dataDir, runner });
    expect(fresh.list()).toEqual([
      { id: 'dormant-pkg', status: 'installed-unmounted', source: 'npm' },
      { id: 'ok-pkg', status: 'installed-unmounted', source: 'npm' },
    ]);
    fresh.applyLoad(userComposition, emptyLoad);
    expect(fresh.list().map((row) => [row.id, row.status])).toEqual([
      ['ok-pkg', 'planned'],
      ['dormant-pkg', 'planned'],
    ]);
  });

  it('markFailed：清单在册行整行替换为 failed 形态（不合并旧字段）；ghost 行 no-op 不增行', async () => {
    const dataDir = makeDataDir();
    const { runner } = fakeRunner();
    const apps = createAppsService({ dataDir, runner, gitCommitOf: fakeCommit });
    await apps.install('ok-pkg');
    await apps.mount('ok-pkg', { apps: ['chat'], carrier: 'main' });
    await apps.install('dormant-pkg');
    await apps.mount('dormant-pkg', { apps: ['chat'], carrier: 'main' });
    apps.toggle('dormant-pkg'); // → 禁用（skipped 态行——混合前态的另一腿）
    const composition = loadCompositionFor(dataDir);
    const userComposition = {
      ...composition,
      plan: composition.plan.filter(
        (row) =>
          row.id !== 'chat' &&
          row.id !== 'memory' &&
          row.id !== 'subagent' &&
          row.id !== 'goal' &&
          row.id !== 'scheduler' &&
          row.id !== 'mcp' &&
          row.id !== 'tools' &&
          row.id !== 'web' &&
          row.id !== 'compaction' &&
          row.id !== 'admin' &&
          row.id !== 'checkpoint' &&
          row.id !== 'lsp' &&
          row.id !== 'channels' &&
          row.id !== 'webui' &&
          row.id !== 'obs' &&
          row.id !== 'browser' &&
          row.id !== 'desktop' &&
          row.id !== 'assistant',
      ),
    };
    // 混合前态：一 activated + 一 skipped——域死不挑前态，任一在册行可转
    apps.applyLoad(userComposition, {
      activated: [{ id: 'ok-pkg', name: 'stub', applyMs: 1 }],
      failed: [],
      skipped: [{ id: 'dormant-pkg', reason: 'disabled' }],
    });

    // 域死结算（BRIDGE_WORKER_EXITED 形态）→ failed 整行替换：activated 前态的
    // name/applyMs 不残留（非合并——与 applyLoad 失败分支同形，面收敛一个形态）
    apps.markFailed('ok-pkg', 'BRIDGE_WORKER_EXITED', '域死');
    const rows = apps.list();
    expect(rows).toMatchObject([
      { id: 'ok-pkg', status: 'failed', code: 'BRIDGE_WORKER_EXITED', message: '域死' },
      { id: 'dormant-pkg', status: 'skipped', reason: 'disabled' },
    ]);
    const failedRow = rows[0]!;
    expect('name' in failedRow).toBe(false); // 整行替换非合并——旧字段零残留
    expect('applyMs' in failedRow).toBe(false);

    // ghost 行（不在清单）→ no-op：不增行、不抛错、清单原样
    apps.markFailed('ghost-row', 'BRIDGE_WORKER_EXITED', '幽灵');
    expect(apps.list().length).toBe(2);
    expect(apps.list().map((row) => row.id)).toEqual(['ok-pkg', 'dormant-pkg']);
  });

  it('list 仓库态差集（installed-unmounted）：装了没挂不可静默——挂载后差集收敛、卸挂后回露', async () => {
    const dataDir = makeDataDir();
    const { runner } = fakeRunner();
    const apps = createAppsService({ dataDir, runner, gitCommitOf: fakeCommit });
    await apps.install('some-pkg');

    // 仓库态件（无 plan 也可见——差集按账本算，与装载态无关）
    expect(apps.list()).toEqual([{ id: 'some-pkg', status: 'installed-unmounted', source: 'npm' }]);

    // 挂载 + 回灌：行进 plan（planned 兜底；fake runner 未真装 → 入口 unresolved，
    // source 推导缺席是事实呈现），差集收敛（同包归一键已挂载）
    await apps.mount('some-pkg', { apps: ['chat'], carrier: 'main' });
    apps.applyLoad(loadCompositionFor(dataDir), emptyLoad);
    const mounted = apps.list().filter((row) => row.id === 'some-pkg');
    expect(mounted).toEqual([{ id: 'some-pkg', status: 'planned' }]);
    expect(apps.list().some((row) => row.status === 'installed-unmounted')).toBe(false);

    // 卸挂载：行删（plan 不再含）→ 差集回露（装机面断头路警示位）
    await apps.unmount('some-pkg');
    apps.applyLoad(loadCompositionFor(dataDir), emptyLoad);
    expect(apps.list().filter((row) => row.id === 'some-pkg')).toEqual([
      { id: 'some-pkg', status: 'installed-unmounted', source: 'npm' },
    ]);
  });
});

/* ---------------- uninstall 双相四段（契约篇 §3.4 第二刀；键域 = 装机 id） ---------------- */

describe('uninstall 双相四段', () => {
  /**
   * 造一带词表账本的 local 应用装机（install 三源里唯一零子进程面——测试最稳
   * 形态）：真建 index.ts（resolveAppEntry 解析依据）+ 注入 loadEntry 替身
   * 收割 name/events（注入边 mock 纪律——与 runner 同层）。
   */
  function setupLocalApp(
    dataDir: string,
    events: Array<{ name: string }>,
  ): {
    localDir: string;
    loadEntry: EntryLoader;
    emitted: UninstalledEventData[];
  } {
    const localDir = join(dataDir, 'my-plugin');
    mkdirSync(localDir);
    writeFileSync(join(localDir, 'index.ts'), 'export const name = "my-plugin";\nexport default () => {};\n');
    const loadEntry: EntryLoader = async () => ({
      name: 'my-plugin',
      events,
    });
    const emitted: UninstalledEventData[] = [];
    return { localDir, loadEntry, emitted };
  }

  it('词表账本：install 收割落 data.json；三档判读 live/ledger/unknown（早于账本/损坏/收割失败）', async () => {
    const dataDir = makeDataDir();
    const { runner } = fakeRunner();
    const { localDir, loadEntry } = setupLocalApp(dataDir, [{ name: 'demo/one' }, { name: 'demo/two' }]);
    const apps = createAppsService({ dataDir, runner, loadEntry });
    await apps.install(localDir);

    // 账本落盘：声明名 + 词名清单（双键一桥宿主写面首建）
    const ledger = JSON.parse(readFileSync(join(dataDir, 'apps', 'my-plugin', 'data.json'), 'utf8')) as {
      app: string;
      declaredEvents: string[];
    };
    expect(ledger).toEqual({ app: 'my-plugin', declaredEvents: ['demo/one', 'demo/two'] });

    // 未装载（无 applyLoad）→ ledger 档（账本是唯一来源）
    const before = await apps.uninstall('my-plugin', { mode: 'inspect' });
    expect(before.events).toEqual({ origin: 'ledger', names: ['demo/one', 'demo/two'] });

    // applyLoad 回灌活词表 → live 档优先（activated 载荷 events 收割）
    const composition = loadCompositionFor(dataDir);
    apps.applyLoad(composition, {
      activated: [{ id: 'my-plugin', name: 'my-plugin', applyMs: 1, events: ['demo/one', 'demo/two'] }],
      failed: [],
      skipped: [],
    });
    const live = await apps.uninstall('my-plugin', { mode: 'inspect' });
    expect(live.events).toEqual({ origin: 'live', names: ['demo/one', 'demo/two'] });

    // 账本损坏（坏 JSON）→ unknown 档（损坏注记）；活档在场时恒优先，故用未
    // applyLoad 的实例验账本档读径（同盘不同服务——账本是磁盘事实非内存态）
    writeFileSync(join(dataDir, 'apps', 'my-plugin', 'data.json'), '{oops');
    const corruptService = createAppsService({ dataDir, runner });
    const corruptView = await corruptService.uninstall('my-plugin', { mode: 'inspect' });
    expect(corruptView.events.origin).toBe('unknown');
    expect(corruptView.events.note).toContain('损坏');

    // 旧词汇域账本（认领键 plugin→app 改名前写入，critic #2）→ unknown 档但注记
    // 可区分：说「旧词汇域 + 重装再生」的真话，不误报损坏（修复前此断言红——
    // 旧键文件被归入损坏档）
    writeFileSync(
      join(dataDir, 'apps', 'my-plugin', 'data.json'),
      JSON.stringify({ plugin: 'my-plugin', declaredEvents: ['demo/one'] }),
    );
    const oldKeyService = createAppsService({ dataDir, runner });
    const oldKeyView = await oldKeyService.uninstall('my-plugin', { mode: 'inspect' });
    expect(oldKeyView.events.origin).toBe('unknown');
    expect(oldKeyView.events.note).toContain('旧词汇域');
    expect(oldKeyView.events.note).toContain('重装');

    // 杂交档（旧认领键与新认领键同在 = 手改杂交）→ 损坏档：规范 :544 四分支
    // 实文——拒绝静默忽略任一键的读法（修前红锚：同在且新键形状合法时被当
    // ledger 档读走、旧键静默忽略——注释与规范都说 corrupt 而实码放行）
    writeFileSync(
      join(dataDir, 'apps', 'my-plugin', 'data.json'),
      JSON.stringify({ plugin: 'my-plugin', app: 'my-plugin', declaredEvents: ['demo/one'] }),
    );
    const hybridService = createAppsService({ dataDir, runner });
    const hybridView = await hybridService.uninstall('my-plugin', { mode: 'inspect' });
    expect(hybridView.events.origin).toBe('unknown');
    expect(hybridView.events.note).toContain('损坏');

    // 形状非法档（合法 JSON 但新认领键非字符串——如 {app: 123}）→ 损坏档：
    // readDataDescriptor 的 corrupt 分支不止吃坏 JSON，形状不符同归（四态判读
    // 的第三态完整面——此前仅坏 JSON 被测到）
    writeFileSync(join(dataDir, 'apps', 'my-plugin', 'data.json'), JSON.stringify({ app: 123 }));
    const badShapeService = createAppsService({ dataDir, runner });
    const badShapeView = await badShapeService.uninstall('my-plugin', { mode: 'inspect' });
    expect(badShapeView.events.origin).toBe('unknown');
    expect(badShapeView.events.note).toContain('损坏');

    // 账本前存量装机（手写 provenance 记录无 data.json——pre-D2/手账形态）→
    // unknown 档（早于账本注记）
    const legacyData = makeDataDir();
    const legacyDir = join(legacyData, 'legacy-plugin');
    mkdirSync(legacyDir);
    writeFileSync(join(legacyDir, 'index.ts'), 'export const name = "legacy";\nexport default () => {};\n');
    mkdirSync(join(legacyData, 'apps'), { recursive: true });
    writeFileSync(
      join(legacyData, 'apps', 'sources.json'),
      JSON.stringify({ [legacyDir]: { source: 'local', ref: legacyDir, id: 'legacy-plugin' } }),
    );
    const legacyApps = createAppsService({ dataDir: legacyData, runner });
    const legacyView = await legacyApps.uninstall('legacy-plugin', { mode: 'inspect' });
    expect(legacyView.events.origin).toBe('unknown');
    expect(legacyView.events.note).toContain('早于词表账本');

    // 收割失败（loadEntry 抛）→ 账本 declaredEvents=null → unknown 档（收割失败注记）
    const failDir = join(dataDir, 'fail-plugin');
    mkdirSync(failDir);
    writeFileSync(join(failDir, 'index.ts'), 'export const name = "fail";\nexport default () => {};\n');
    const throwing: EntryLoader = async () => {
      throw new Error('装载炸了');
    };
    const failApps = createAppsService({ dataDir, runner, loadEntry: throwing });
    await failApps.install(failDir); // 收割失败不阻断装机
    const failView = await failApps.uninstall('fail-plugin', { mode: 'inspect' });
    expect(failView.events.origin).toBe('unknown');
    expect(failView.events.note).toContain('收割失败');
  });

  it('inspect：零副作用只读预检——报告全字段 + 级联警示（unknown 最坏假设 / 受影响会话点名）', async () => {
    const dataDir = makeDataDir();
    const { runner } = fakeRunner();
    const { localDir, loadEntry } = setupLocalApp(dataDir, [{ name: 'demo/one' }]);
    const affectedCalls: string[][] = [];
    const apps = createAppsService({
      dataDir,
      runner,
      loadEntry,
      affectedSessionCounts: async (types) => {
        affectedCalls.push([...types]);
        return { 'demo/one': 3 };
      },
    });
    await apps.install(localDir);
    await apps.mount('my-plugin', { apps: ['chat'], carrier: 'main' }); // 挂载行在场——mountedRows 可见
    // 数据域塞一个文件（体积行可见）
    writeFileSync(join(dataDir, 'apps', 'my-plugin', 'cache.bin'), 'x'.repeat(2048));

    const report = await apps.uninstall('my-plugin', { mode: 'inspect' });

    expect(report.id).toBe('my-plugin');
    expect(report.source).toBe('local');
    expect(report.appRef).toBe(localDir);
    expect(report.installPath).toBe(localDir); // local 装机物 = 引用路径本身（执行时不删）
    expect(report.mountedRows).toEqual(['my-plugin']);
    expect(report.dataRoots).toEqual([join(dataDir, 'apps', 'my-plugin')]);
    expect(report.dataBytes).toBeGreaterThanOrEqual(2048);
    expect(report.affectedSessions).toEqual({ 'demo/one': 3 }); // flush 屏障由装配闭包内嵌——服务面只见注入结果
    expect(affectedCalls).toEqual([['demo/one']]);
    expect(report.warnings.some((w) => w.includes('demo/one') && w.includes('3'))).toBe(true); // 逐词点名强警示
    // 零副作用：overlay 行在、数据域在、账本在
    expect(userRows(dataDir)).toEqual([
      { id: 'my-plugin', pkg: localDir, apps: ['chat'], sandbox: { carrier: 'main' } },
    ]);
    expect(existsSync(join(dataDir, 'apps', 'my-plugin', 'data.json'))).toBe(true);
    expect(readLedger(dataDir)[localDir]).toBeDefined();

    // unknown 档 = 最坏假设警示（无注入计数 → affectedSessions 省略）
    const noLedger = createAppsService({ dataDir, runner });
    writeFileSync(join(dataDir, 'apps', 'my-plugin', 'data.json'), '{oops');
    const unknownRow = await noLedger.uninstall('my-plugin', { mode: 'inspect' });
    expect(unknownRow.affectedSessions).toBeUndefined();
  });

  it('execute local 源：删全部挂载行 · 不删用户目录 · keep 留数据域 / purge 删件数据根含账本', async () => {
    const dataDir = makeDataDir();
    const { runner } = fakeRunner();
    const { localDir, loadEntry, emitted } = setupLocalApp(dataDir, []);
    const apps = createAppsService({
      dataDir,
      runner,
      loadEntry,
      emitUninstalled: (d) => emitted.push(d),
    });
    await apps.install(localDir);
    await apps.mount('my-plugin', { apps: ['chat'], carrier: 'main' });

    // keep（Docker 卷律缺省）：行删、用户目录在、数据域留、账本清
    const keep = await apps.uninstall('my-plugin', { mode: 'execute', dataAction: 'keep' });
    expect(keep).toMatchObject({
      id: 'my-plugin',
      source: 'local',
      outcome: 'uninstalled',
      dataAction: 'keep',
      installRemoved: 'none',
      mountedRows: ['my-plugin'],
      dataRemoved: false,
    });
    expect(keep.restoresDefault).toBeUndefined(); // 无默认层同 id 行
    expect(userRows(dataDir)).toEqual([]); // 段①删行
    expect(existsSync(localDir)).toBe(true); // local = 用户自有目录永不删
    expect(existsSync(join(dataDir, 'apps', 'my-plugin', 'data.json'))).toBe(true); // 数据域留
    expect(readLedger(dataDir)[localDir]).toBeUndefined(); // 段②账本记录同批清（N-10 账实同批律）
    expect(emitted).toEqual([{ id: 'my-plugin', source: 'local', dataAction: 'keep' }]); // 段④信封（词表空 → 无 affected 键）

    // purge：重装重挂后清数据域（账本随根整删）
    await apps.install(localDir);
    await apps.mount('my-plugin', { apps: ['chat'], carrier: 'main' });
    const purge = await apps.uninstall('my-plugin', { mode: 'execute', dataAction: 'purge' });
    expect(purge.dataRemoved).toBe(true);
    expect(existsSync(join(dataDir, 'apps', 'my-plugin'))).toBe(false);
    expect(emitted.at(-1)).toEqual({ id: 'my-plugin', source: 'local', dataAction: 'purge' });
  });

  it('execute npm 源：多应用挂载行同批删 + 装机物删除 + 账本清（uninstall 是装机级动作）', async () => {
    const dataDir = makeDataDir();
    const { runner } = fakeRunner();
    const apps = createAppsService({ dataDir, runner, gitCommitOf: fakeCommit });
    await apps.install('some-pkg');
    const pkgDir = join(dataDir, 'apps', 'node_modules', 'some-pkg'); // fakeRunner 不真装——手建模拟
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {}');
    // 同包两应用挂载（行 id 唯一——第二行显式命名）
    await apps.mount('some-pkg', { apps: ['chat'], carrier: 'main' });
    await apps.mount('some-pkg', { apps: ['hermes'], carrier: 'main', rowId: 'some-pkg-2' });

    // inspect 先看全集：mountedRows 两行、dataRoots 含两数据根
    const inspect = await apps.uninstall('some-pkg', { mode: 'inspect' });
    expect(inspect.mountedRows).toEqual(['some-pkg', 'some-pkg-2']);
    expect(inspect.installPath).toBe(pkgDir);
    expect(inspect.dataRoots).toEqual([join(dataDir, 'apps', 'some-pkg'), join(dataDir, 'apps', 'some-pkg-2')]);

    // execute：两行同批删 + 装机物删（node_modules 子树防线内）+ 账本清
    const exec = await apps.uninstall('some-pkg', { mode: 'execute', dataAction: 'keep' });
    expect(exec).toMatchObject({
      id: 'some-pkg',
      source: 'npm',
      outcome: 'uninstalled',
      installRemoved: 'removed',
      mountedRows: ['some-pkg', 'some-pkg-2'],
    });
    expect(loadOverlayRows(dataDir)).toEqual([]); // 行删净
    expect(existsSync(pkgDir)).toBe(false);
    expect(readLedger(dataDir)).toEqual({}); // 账本清空
  });

  it('builtin / Ring 1 行结构上不可达：装机 id 键域到不了官方行（provenance 只记三源装机物）', async () => {
    const dataDir = makeDataDir();
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner });
    // 官方行（builtin:memory）/ Ring 1 行（tools）皆无装机记录——键域即防线
    await expect(apps.uninstall('memory', { mode: 'inspect' })).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('未知装机 id'),
    });
    await expect(apps.uninstall('tools', { mode: 'inspect' })).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('未知装机 id'),
    });
    await expect(apps.uninstall('ghost-row', { mode: 'inspect' })).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
    });
  });

  it('装机物越界防线：账本定位串手改穿越段（../）——rmSync 前子树校验拒删，记录不误清', async () => {
    const dataDir = makeDataDir();
    const { runner } = fakeRunner();
    const apps = createAppsService({ dataDir, runner });
    // npm 引用带穿越段的账本记录：installPath 拼出 node_modules 之外的目录
    const pluginsRoot = join(dataDir, 'apps');
    mkdirSync(pluginsRoot, { recursive: true });
    writeFileSync(join(pluginsRoot, 'keep.txt'), '保命文件');
    writeFileSync(
      join(pluginsRoot, 'sources.json'),
      JSON.stringify({ 'node_modules/../..': { source: 'npm', ref: 'evil', id: 'evil' } }),
    );

    try {
      await apps.uninstall('evil', { mode: 'execute', dataAction: 'keep' });
      expect.unreachable('越界装机物删除应抛');
    } catch (err) {
      expect((err as AppError).code).toBe(COMPOSITION_ROW_INVALID);
      expect((err as AppError).message).toContain('越界');
    }
    expect(existsSync(join(pluginsRoot, 'keep.txt'))).toBe(true); // 越界目标完好
    // 防线先于段②删记录——账本记录保留（失败路径零副作用，人可修复账本后重试）
    expect(readLedger(dataDir)['node_modules/../..']).toBeDefined();
  });

  it('SF-8 残迹收尾：execute 账本无记录·全无残迹 = no-op 速报不抛（不造未知行错误）', async () => {
    const dataDir = makeDataDir();
    const { runner } = fakeRunner();
    const apps = createAppsService({ dataDir, runner });
    // inspect 相对未知装机 id 照旧响亮（人检视打错 id 该报错）
    try {
      await apps.uninstall('ghost', { mode: 'inspect' });
      expect.unreachable('inspect 未知装机 id 应抛');
    } catch (err) {
      expect((err as AppError).code).toBe(COMPOSITION_ROW_INVALID);
    }
    // execute 相：账本无记录且无可推导残迹（无 npm 装机物/无数据域裁决）→ no-op
    const report = await apps.uninstall('ghost', { mode: 'execute', dataAction: 'keep' });
    expect(report).toMatchObject({ id: 'ghost', outcome: 'no-op', installRemoved: 'none', dataRemoved: false });
  });

  it('SF-8 残迹收尾：pre-D2 遗产装机（npm 物 + 产物行俱在、无账本记录）→ 残迹路径收敛', async () => {
    const dataDir = makeDataDir();
    const { runner } = fakeRunner();
    const apps = createAppsService({ dataDir, runner });
    // 模拟 pre-D2 install 产物：npm 装机目录 + overlay 行（D2 前 install 写行）
    // 俱在、provenance 无记录（账本反查结构性 miss）
    const pkgDir = join(dataDir, 'apps', 'node_modules', 'some-pkg');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {}');
    writeFileSync(
      join(dataDir, 'overlay.yaml'),
      `rows:\n  - id: some-pkg\n    pkg: some-pkg\n  - id: alias-row\n    pkg: some-pkg\n`,
    );

    const report = await apps.uninstall('some-pkg', { mode: 'execute', dataAction: 'keep' });
    expect(report).toMatchObject({
      id: 'some-pkg',
      outcome: 'residual',
      source: 'npm',
      installRemoved: 'removed',
      dataRemoved: false,
    });
    // 残迹清干净：遗产行（归一路径反查同删——悬空行只会造触发②启动失败）+ 装机物
    expect(loadOverlayRows(dataDir)).toEqual([]);
    expect(existsSync(pkgDir)).toBe(false);
    // 再跑一次 = 全无残迹 no-op（重入收敛闭环）
    const again = await apps.uninstall('some-pkg', { mode: 'execute', dataAction: 'keep' });
    expect(again.outcome).toBe('no-op');
  });

  it('SF-8 残迹收尾：替换官方行的遗产行卸载 → restoresDefault（默认层同 id 行回露出）', async () => {
    const dataDir = makeDataDir();
    const { runner } = fakeRunner();
    const apps = createAppsService({ dataDir, runner });
    // pre-D2 替换形态：overlay 行盖默认层同 id 行（id: memory · plugin: some-pkg）
    const pkgDir = join(dataDir, 'apps', 'node_modules', 'some-pkg');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {}');
    writeFileSync(join(dataDir, 'overlay.yaml'), `rows:\n  - id: memory\n    pkg: some-pkg\n`);

    const restore = await apps.uninstall('some-pkg', { mode: 'execute', dataAction: 'keep' });
    expect(restore).toMatchObject({ outcome: 'residual', source: 'npm', restoresDefault: true });
    expect(loadOverlayRows(dataDir)).toEqual([]); // 行删净
    // 默认层 memory 行回露出（官方 builtin:memory 重新生效——回出厂态）
    expect(loadCompositionFor(dataDir).rows.some((row) => row.id === 'memory')).toBe(true);
  });

  it('旧 git 子树账本懒迁移：首次读折叠进全源账本 + 旧文件退役；update 按折叠记录走', async () => {
    const dataDir = makeDataDir();
    const { calls, runner } = fakeRunner();
    // pre-D2 形态：git 源登记在 apps/git/sources.json（D2 前的源账本位置）
    const gitRoot = join(dataDir, 'apps', 'git');
    const relDir = join('example.com', 'group', 'demo');
    mkdirSync(join(gitRoot, relDir), { recursive: true });
    writeFileSync(join(gitRoot, relDir, 'index.ts'), 'export default () => {};\n');
    writeFileSync(
      join(gitRoot, 'sources.json'),
      `${JSON.stringify({ [relDir]: { url: 'https://example.com/group/demo.git', ref: 'main' } }, null, 2)}\n`,
    );
    const apps = createAppsService({ dataDir, runner, gitCommitOf: fakeCommit });

    // 首次账本读（list 差集面即触发懒迁移）：折叠 + 写回 + 删旧文件
    expect(apps.list()).toContainEqual({ id: 'demo', status: 'installed-unmounted', source: 'git' });
    expect(readLedger(dataDir)).toEqual({
      [`git/${relDir}`]: {
        source: 'git',
        ref: 'https://example.com/group/demo.git',
        gitRef: 'main',
        id: 'demo',
      },
    });
    expect(existsSync(join(gitRoot, 'sources.json'))).toBe(false); // 旧账退役

    // 折叠记录可续用：update 按账本 gitRef 重克隆（URL 重 parse 推导 id 往返一致）
    await apps.update('demo');
    expect(calls.at(-1)).toEqual({
      command: 'git',
      args: [
        'clone',
        '--branch',
        'main',
        '--',
        'https://example.com/group/demo.git',
        join(gitRoot, ...relDir.split('/')),
      ],
      cwd: dataDir,
    });
  });
});

/* ---------------- configure / requestReload（契约篇 §3.4 刀 2 工具族条） ---------------- */

describe('configure 行配置写入', () => {
  /**
   * 造一个带声明 config schema 的 local 应用**挂载行**并置为 activated
   * （configure 的状态门要求行装载成功；两态下行由 mount 写——install 只入
   * 仓库态）。loadEntry 替身返回 config named export——与词表收割同注入边
   * 同信任前提。
   */
  function setupConfigurable(
    dataDir: string,
    configSchema?: object,
  ): { localDir: string; loadEntry: EntryLoader; apps: ReturnType<typeof createAppsService> } {
    const localDir = join(dataDir, 'my-plugin');
    mkdirSync(localDir);
    writeFileSync(join(localDir, 'index.ts'), 'export const name = "my-plugin";\nexport default () => {};\n');
    const loadEntry: EntryLoader = async () => ({
      name: 'my-plugin',
      ...(configSchema === undefined ? {} : { config: configSchema }),
    });
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner, loadEntry });
    return { localDir, loadEntry, apps };
  }

  /** applyLoad 全激活一行（configure 状态门的前置） */
  function activate(apps: ReturnType<typeof createAppsService>, dataDir: string, id: string): void {
    apps.applyLoad(loadCompositionFor(dataDir), {
      activated: [{ id, name: id, applyMs: 1 }],
      failed: [],
      skipped: [],
    });
  }

  it('happy path 文件行：schema 校验过 → overlay 写整值 config；回执带合并后全量与键清单', async () => {
    const dataDir = makeDataDir();
    const schema = Type.Object({ apiKey: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) });
    const { localDir, apps } = setupConfigurable(dataDir, schema);
    await apps.install(localDir);
    await apps.mount('my-plugin', { apps: ['chat'], carrier: 'main' });
    activate(apps, dataDir, 'my-plugin');

    const report: ConfigureReport = await apps.configure('my-plugin', { limit: 5 });

    expect(report.appliedKeys).toEqual(['limit']);
    expect(report.config).toEqual({ limit: 5 });
    expect(report.ring1RestartRequired).toBe(false); // Ring 2 行
    expect(report.message).toContain('apps_reload');
    expect(userRows(dataDir)).toEqual([
      { id: 'my-plugin', pkg: localDir, apps: ['chat'], sandbox: { carrier: 'main' }, config: { limit: 5 } },
    ]);
  });

  it('连续 configure 不经 reload：第二次合并不丢第一次写入的键（回归锁——陈旧 plan 基线 bug）', async () => {
    const dataDir = makeDataDir();
    const schema = Type.Object({ apiKey: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) });
    const { localDir, apps } = setupConfigurable(dataDir, schema);
    await apps.install(localDir);
    await apps.mount('my-plugin', { apps: ['chat'], carrier: 'main' });
    activate(apps, dataDir, 'my-plugin'); // 此后 plan 冻结（无再回灌）

    await apps.configure('my-plugin', { limit: 5 });
    // 修复前：第二次 merge 基线取 plan 行陈旧 config（{}）→ 整替掉 limit
    const second = await apps.configure('my-plugin', { apiKey: 'sk-1' });
    expect(second.config).toEqual({ limit: 5, apiKey: 'sk-1' });
    // 整值替换语义：列出键被替换、未列出键保持
    const third = await apps.configure('my-plugin', { limit: 9 });
    expect(third.config).toEqual({ limit: 9, apiKey: 'sk-1' });
    expect(userRows(dataDir)).toEqual([
      {
        id: 'my-plugin',
        pkg: localDir,
        apps: ['chat'],
        sandbox: { carrier: 'main' },
        config: { limit: 9, apiKey: 'sk-1' },
      },
    ]);
  });

  it('builtin 行：schema 走官方注册表模块引用零装载（不注入 loadEntry 也成立）+ 纯默认层行插替换行不写 plugin 键', async () => {
    const dataDir = makeDataDir();
    const builtin = {
      name: 'memory',
      apply: () => {},
      config: Type.Object({ depth: Type.Optional(Type.Number()) }),
    };
    // 组合树解析需官方件注册表——注入 fake 注册表（loadComposition 第二参）
    const apps = createAppsService({
      dataDir,
      runner: fakeRunner().runner,
      // 刻意不注入 loadEntry：builtin 行 schema 来自 plan 行直挂的模块引用
    });
    apps.applyLoad(loadComposition(dataDir, { 'builtin:memory': builtin }, KNOWN_APPS), {
      activated: [{ id: 'memory', name: 'memory', applyMs: 1 }],
      failed: [],
      skipped: [],
    });

    const report = await apps.configure('memory', { depth: 3 });
    expect(report.config).toEqual({ depth: 3 });
    // 行不在 overlay → writeOverlayRowConfig 插替换行（省略 plugin = 沿用官方层引用）
    expect(loadOverlayRows(dataDir)).toEqual([{ id: 'memory', config: { depth: 3 } }]);
  });

  it('Ring 1 行（tools）：可配置但回执注明不随 /reload 热装载须重启', async () => {
    const dataDir = makeDataDir();
    const builtin = {
      name: 'tools',
      apply: () => {},
      config: Type.Object({ maxBytes: Type.Optional(Type.Number()) }),
    };
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner });
    apps.applyLoad(loadComposition(dataDir, { 'builtin:tools': builtin }, KNOWN_APPS), {
      activated: [{ id: 'tools', name: 'tools', applyMs: 1 }],
      failed: [],
      skipped: [],
    });
    const report = await apps.configure('tools', { maxBytes: 4096 });
    expect(report.ring1RestartRequired).toBe(true);
    expect(report.message).toContain('重启');
  });

  it('schema 校验不过：APP_CONFIG_INVALID 带 instancePath 首错定位 + 不落盘（现配置不变）', async () => {
    const dataDir = makeDataDir();
    const schema = Type.Object({ port: Type.Number() });
    const { localDir, apps } = setupConfigurable(dataDir, schema);
    await apps.install(localDir);
    await apps.mount('my-plugin', { apps: ['chat'], carrier: 'main' });
    activate(apps, dataDir, 'my-plugin');

    try {
      await apps.configure('my-plugin', { port: 'not-a-number' });
      expect.unreachable('schema 违规应抛');
    } catch (err) {
      expect((err as AppError).code).toBe(APP_CONFIG_INVALID);
      expect((err as AppError).message).toContain('/port'); // instancePath 首错定位
      expect((err as AppError).message).toContain('未写入');
    }
    // 错配置不落盘：overlay 行无 config 键
    expect(userRows(dataDir)).toEqual([
      { id: 'my-plugin', pkg: localDir, apps: ['chat'], sandbox: { carrier: 'main' } },
    ]);
  });

  it('分域行拒写（R1 P0-3 扩面）：worker / external（含缺省闩一）行 COMPOSITION_ROW_INVALID——校验面在域侧', async () => {
    const dataDir = makeDataDir();
    const schema = Type.Object({ limit: Type.Optional(Type.Number()) });
    const { localDir, apps } = setupConfigurable(dataDir, schema);
    await apps.install(localDir);
    // 缺省 carrier：闩一装载期推 external——原门只拒 worker，external 行落穿到
    // loadEntry = 宿主主进程 jiti 求值第三方码（R1 修复面）
    await apps.mount('my-plugin', { apps: ['chat'] });
    activate(apps, dataDir, 'my-plugin');
    await expect(apps.configure('my-plugin', { limit: 5 })).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('分域行'),
    });
    // 显式 worker 同拒（原门已有面——三值同锁）
    const dataDir2 = makeDataDir();
    const setup2 = setupConfigurable(dataDir2, schema);
    await setup2.apps.install(setup2.localDir);
    await setup2.apps.mount('my-plugin', { apps: ['chat'], carrier: 'worker' });
    activate(setup2.apps, dataDir2, 'my-plugin');
    await expect(setup2.apps.configure('my-plugin', { limit: 5 })).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('分域行'),
    });
    // 两行 config 均未落（拒写不留半态）
    expect(loadOverlayRows(dataDir).find((r) => r.id === 'my-plugin')?.config).toBeUndefined();
    expect(loadOverlayRows(dataDir2).find((r) => r.id === 'my-plugin')?.config).toBeUndefined();
  });

  it('四道状态门全拒写（COMPOSITION_ROW_INVALID）：空 patch / 未知行 / 已禁用 / 未激活', async () => {
    const dataDir = makeDataDir();
    const { localDir, apps } = setupConfigurable(dataDir);
    await apps.install(localDir);
    await apps.mount('my-plugin', { apps: ['chat'], carrier: 'main' });

    // 空 patch：整值替换语义下空集不是变更
    await expect(apps.configure('my-plugin', {})).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
    });
    // 未知行
    await expect(apps.configure('ghost', { a: 1 })).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
    });

    // 已禁用（挂载休眠）：先提示启用
    apps.toggle('my-plugin'); // → 禁用
    apps.applyLoad(loadCompositionFor(dataDir), emptyLoad);
    await expect(apps.configure('my-plugin', { a: 1 })).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('已禁用'),
    });
    apps.toggle('my-plugin'); // → 启用（回测试基线）

    // 未激活（boot 前视角 planned / 装载失败 failed 均拒）
    apps.applyLoad(loadCompositionFor(dataDir), {
      activated: [],
      failed: [{ id: 'my-plugin', code: 'APP_APPLY_FAILED', message: '炸了' }],
      skipped: [],
    });
    await expect(apps.configure('my-plugin', { a: 1 })).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('未激活'),
    });
  });

  it('入口未解析行拒写（手写 overlay 指不存在的 local 目录）——提示先安装', async () => {
    const dataDir = makeDataDir();
    writeFileSync(
      join(dataDir, 'overlay.yaml'),
      `rows:\n  - id: ghost-local\n    pkg: ${join(dataDir, 'no-such-dir')}\n    apps: [chat]\n`,
    );
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner });
    apps.applyLoad(loadCompositionFor(dataDir), emptyLoad);
    await expect(apps.configure('ghost-local', { a: 1 })).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('未解析'),
    });
  });

  it('worker 域行诚实拒写：生效 schema 在 worker 侧结构不可得，指引直改 overlay.yaml', async () => {
    const dataDir = makeDataDir();
    const localDir = join(dataDir, 'wrk-plugin');
    mkdirSync(localDir);
    writeFileSync(join(localDir, 'index.ts'), 'export const name = "wrk";\nexport default () => {};\n');
    writeFileSync(
      join(dataDir, 'overlay.yaml'),
      `rows:\n  - id: wrk-plugin\n    pkg: ${localDir}\n    apps: [chat]\n    sandbox: { carrier: worker }\n`,
    );
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner });
    apps.applyLoad(loadCompositionFor(dataDir), {
      activated: [{ id: 'wrk-plugin', name: 'wrk', applyMs: 1 }],
      failed: [],
      skipped: [],
    });
    await expect(apps.configure('wrk-plugin', { a: 1 })).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('worker'),
    });
  });

  it('文件行无 loadEntry 注入（配置校验面不可用）：诚实拒写', async () => {
    const dataDir = makeDataDir();
    const localDir = join(dataDir, 'my-plugin');
    mkdirSync(localDir);
    writeFileSync(join(localDir, 'index.ts'), 'export const name = "my-plugin";\nexport default () => {};\n');
    const apps = createAppsService({ dataDir, runner: fakeRunner().runner }); // 无 loadEntry
    await apps.install(localDir);
    await apps.mount('my-plugin', { apps: ['chat'], carrier: 'main' });
    activate(apps, dataDir, 'my-plugin');
    await expect(apps.configure('my-plugin', { a: 1 })).rejects.toMatchObject({
      code: COMPOSITION_ROW_INVALID,
      message: expect.stringContaining('不可用'),
    });
  });
});

describe('requestReload 导线', () => {
  it('缺省（诊断装配）：宿主未注入重载面 → COMPOSITION_ROW_INVALID 响亮拒绝', async () => {
    const apps = createAppsService({ dataDir: makeDataDir(), runner: fakeRunner().runner });
    await expect(apps.requestReload()).rejects.toMatchObject({ code: COMPOSITION_ROW_INVALID });
  });

  it('注入闭包三态透传：queued / done（含失败清单）/ error 原样回传（服务面零自有状态）', async () => {
    const outcomes: ReloadOutcome[] = [
      { status: 'queued' },
      { status: 'done', failed: ['bad-row'] },
      { status: 'error', message: 'overlay 解析失败' },
    ];
    let call = 0;
    const apps = createAppsService({
      dataDir: makeDataDir(),
      runner: fakeRunner().runner,
      // 注入替身按调用序回放三态（服务面零自有状态只透传——三态各自原样到达）
      requestReload: async () => outcomes[call++]!,
    });
    expect(await apps.requestReload()).toEqual({ status: 'queued' });
    expect(await apps.requestReload()).toEqual({ status: 'done', failed: ['bad-row'] });
    expect(await apps.requestReload()).toEqual({ status: 'error', message: 'overlay 解析失败' });
  });
});

describe('升权目标档词汇单一归宿（admin 写类动词 ↔ safety 权威词表）', () => {
  it('admin 镜像常量 ≡ safety ESCALATION_TARGETS（两侧漂移即红；admin 不开 admin→safety 边）', () => {
    expect([...PRIVILEGE_REQUEST_TARGETS]).toEqual([...ESCALATION_TARGETS]);
  });
});

describe('tmp 扫龄（契约篇 §1.5 tmp 钉位细则）', () => {
  /** 回拨 mtime 至 8 天前（阈值 7 天——安全过线；秒精度，utimes/lutimes 语义） */
  const OLD = (Date.now() - 8 * 86400_000) / 1000;

  it('过期删、新鲜留；只进 tmp/ 子树——data.json 与 tmp 外旧文件永不触碰', () => {
    const dataDir = makeDataDir();
    const root = join(dataDir, 'apps', 'demo');
    mkdirSync(join(root, 'tmp'), { recursive: true });
    mkdirSync(join(root, 'cache'), { recursive: true });
    writeFileSync(join(root, 'tmp', 'old.bin'), 'x');
    writeFileSync(join(root, 'tmp', 'fresh.bin'), 'x');
    writeFileSync(join(root, 'cache', 'ancient.bin'), 'x'); // tmp 外旧文件——非扫龄对象
    writeFileSync(join(root, 'data.json'), '{}');
    utimesSync(join(root, 'tmp', 'old.bin'), OLD, OLD);
    utimesSync(join(root, 'cache', 'ancient.bin'), OLD, OLD);
    utimesSync(join(root, 'data.json'), OLD, OLD);

    const removed = sweepAppTmpDirs(dataDir);
    expect(removed).toBe(1);
    expect(existsSync(join(root, 'tmp', 'old.bin'))).toBe(false);
    expect(existsSync(join(root, 'tmp', 'fresh.bin'))).toBe(true);
    expect(existsSync(join(root, 'cache', 'ancient.bin'))).toBe(true); // tmp 外不删
    expect(existsSync(join(root, 'data.json'))).toBe(true); // 账本永不触碰
  });

  it('装机子树保留名（git/node_modules）永不扫——同名单常量两消费点', () => {
    const dataDir = makeDataDir();
    const nmTmp = join(dataDir, 'apps', 'node_modules', 'pkg', 'tmp');
    const gitTmp = join(dataDir, 'apps', 'git', 'host', 'x', 'tmp');
    mkdirSync(nmTmp, { recursive: true });
    mkdirSync(gitTmp, { recursive: true });
    writeFileSync(join(nmTmp, 'old.bin'), 'x');
    writeFileSync(join(gitTmp, 'old.bin'), 'x');
    utimesSync(join(nmTmp, 'old.bin'), OLD, OLD);
    utimesSync(join(gitTmp, 'old.bin'), OLD, OLD);

    expect(sweepAppTmpDirs(dataDir)).toBe(0);
    expect(existsSync(join(nmTmp, 'old.bin'))).toBe(true);
    expect(existsSync(join(gitTmp, 'old.bin'))).toBe(true);
  });

  it('符号链接：本体当文件删（lutimes 回拨本体）、目标永不触碰；tmp 本体是链接则整根不进', () => {
    const dataDir = makeDataDir();
    const outside = join(dataDir, 'outside'); // 数据根外的「逃逸目标」
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'victim.bin'), 'x');
    utimesSync(join(outside, 'victim.bin'), OLD, OLD); // 目标自身已过期——删了即证明逃逸

    // 形态一：tmp 内的符号链接（指文件）
    const root1 = join(dataDir, 'apps', 'a');
    mkdirSync(join(root1, 'tmp'), { recursive: true });
    symlinkSync(join(outside, 'victim.bin'), join(root1, 'tmp', 'link.bin'));
    lutimesSync(join(root1, 'tmp', 'link.bin'), OLD, OLD);

    // 形态二：tmp 内的符号链接目录（Dirent 不跟随——走文件分支删本体）
    const dirTarget = join(dataDir, 'outside-dir');
    mkdirSync(dirTarget, { recursive: true });
    writeFileSync(join(dirTarget, 'keep.bin'), 'x');
    const root2 = join(dataDir, 'apps', 'b');
    mkdirSync(join(root2, 'tmp'), { recursive: true });
    symlinkSync(dirTarget, join(root2, 'tmp', 'link-dir'));
    lutimesSync(join(root2, 'tmp', 'link-dir'), OLD, OLD);

    // 形态三：tmp 本体即符号链接（入口 lstat 判真目录——链接整根不进）
    const root3 = join(dataDir, 'apps', 'c');
    mkdirSync(root3, { recursive: true });
    const linkedTmp = join(dataDir, 'outside-tmp');
    mkdirSync(join(linkedTmp, 'deep'), { recursive: true });
    writeFileSync(join(linkedTmp, 'deep', 'old.bin'), 'x');
    utimesSync(join(linkedTmp, 'deep', 'old.bin'), OLD, OLD);
    symlinkSync(linkedTmp, join(root3, 'tmp'));

    expect(sweepAppTmpDirs(dataDir)).toBe(2); // 两条链接本体（非目标内容）
    expect(existsSync(join(outside, 'victim.bin'))).toBe(true); // 目标存活
    expect(existsSync(join(dirTarget, 'keep.bin'))).toBe(true);
    expect(existsSync(join(linkedTmp, 'deep', 'old.bin'))).toBe(true); // 链接 tmp 整根未进
  });

  it('空目录自底向上剪除（含 tmp 本体）；新鲜文件在任何层保住整链', () => {
    const dataDir = makeDataDir();
    const goneRoot = join(dataDir, 'apps', 'gone');
    mkdirSync(join(goneRoot, 'tmp', 'a', 'b'), { recursive: true });
    writeFileSync(join(goneRoot, 'tmp', 'a', 'b', 'old.bin'), 'x');
    utimesSync(join(goneRoot, 'tmp', 'a', 'b', 'old.bin'), OLD, OLD);

    const stayRoot = join(dataDir, 'apps', 'stay');
    mkdirSync(join(stayRoot, 'tmp', 'a', 'b'), { recursive: true });
    writeFileSync(join(stayRoot, 'tmp', 'a', 'fresh.bin'), 'x'); // 中层新鲜——保住 a 及以下整链

    expect(sweepAppTmpDirs(dataDir)).toBe(1);
    expect(existsSync(join(goneRoot, 'tmp'))).toBe(false); // 空链剪到底（tmp 本体含）
    expect(existsSync(join(stayRoot, 'tmp', 'a', 'fresh.bin'))).toBe(true);
    expect(existsSync(join(stayRoot, 'tmp'))).toBe(true);
  });

  it('apps/ 目录缺失 = 静默 no-op；重复扫幂等（双进程同扫竞态面）', () => {
    const dataDir = makeDataDir(); // 未建 apps/
    expect(sweepAppTmpDirs(dataDir)).toBe(0);

    const root = join(dataDir, 'apps', 'demo');
    mkdirSync(join(root, 'tmp'), { recursive: true });
    writeFileSync(join(root, 'tmp', 'old.bin'), 'x');
    utimesSync(join(root, 'tmp', 'old.bin'), OLD, OLD);
    expect(sweepAppTmpDirs(dataDir)).toBe(1);
    expect(sweepAppTmpDirs(dataDir)).toBe(0); // 第二扫：空目录已剪、无残留无异常
    expect(existsSync(join(root, 'tmp'))).toBe(false);
  });
});

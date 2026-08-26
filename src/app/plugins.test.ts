/**
 * L5 app — 插件管理服务测试（ctx.plugins install/toggle/update，契约篇 §1.5 表尾落码）。
 *
 * 纪律对照：装机子进程执行器是**注入边**（mock 只停在这一层——它就是外部进程面，
 * 等价于模型层的 faux provider）；overlay 读写/组合树装载全真（临时目录真文件）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError, COMPOSITION_ROW_INVALID, PLUGIN_INSTALL_FAILED } from '../contracts/errors.js';
import type { PluginLoadResult } from '../contracts/plugin.js';
import { createPluginsService, spawnRunner, type InstallRunner } from './plugins.js';
import { loadComposition } from './composition.js';

/* ---------------- 测试基建 ---------------- */

/** 临时数据目录（overlay 与装机子树的根） */
function makeDataDir(): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plugins-')));
}

/**
 * 装载并滤除官方默认层行（chat 首行 + memory 次行 + subagent 第三行 + goal 第四行 +
 * scheduler 第五行 + mcp 第六行 + tools 第七行〔Ring 1 行树化起算〕+ web 第八行 +
 * compaction 第九行 + admin 第十行——契约篇 §5.1/§1.5.2/§6.6/§3.4）：本文件测
 * overlay 对账语义（用户层写什么/读回什么），官方行进 composition.test 专属测试
 * ——两关注点不混断言。
 */
function userRows(dataDir: string): unknown[] {
  return loadComposition(dataDir).rows.filter(
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
      row.id !== 'admin',
  );
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

/** 最小装载结果（applyLoad 测试面） */
const emptyLoad: PluginLoadResult = { activated: [], failed: [], skipped: [] };

/* ---------------- install 三源分发 ---------------- */

describe('install 三源分发', () => {
  it('npm 源：--prefix 装机子树 + --legacy-peer-deps --omit=peer，overlay 写裸包名', async () => {
    const dataDir = makeDataDir();
    const { calls, runner } = fakeRunner();
    const plugins = createPluginsService({ dataDir, runner });

    const report = await plugins.install('some-pkg@^2.1.0');

    expect(report.id).toBe('some-pkg'); // npm spec 剥版本段
    expect(report.source).toBe('npm');
    expect(report.pluginRef).toBe('some-pkg'); // overlay 行 plugin = 裸包名（走子树解析）
    expect(calls).toEqual([
      {
        command: 'npm',
        args: ['install', '--prefix', join(dataDir, 'plugins'), '--legacy-peer-deps', '--omit=peer', 'some-pkg@^2.1.0'],
        cwd: dataDir,
      },
    ]);
    // 对账写回：overlay 已有该行（裸包名引用）
    expect(userRows(dataDir)).toEqual([{ id: 'some-pkg', plugin: 'some-pkg' }]);
  });

  it('npm scoped 包名解析：@scope/pkg@1.2 → id=@scope/pkg（不丢 scope 不带版本）', async () => {
    const dataDir = makeDataDir();
    const { runner } = fakeRunner();
    const plugins = createPluginsService({ dataDir, runner });
    const report = await plugins.install('@scope/pkg@1.2.3');
    expect(report.id).toBe('@scope/pkg');
  });

  it('git 源（https .git 尾）：clone 到 host/首段/repo 分层目录，sources.json 记源，overlay 写绝对路径', async () => {
    const dataDir = makeDataDir();
    const { calls, runner } = fakeRunner();
    const plugins = createPluginsService({ dataDir, runner });

    const report = await plugins.install('https://github.com/foo/bar.git', { gitRef: 'v1.2' });

    const expectedDir = join(dataDir, 'plugins', 'git', 'github.com', 'foo', 'bar');
    expect(report.id).toBe('bar');
    expect(report.pluginRef).toBe(expectedDir);
    expect(report.source).toBe('git');
    expect(calls).toEqual([
      {
        command: 'git',
        args: ['clone', '--branch', 'v1.2', '--', 'https://github.com/foo/bar.git', expectedDir],
        cwd: dataDir,
      },
    ]);
    // 源登记：update 重克隆的 ref 依据
    const sources = JSON.parse(readFileSync(join(dataDir, 'plugins', 'git', 'sources.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(sources['github.com/foo/bar']).toEqual({ url: 'https://github.com/foo/bar.git', ref: 'v1.2' });
    // overlay 写 clone 目录绝对路径
    expect(userRows(dataDir)).toEqual([{ id: 'bar', plugin: expectedDir }]);
  });

  it('git 源（git@ 形态、无 ref）：默认分支 clone；重复 install 先清目录（幂等不留半装残骸）', async () => {
    const dataDir = makeDataDir();
    const { calls, runner } = fakeRunner();
    const plugins = createPluginsService({ dataDir, runner });

    await plugins.install('git@gitlab.example.com:group/sub/repo.git');
    // git@ 形态拆解：host / 首路径段 group / repo（深层组取首段防撞名）
    expect(calls[0]!.args).toEqual([
      'clone',
      '--',
      'git@gitlab.example.com:group/sub/repo.git',
      join(dataDir, 'plugins', 'git', 'gitlab.example.com', 'group', 'repo'),
    ]);
    // 二装幂等：目录先被清（fake runner 不建目录——用残留哨兵文件验证 rm 发生过）
    const target = join(dataDir, 'plugins', 'git', 'gitlab.example.com', 'group', 'repo');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'stale.txt'), '半装残骸');
    await plugins.install('git@gitlab.example.com:group/sub/repo.git');
    expect(existsSync(join(target, 'stale.txt'))).toBe(false); // rmSync 先清生效
  });

  it('local 源：绝对化写 overlay 不拷贝；路径不存在即时即响', async () => {
    const dataDir = makeDataDir();
    const { calls, runner } = fakeRunner();
    const plugins = createPluginsService({ dataDir, runner });
    // 真建本地插件目录（local 面零子进程——calls 必须为空）；绝对路径是最稳的测试形态
    // （相对形态按进程 cwd 解析，测试 cwd 即仓库根不可控）
    const localDir = join(dataDir, 'my-plugin');
    mkdirSync(localDir);

    const report = await plugins.install(localDir);

    expect(calls).toEqual([]); // local = 直引登记，零子进程
    expect(report.source).toBe('local');
    expect(report.pluginRef).toBe(localDir); // 绝对化（resolve 归一）
    expect(userRows(dataDir)).toEqual([{ id: 'my-plugin', plugin: localDir }]);

    // 路径不存在 → COMPOSITION_ROW_INVALID（装不进一条指空的路）
    try {
      await plugins.install(join(dataDir, 'no-such-dir'));
      expect.unreachable('不存在的 local 路径应抛');
    } catch (err) {
      expect((err as AppError).code).toBe(COMPOSITION_ROW_INVALID);
    }
  });

  it('装机子进程失败：统一 PLUGIN_INSTALL_FAILED，message 载命令与原因', async () => {
    const dataDir = makeDataDir();
    const { runner } = fakeRunner({ npm: '退出码 1\nENOENT no such package' });
    const plugins = createPluginsService({ dataDir, runner });

    try {
      await plugins.install('ghost-pkg');
      expect.unreachable('子进程失败应抛');
    } catch (err) {
      expect((err as AppError).code).toBe(PLUGIN_INSTALL_FAILED);
      expect((err as AppError).message).toContain('npm install');
      expect((err as AppError).message).toContain('ENOENT no such package');
    }
    // 对账不写回——失败装机不落 overlay 行
    expect(userRows(dataDir)).toEqual([]);
  });
});

/* ---------------- toggle / update ---------------- */

describe('toggle 与 update', () => {
  it('toggle 翻转 overlay 禁用状态（持久化半边语义在 composition.test 已锁——此处验服务面回传）', async () => {
    const dataDir = makeDataDir();
    const { runner } = fakeRunner();
    const plugins = createPluginsService({ dataDir, runner });
    await plugins.install('some-pkg'); // 装入 + 对账

    expect(plugins.toggle('some-pkg')).toBe(true); // → 禁用
    expect(userRows(dataDir)).toEqual([{ id: 'some-pkg', plugin: 'some-pkg', disabled: true }]);
    expect(plugins.toggle('some-pkg')).toBe(false); // → 启用（删键）
    expect(userRows(dataDir)).toEqual([{ id: 'some-pkg', plugin: 'some-pkg' }]);
  });

  it('update 按源分派：npm 重装同名 / git 按原 ref 重克隆 / local no-op', async () => {
    const dataDir = makeDataDir();
    const localDir = join(dataDir, 'my-plugin');
    mkdirSync(localDir);
    const { calls, runner } = fakeRunner();
    const plugins = createPluginsService({ dataDir, runner });
    await plugins.install('some-pkg');
    await plugins.install('https://github.com/foo/bar.git', { gitRef: 'v1' });
    await plugins.install(localDir);
    calls.length = 0; // 装机调用已断言过——update 阶段从零记

    // npm 源：重装同名（重新解析版本）
    const npmReport = await plugins.update('some-pkg');
    expect(npmReport.source).toBe('npm');
    expect(calls.at(-1)).toEqual({
      command: 'npm',
      args: ['install', '--prefix', join(dataDir, 'plugins'), '--legacy-peer-deps', '--omit=peer', 'some-pkg'],
      cwd: dataDir,
    });

    // git 源：删目录按原 ref 重克隆（branch=v1 来自 sources.json，非记忆）
    const gitDir = join(dataDir, 'plugins', 'git', 'github.com', 'foo', 'bar');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'old-checkout.txt'), '旧检出');
    const gitReport = await plugins.update('bar');
    expect(gitReport.source).toBe('git');
    expect(calls.at(-1)).toEqual({
      command: 'git',
      args: ['clone', '--branch', 'v1', '--', 'https://github.com/foo/bar.git', gitDir],
      cwd: dataDir,
    });
    expect(existsSync(join(gitDir, 'old-checkout.txt'))).toBe(false); // 先删后克隆

    // local 源：no-op（零子进程）
    const localCallsBefore = calls.length;
    const localReport = await plugins.update('my-plugin');
    expect(localReport.source).toBe('local');
    expect(localReport.message).toContain('改动');
    expect(calls.length).toBe(localCallsBefore);
  });

  it('update 未知行 id：COMPOSITION_ROW_INVALID', async () => {
    const dataDir = makeDataDir();
    const plugins = createPluginsService({ dataDir, runner: fakeRunner().runner });
    try {
      await plugins.update('ghost');
      expect.unreachable('未知 id 应抛');
    } catch (err) {
      expect((err as AppError).code).toBe(COMPOSITION_ROW_INVALID);
    }
  });

  it('update git 目录无源记录（手放目录）：PLUGIN_INSTALL_FAILED 指引重装', async () => {
    const dataDir = makeDataDir();
    // 手放一个 git 目录 + overlay 直指（绕过 install——sources.json 无记录）
    const gitDir = join(dataDir, 'plugins', 'git', 'github.com', 'foo', 'hand');
    mkdirSync(gitDir, { recursive: true });
    const { saveOverlayRows } = await import('./composition.js');
    saveOverlayRows(dataDir, [{ id: 'hand', plugin: gitDir }]);
    const plugins = createPluginsService({ dataDir, runner: fakeRunner().runner });

    try {
      await plugins.update('hand');
      expect.unreachable('无源记录应抛');
    } catch (err) {
      expect((err as AppError).code).toBe(PLUGIN_INSTALL_FAILED);
      expect((err as AppError).message).toContain('sources.json');
    }
  });
});

/* ---------------- 装机面安全（隔离案一第一刀：P33 路径穿越 + P32 子进程护栏） ---------------- */

describe('装机面安全（隔离案一第一刀 #15/#16）', () => {
  /**
   * 独立沙箱：root 下建 data 数据目录与 canary 哨兵——穿越 rmSync 若可达，
   * `git@..:../..` 形态归一后落在 root 本身，哨兵必被抹掉（红转绿的爆炸半径证明）。
   */
  function makeSandbox(): { root: string; dataDir: string; canary: string } {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-plugins-sec-')));
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
      const plugins = createPluginsService({ dataDir, runner: fakeRunner().runner });
      try {
        await plugins.install(url);
        expect.unreachable(`穿越子弹应拒：${url}`);
      } catch (err) {
        expect((err as AppError).code).toBe(COMPOSITION_ROW_INVALID);
      }
      expect(existsSync(canary)).toBe(true); // 数据目录父级哨兵完好
    }
  });

  it('P33 纵深（update 面）：overlay 手改 plugin 引用越界——拒绝且目标目录完好', async () => {
    const { dataDir } = makeSandbox();
    // 手改 overlay：plugin 指向字面 git 子树内、归一后子树外（模拟污染的 overlay 行）。
    // 注意不可用 join 拼——join 会词法归一掉 `..`，恶意形态须手工拼串原样落盘
    const escapeDir = join(dataDir, 'plugins', 'escape');
    mkdirSync(escapeDir, { recursive: true });
    writeFileSync(join(escapeDir, 'victim.txt'), '越界 rmSync 的潜在受害者');
    const maliciousRef = `${join(dataDir, 'plugins', 'git')}/../escape`;
    const { saveOverlayRows } = await import('./composition.js');
    saveOverlayRows(dataDir, [{ id: 'evil', plugin: maliciousRef }]);
    // sources.json 同键合谋（两份主机文件都指向越界键——防线按归一路径执法不看字面）
    const gitDir = join(dataDir, 'plugins', 'git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'sources.json'), JSON.stringify({ '../escape': { url: 'git@h:o/r.git' } }));
    const plugins = createPluginsService({ dataDir, runner: fakeRunner().runner });

    try {
      await plugins.update('evil');
      expect.unreachable('越界引用应拒');
    } catch (err) {
      expect((err as AppError).code).toBe(COMPOSITION_ROW_INVALID);
      expect((err as AppError).message).toContain('越界');
    }
    expect(existsSync(join(escapeDir, 'victim.txt'))).toBe(true); // 目标目录完好
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

/* ---------------- list 与 applyLoad（有状态单例） ---------------- */

describe('list 与 applyLoad（boot 与 /reload 同一实例就地更新）', () => {
  it('applyLoad 回灌装载状态：activated/failed/skipped 映射 + planned 兜底 + 行序 = 组合树序', async () => {
    const dataDir = makeDataDir();
    const { runner } = fakeRunner();
    const plugins = createPluginsService({ dataDir, runner });
    await plugins.install('ok-pkg');
    await plugins.install('dormant-pkg');
    plugins.toggle('dormant-pkg'); // → 禁用
    // 组合树含官方默认层 chat/memory/subagent/goal/scheduler/mcp/tools/web/
    // compaction/admin 十行（本测试无官方件注册表 → unresolved/planned）——滤除
    // 只留用户行：本测试锁 applyLoad 映射语义，官方行装载态在 assembly 全栈锁
    const composition = loadComposition(dataDir);
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
          row.id !== 'admin',
      ),
    };

    plugins.applyLoad(userComposition, {
      activated: [{ id: 'ok-pkg', name: 'stub', applyMs: 1 }],
      failed: [],
      skipped: [{ id: 'dormant-pkg', reason: 'disabled' }],
    });
    // applyMs 为装载计时（刀〇a 打点面）——activated 行带值，toMatchObject 不断言精确数
    expect(plugins.list()).toMatchObject([
      { id: 'ok-pkg', status: 'activated', name: 'stub' },
      { id: 'dormant-pkg', status: 'skipped', reason: 'disabled' },
    ]);

    // /reload 后再次回灌：同实例新状态（旧状态整体替换——不留陈旧行）
    plugins.applyLoad(userComposition, {
      activated: [],
      failed: [{ id: 'ok-pkg', code: 'PLUGIN_APPLY_FAILED', message: '炸了' }],
      skipped: [{ id: 'dormant-pkg', reason: 'disabled' }],
    });
    expect(plugins.list().map((row) => [row.id, row.status])).toEqual([
      ['ok-pkg', 'failed'],
      ['dormant-pkg', 'skipped'],
    ]);

    // boot 前视角 / 装载前行：planned 兜底
    const fresh = createPluginsService({ dataDir, runner });
    expect(fresh.list()).toEqual([]);
    fresh.applyLoad(userComposition, emptyLoad);
    expect(fresh.list().map((row) => [row.id, row.status])).toEqual([
      ['ok-pkg', 'planned'],
      ['dormant-pkg', 'planned'],
    ]);
  });
});

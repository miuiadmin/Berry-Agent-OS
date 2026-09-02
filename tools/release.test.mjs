/**
 * 发布机器测试（技术栈篇 §8.3 测试面，第四十批）。两层：
 *
 * 1. 纯决策函数直测——classifyProbe / decideIdempotent / planTagOperations /
 *    assertDistTagTerminal / inspectPackEntries / classifyGitTag（六道契约的
 *    判决逻辑全在这里，无任何 io）。
 * 2. 编排骨舞全脚本化——runRelease 经 io 注入缝驱动（零真实 npm/git 进程）；
 *    INJECT_SCENARIOS 四谱项与操作者 --inject 同表共用：**测试即演习留档**
 *    （§8.3 失败注入演习两轮的完成判据——谱项全覆盖收进常规测试面）。
 *
 * 落位注记：本文件与 tools/golden/replay.test.mjs 同为 vitest 窄面收编的
 * tools/*.mjs 测试（vitest.config include 显式列举）——在 tsc 视门外靠纯
 * node 语义直跑，不参与 typecheck 段。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INJECT_SCENARIOS,
  applyScenario,
  assertDistTagTerminal,
  assertNoInstallPlaceholders,
  classifyGitTag,
  classifyProbe,
  decideIdempotent,
  inspectPackEntries,
  parseNpmPackJson,
  planTagOperations,
  publishArgs,
  runRelease,
} from './release.mjs';

// ───────────────── 纯决策函数（六道契约的判决逻辑） ─────────────────

describe('契约 2 classifyProbe：registry 探测三态（E404 与网络错分叉是命门）', () => {
  it('code 0 → 在场（stdout JSON 串即 shasum）', () => {
    expect(classifyProbe({ code: 0, stdout: JSON.stringify('a1b2'), stderr: '' })).toEqual({
      state: 'present',
      shasum: 'a1b2',
    });
  });
  it('E404 → 缺席（该版本未发过，正常发）', () => {
    expect(classifyProbe({ code: 1, stdout: '', stderr: 'npm error code E404' })).toEqual({ state: 'absent' });
  });
  it('其余错误 → 不可达（拒发不盲发）', () => {
    expect(classifyProbe({ code: 1, stdout: '', stderr: 'npm error code ETIMEDOUT' }).state).toBe('unreachable');
  });
  it('deferEqual 旗标 → 在场（等价承诺延后到收口兑现——注入谱专用）', () => {
    expect(classifyProbe({ code: 0, stdout: '', stderr: '', deferEqual: true })).toEqual({
      state: 'present',
      shasum: null,
      deferEqual: true,
    });
  });
});

describe('契约 3 parseNpmPackJson：prepare 钩子 stdout 前置污染剥离（CI 33545358469 根因锁）', () => {
  it('「钩子已安装」行前置的真实 pack JSON 剥离后可解析', () => {
    // npm pack 前跑 prepare 生命周期（install-hooks console.log → stdout 并入
    // 主命令 stdout）——直接 JSON.parse 整串必炸（Unexpected token '钩'）
    const polluted =
      '钩子已安装：core.hooksPath → .githooks（提交前四门禁执法）\n[\n  {\n    "filename": "x.tgz"\n  }\n]\n';
    const out = parseNpmPackJson(polluted);
    expect(out).toEqual([{ filename: 'x.tgz' }]);
  });

  it('干净 JSON 直通；不可解析串返回 null（调用方报原错）', () => {
    expect(parseNpmPackJson('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(parseNpmPackJson('根本不是 JSON')).toBeNull();
    expect(parseNpmPackJson('prefix [broken')).toBeNull();
  });
});

describe('契约 4 decideIdempotent：幂等收口两支', () => {
  it('缺席 → 发', () => {
    expect(decideIdempotent({ state: 'absent' }, 'aa')).toEqual({ action: 'publish' });
  });
  it('在场同 shasum → 跳过（中断重跑态）', () => {
    expect(decideIdempotent({ state: 'present', shasum: 'aa' }, 'aa').action).toBe('skip');
  });
  it('在场异 shasum → 响亮拒（同号不同内容永不可写）', () => {
    expect(decideIdempotent({ state: 'present', shasum: 'bb' }, 'aa').action).toBe('reject');
  });
  it('不可达 → 拒发', () => {
    expect(decideIdempotent({ state: 'unreachable', stderr: 'x' }, 'aa').action).toBe('reject');
  });
  it('deferEqual → 与本地任何 shasum 等价（跳过）', () => {
    expect(decideIdempotent({ state: 'present', shasum: null, deferEqual: true }, 'zz').action).toBe('skip');
  });
});

describe('契约 5 planTagOperations / assertDistTagTerminal：终态统一律', () => {
  it('prerelease（alpha/rc 同律）→ publish --tag next + 补 latest + 两腿同指', () => {
    expect(planTagOperations('1.0.0-alpha.3')).toEqual({
      isPrerelease: true,
      publishTag: 'next',
      postAdds: ['latest'],
      expectedTags: { latest: '1.0.0-alpha.3', next: '1.0.0-alpha.3' },
    });
    expect(planTagOperations('1.0.0-rc.1').publishTag).toBe('next'); // rc 同律
  });
  it('正式版 → publish --tag latest、零 dist-tag add、只断言 latest', () => {
    expect(planTagOperations('1.0.0')).toEqual({
      isPrerelease: false,
      publishTag: 'latest',
      postAdds: [],
      expectedTags: { latest: '1.0.0' },
    });
  });
  it('preview 期两腿同指断言：绿', () => {
    expect(() =>
      assertDistTagTerminal(
        { latest: '1.0.0-alpha.3', next: '1.0.0-alpha.3' },
        { isPrerelease: true, version: '1.0.0-alpha.3' },
      ),
    ).not.toThrow();
  });
  it('latest 错腿 → 断言失败（半成功态必须被人看见）', () => {
    expect(() =>
      assertDistTagTerminal(
        { latest: '0.0.0-evil', next: '1.0.0-alpha.3' },
        { isPrerelease: true, version: '1.0.0-alpha.3' },
      ),
    ).toThrow(/latest/);
  });
  it('preview 期 next 掉队 → 断言失败', () => {
    expect(() =>
      assertDistTagTerminal(
        { latest: '1.0.0-alpha.3', next: '1.0.0-alpha.2' },
        { isPrerelease: true, version: '1.0.0-alpha.3' },
      ),
    ).toThrow(/next/);
  });
  it('正式期 next 不动 → 绿；被动过 → 断言失败', () => {
    expect(() =>
      assertDistTagTerminal(
        { latest: '1.0.0', next: '1.0.0-rc.9' },
        { isPrerelease: false, version: '1.0.0', nextBefore: '1.0.0-rc.9' },
      ),
    ).not.toThrow();
    expect(() =>
      assertDistTagTerminal(
        { latest: '1.0.0', next: '1.0.0' },
        { isPrerelease: false, version: '1.0.0', nextBefore: '1.0.0-rc.9' },
      ),
    ).toThrow(/next/);
  });
});

describe('契约 3 inspectPackEntries：files 白名单机器验收', () => {
  /** 通过检视的最小合法清单（bin 入口 + SPA + 技能资产 + README + LICENSE + 教学例 + 官方应用清单 + 出厂技能 + 构建溯源面 + 版本史入口） */
  const CLEAN = [
    'package.json',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
    'dist/app/main.js',
    'dist/webui/index.html',
    'dist/admin/skills/admin/SKILL.md',
    // 构建溯源面（遗漏大扫 20260902 #4）：build 链尾步写的 commit 元数据——缺席
    // 时运行侧 readBuildMeta=null 静默降级，检视面显式锚定
    'dist/.build-meta.json',
    'examples/tool-echo/index.ts',
    'examples/tool-echo/README.md',
    'apps/berrycode.app.yaml',
    'skills/commit-checklist/SKILL.md',
  ];
  it('合法清单 → 绿', () => {
    expect(inspectPackEntries(CLEAN).ok).toBe(true);
  });
  it('缺 SPA / 缺技能资产 / 缺 README / 缺 LICENSE / 缺教学例 → 检视不过（missing 逐项点名）', () => {
    const v = inspectPackEntries(['package.json', 'dist/app/main.js']);
    expect(v.ok).toBe(false);
    expect(v.missing.join(' ')).toMatch(/webui/);
    expect(v.missing.join(' ')).toMatch(/SKILL/);
    expect(v.missing.join(' ')).toMatch(/README/);
    // LICENSE 必在（第四十八批 license=MIT 拍板后升硬门——缺席即发布物残缺）
    expect(v.missing.join(' ')).toMatch(/LICENSE/);
    expect(v.missing.join(' ')).toMatch(/examples/);
  });
  it('缺 apps/ 官方应用清单 / 缺 skills/ 出厂技能 → 检视不过（复盘 G-1：两消费点静默降级，检视面是唯一闸）', () => {
    // apps/ 与 skills/ 缺席时 loadOfficialApps / factorySkillRoot 均走「目录
    // 缺失=静默降级」——装机后默认应用承诺无声破裂，必在清单是收口位
    const v = inspectPackEntries(CLEAN.filter((p) => !p.startsWith('apps/') && !p.startsWith('skills/')));
    expect(v.ok).toBe(false);
    expect(v.missing.join(' ')).toMatch(/apps\/\*\.app\.yaml/);
    expect(v.missing.join(' ')).toMatch(/skills\/\*\/SKILL\.md/);
  });
  it('缺 dist/.build-meta.json 构建溯源面 → 检视不过（遗漏大扫 20260902 #4：此前仅靠 files 含 dist 整目录隐式随包）', () => {
    // 溯源面缺席时运行侧 readBuildMeta=null 静默降级（warnIfStaleDist 永不触发），
    // files 白名单或 npm 打包行为漂移时无机器红——检视面显式锚定后此测锁死
    const v = inspectPackEntries(CLEAN.filter((p) => p !== 'dist/.build-meta.json'));
    expect(v.ok).toBe(false);
    expect(v.missing.join(' ')).toMatch(/dist\/\.build-meta\.json/);
  });
  it('缺 CHANGELOG.md 版本史入口 → 检视不过（遗漏大扫 20260902-b #12：自称随包物但 README/LICENSE 之外裸奔无锚）', () => {
    // files 数组显式含 CHANGELOG.md 且档内自称「包内消费者版本史入口」——手滑
    // 删 files 行时检视照绿的静默漂移恰是白名单机器验收的设计目标所防
    const v = inspectPackEntries(CLEAN.filter((p) => p !== 'CHANGELOG.md'));
    expect(v.ok).toBe(false);
    expect(v.missing.join(' ')).toMatch(/CHANGELOG\.md/);
  });
  it('测试/声明/映射/源码/构建配置混入 → 违禁（violations 逐个点名）', () => {
    const v = inspectPackEntries([
      ...CLEAN,
      'dist/tools/fs.test.js',
      'dist/contracts/index.d.ts',
      'dist/app/main.js.map',
      'src/app/main.ts',
    ]);
    expect(v.ok).toBe(false);
    expect(v.violations).toHaveLength(4);
  });
  it('examples/*.ts 教学源码不违禁（必在例外——随包发布物非待编译源码）', () => {
    // src/ 前缀拒是「产品源码不随包」口径；examples/ 是刻意随包的教学例——
    // 同为 .ts 命运相反，检视器不因扩展名误伤
    const v = inspectPackEntries(CLEAN);
    expect(v.violations.filter((p) => p.startsWith('examples/'))).toHaveLength(0);
  });
  it('dist/ 内非 SKILL.md 的 .md 违禁 / dist/ 内 SKILL.md 放行（基建大扫 #35：检视面贴齐拷贝面口径）', () => {
    // 拷贝面只豁免 SKILL.md（技能资产刚需）；检视面此前对 dist/**/*.md 全放行
    // ——多拷一个 README.md 进 dist 不会被拦。锁：dist 内其余 .md 逐个点名违禁。
    const bad = inspectPackEntries([...CLEAN, 'dist/README.md', 'dist/webui/GUIDE.md']);
    expect(bad.ok).toBe(false);
    expect(bad.violations).toContain('dist/README.md');
    expect(bad.violations).toContain('dist/webui/GUIDE.md');
    // 对照：CLEAN 已含 dist/admin/skills/admin/SKILL.md——零违禁（SKILL.md 例外面在位）
    expect(inspectPackEntries(CLEAN).violations.filter((p) => p.endsWith('.md') && p.startsWith('dist/'))).toHaveLength(
      0,
    );
  });
});

describe('契约 6 classifyGitTag：git tag 幂等判定', () => {
  it('不在 → 打挂；在且同 commit → 跳过；在且异 commit → 响亮拒', () => {
    expect(classifyGitTag(false, undefined, 'sha1')).toEqual({ action: 'create' });
    expect(classifyGitTag(true, 'sha1', 'sha1')).toEqual({ action: 'skip' });
    expect(classifyGitTag(true, 'sha2', 'sha1')).toEqual({ action: 'reject' });
  });
});

// ───────────────── 占位锚与 provenance 条件位（成熟度扫描 20260901 P0-5/P0-6） ─────────────────

describe('publishArgs：provenance 条件位（GITHUB_ACTIONS 当且仅当才带）', () => {
  it('本机形态（无 GITHUB_ACTIONS）：参数面与旧形完全一致——本机零影响', () => {
    expect(publishArgs('/tmp/x.tgz', { publishTag: 'next', dryRun: true, githubActions: false })).toEqual([
      'publish',
      '/tmp/x.tgz',
      '--tag',
      'next',
      '--dry-run',
    ]);
    expect(publishArgs('/tmp/x.tgz', { publishTag: 'latest', dryRun: false, githubActions: false })).toEqual([
      'publish',
      '/tmp/x.tgz',
      '--tag',
      'latest',
    ]);
  });
  it('GitHub Actions 形态：带 --provenance（OIDC 供给在场）；与 --dry-run 可并存', () => {
    expect(publishArgs('/tmp/x.tgz', { publishTag: 'next', dryRun: false, githubActions: true })).toEqual([
      'publish',
      '/tmp/x.tgz',
      '--tag',
      'next',
      '--provenance',
    ]);
    expect(publishArgs('/tmp/x.tgz', { publishTag: 'next', dryRun: true, githubActions: true })).toContain(
      '--provenance',
    );
  });
});

describe('assertNoInstallPlaceholders：发布物占位锚（真发路径 fail-loud）', () => {
  /** 打指定 README 内容的夹具 tgz（落 workDir——writeRealTarball 走真 tar 形态） */
  const fixtureTgz = (files) => writeRealTarball(join(workDir, 'anchor-fixture.tgz'), files);
  it('中文三形占位（<仓库>/<仓库 URL>/<本仓库>）任一命中即拒', () => {
    const shapes = [
      '# t\n\ncurl -fsSL <仓库>/scripts/install.sh | sh\n',
      '# t\n\n安装方式见 <仓库 URL>。\n',
      '# t\ngit clone <本仓库>。\n',
    ];
    for (const text of shapes) {
      // 断言锚在「命中占位」分支（发布物占位锚：…含安装占位符）——非清单读取失败
      // 等 tar 级错误（两者都以「占位锚」开头，须点名分支防假绿）
      expect(() => assertNoInstallPlaceholders(fixtureTgz({ 'README.md': text }))).toThrow(/含安装占位符/);
    }
  });
  it('外语 <repo>/<dépôt> 形同拒（英西 repo / 法 dépôt 与 <ce dépôt> 镜像安装段形态）', () => {
    expect(() =>
      assertNoInstallPlaceholders(fixtureTgz({ 'README.md': '# t\ncurl <repo>/install.sh | sh\n' })),
    ).toThrow(/含安装占位符/);
    expect(() =>
      assertNoInstallPlaceholders(fixtureTgz({ 'README.md': '# t\ncurl -fsSL <dépôt>/scripts/install.sh | sh\n' })),
    ).toThrow(/含安装占位符/);
    expect(() => assertNoInstallPlaceholders(fixtureTgz({ 'README.md': '# t\ngit clone <ce dépôt>.\n' }))).toThrow(
      /含安装占位符/,
    );
  });
  it('干净 README 放行（真实安装命令零占位）', () => {
    expect(() =>
      assertNoInstallPlaceholders(fixtureTgz({ 'README.md': '# berry\n\nnpm i -g berry-agent-os\n' })),
    ).not.toThrow();
  });
  it('README 缺席 = pack 白名单漂移，同锚 fail-loud', () => {
    expect(() => assertNoInstallPlaceholders(fixtureTgz({ 'other.md': 'x' }))).toThrow(/白名单漂移/);
  });
});

// ───────────────── 编排骨舞（io 注入缝全脚本化——零真实 npm/git） ─────────────────

/** 每测独立的临时工作目录（pack 落点/dist 清扫锚定；不污染仓库） */
let workDir;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'release-test-'));
  // 仓内官方应用清单最小真形（基建大扫 #36）：installSmoke 的「默认应用：…」
  // 断言串自 readDefaultAppId(workDir) 动态拼出——夹具须与真实仓 apps/ 形态
  // 对齐（default 键真源），否则 green 路径误报「清单缺席」
  mkdirSync(join(workDir, 'apps'), { recursive: true });
  writeFileSync(join(workDir, 'apps', 'berrycode.app.yaml'), 'id: berrycode\nlabel: 代码\ndefault: true\n');
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * 打一只真形态最小 tarball（成熟度扫描 20260901 P0-6）：占位锚在真发路径
 * spawnSync tar 直读上传物——假字节被 `tar -tzf` 拒收，故夹具必须走真 tar。
 * files：package/ 内文件名 → 内容映射；缺省 = 干净 README（greenBase 真发
 * 路径用——底座不得自带占位符，否则锚本职（命中即拒）反咬底座自身）。
 */
function writeRealTarball(tgzPath, files = { 'README.md': '# berry-agent-os\n\nnpm i -g berry-agent-os\n' }) {
  const src = mkdtempSync(join(tmpdir(), 'release-tarball-src-'));
  try {
    mkdirSync(join(src, 'package'), { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(src, 'package', name), text);
    const r = spawnSync('tar', ['-czf', tgzPath, '-C', src, 'package']);
    if (r.status !== 0) throw new Error(`夹具 tgz 打包失败：${r.stderr}`);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
  return tgzPath;
}

/**
 * 全脚本化 io：canned 表按步骤标签喂应答（缺标签即抛——每测的 canned 面必须
 * 恰好覆盖其路径真实触达的每个步骤，静默缺口 = 测试脚本自身的 bug）。
 * 返回 { io, calls }——calls 记录每次调用（label/args/opts），供步骤序、参数
 * 与 opts.cwd 锚定断言（基建大扫 #21）。
 */
function scriptedIo(canned) {
  const calls = [];
  return {
    calls,
    io: {
      exec(label, command, args, opts) {
        calls.push({ label, command, args, opts });
        const handler = canned[label];
        if (!handler) throw new Error(`测试脚本缺口：步骤 ${label} 未编入 canned 表`);
        return handler();
      },
    },
  };
}

/**
 * 编排骨舞断言用的 publish 期望 args（provenance 条件位对齐——成熟度扫描
 * P0-5）：runRelease 内部读 process.env.GITHUB_ACTIONS 决定是否追加
 * --provenance（publishArgs 同序：--tag 之后、--dry-run 之前）；GitHub
 * Actions 上跑 vitest 进程继承该 env，硬编码基线必红（cfc5f83b 四测连红
 * 实锚——本地绿/CI 红 = env 差非行为差）。本机无该 env 落基线形态。
 */
function publishExpect(dir, publishTag, dryRun = false) {
  return [
    'publish',
    join(dir, 'berry-agent-os-fake.tgz'),
    '--tag',
    publishTag,
    ...(process.env.GITHUB_ACTIONS ? ['--provenance'] : []),
    ...(dryRun ? ['--dry-run'] : []),
  ];
}

/** 四门禁 + 净空 + 构建 + 双 pack + 安装冒烟的全绿底座（各测按路径增删） */
function greenBase(version) {
  return {
    'gate:typecheck': () => ({ code: 0, stdout: '', stderr: '' }),
    'gate:test': () => ({ code: 0, stdout: '', stderr: '' }),
    'gate:lint:topology': () => ({ code: 0, stdout: '', stderr: '' }),
    'gate:format:check': () => ({ code: 0, stdout: '', stderr: '' }),
    'git-clean': () => ({ code: 0, stdout: '', stderr: '' }),
    probe: () => ({ code: 1, stdout: '', stderr: 'npm error code E404' }), // 缺席 = 正常发
    build: () => ({ code: 0, stdout: '', stderr: '' }),
    'pack:inspect': () => ({
      code: 0,
      stdout: JSON.stringify([
        {
          filename: 'berry-agent-os-fake.tgz',
          files: [
            'package.json',
            'README.md',
            'LICENSE',
            // 版本史入口（遗漏大扫 20260902-b #12）：greenBase 罐头面与必在清单同步——
            // 缺行会让契约 3 检视在管线测里红（夹具随身带新锚面，先例=上 #4 溯源面注）
            'CHANGELOG.md',
            'dist/app/main.js',
            'dist/webui/index.html',
            'dist/admin/skills/admin/SKILL.md',
            // 溯源面（遗漏大扫 20260902 #4）：greenBase 罐头面与必在清单同步——
            // 缺行会让契约 3 检视在管线测里红（夹具随身带新锚面）
            'dist/.build-meta.json',
            'examples/tool-echo/index.ts',
            'examples/tool-echo/README.md',
            'apps/berrycode.app.yaml',
            'skills/commit-checklist/SKILL.md',
          ],
        },
      ]),
      stderr: '',
    }),
    'pack:real': () => {
      // 真形态 tarball（P0-6 占位锚直读上传物——见 writeRealTarball 注释）
      writeRealTarball(join(workDir, 'berry-agent-os-fake.tgz'));
      return { code: 0, stdout: JSON.stringify([{ filename: 'berry-agent-os-fake.tgz' }]), stderr: '' };
    },
    'smoke:install': () => ({ code: 0, stdout: '', stderr: '' }),
    // 应答须取真 bin 输出形态（遗漏大扫 L-6）：--version 自第五十批起打印
    // `<semver> "<代号>"`（VERSION_WITH_CODENAME）——罐头面失真 = 断言形态回退
    // 时测试照绿的假绿（O-10 即该形态实证：断言错成裸 semver 精确比较测试仍全绿）
    'smoke:run': () => ({ code: 0, stdout: `${version} "Peiligang"\n`, stderr: '' }),
    // 真握手（复盘 G-1）：dump-config 断言官方应用清单在场（默认应用 = berrycode）
    'smoke:apps': () => ({ code: 0, stdout: '默认应用：berrycode\n', stderr: '' }),
    publish: () => ({ code: 0, stdout: '', stderr: '' }),
  };
}

/** labels 快捷断言面 */
const labels = (calls) => calls.map((c) => c.label);

describe('runRelease 编排骨舞：preview 期 prerelease 全绿路径', () => {
  it('缺席 → publish --tag next → dist-tag add latest → 终态断言 → git tag 打挂', async () => {
    const version = '1.0.0-alpha.3';
    const base = greenBase(version);
    base['dist-tag-add'] = () => ({ code: 0, stdout: '', stderr: '' });
    base['view-tags:post'] = () => ({
      code: 0,
      stdout: JSON.stringify({ latest: version, next: version }),
      stderr: '',
    });
    base['git-tag:list'] = () => ({ code: 0, stdout: '', stderr: '' }); // tag 不在
    base['git-rev:head'] = () => ({ code: 0, stdout: 'abc123\n', stderr: '' });
    base['git-tag:create'] = () => ({ code: 0, stdout: '', stderr: '' });
    base['git-tag:push'] = () => ({ code: 0, stdout: '', stderr: '' });
    const { io, calls } = scriptedIo(base);

    const summary = await runRelease([], io, { workDir, pkg: { name: 'berry-agent-os', version, binName: 'berry' } });

    expect(summary.published).toBe(true);
    expect(summary.gitTag).toBe('create');
    // tag push 恒带 HTTP/1.1（遗漏大扫 20260901-c #17）：与仓库推送纪律/归档机器
    // 同律——release 机器不得是全仓唯一裸 push 的例外（本机 HTTP/2 推流必挂）
    expect(calls.find((c) => c.label === 'git-tag:push').args).toEqual([
      '-c',
      'http.version=HTTP/1.1',
      'push',
      'origin',
      'v1.0.0-alpha.3',
    ]);
    // publish 单点：上传物 = tarball 本体 + prerelease 显式 next
    const pub = calls.find((c) => c.label === 'publish');
    expect(pub.args).toEqual(publishExpect(workDir, 'next'));
    // dist-tag add 补 latest 腿（next 腿由 publish 立起）
    expect(labels(calls).filter((l) => l === 'dist-tag-add')).toEqual(['dist-tag-add']);
    expect(calls.find((c) => c.label === 'dist-tag-add').args).toEqual([
      'dist-tag',
      'add',
      'berry-agent-os@1.0.0-alpha.3',
      'latest',
    ]);
    // 基建大扫 #21 锁：子进程锚定发布根——注入缝收到的每次 exec 均带
    // cwd: workDir（包装层缺省注入；从任意 cwd 发起 release 不再落错根）
    for (const c of calls) {
      expect(c.opts?.cwd, `步骤 ${c.label} 缺 cwd 锚定`).toBe(workDir);
    }
    // 步骤序：探测先于 pack（契约 2 先行），publish 先于终态断言
    expect(labels(calls).indexOf('probe')).toBeLessThan(labels(calls).indexOf('pack:real'));
    expect(labels(calls).indexOf('publish')).toBeLessThan(labels(calls).indexOf('view-tags:post'));
    // preview 期不需要 pre 快照
    expect(labels(calls)).not.toContain('view-tags:pre');
    // tarball 即用即清：真发路径收口后工作目录无打包产物残留（防下一轮净空核验自锁）
    expect(existsSync(join(workDir, 'berry-agent-os-fake.tgz'))).toBe(false);
  });
});

describe('runRelease 编排骨舞：正式版分叉路径', () => {
  it('正式版 → publish --tag latest、零 dist-tag add、next 不动对照 pre 快照', async () => {
    const version = '1.0.0';
    const base = greenBase(version);
    base['view-tags:pre'] = () => ({
      code: 0,
      stdout: JSON.stringify({ latest: '0.9.0', next: '1.0.0-rc.9' }),
      stderr: '',
    });
    base['view-tags:post'] = () => ({
      code: 0,
      stdout: JSON.stringify({ latest: '1.0.0', next: '1.0.0-rc.9' }),
      stderr: '',
    });
    base['git-tag:list'] = () => ({ code: 0, stdout: 'v1.0.0\n', stderr: '' }); // 已在
    base['git-rev:tag'] = () => ({ code: 0, stdout: 'abc123\n', stderr: '' });
    base['git-rev:head'] = () => ({ code: 0, stdout: 'abc123\n', stderr: '' }); // 同 commit
    const { io, calls } = scriptedIo(base);

    const summary = await runRelease([], io, { workDir, pkg: { name: 'berry-agent-os', version, binName: 'berry' } });

    expect(summary.published).toBe(true);
    expect(summary.gitTag).toBe('skip'); // 同 commit 幂等跳过
    expect(calls.find((c) => c.label === 'publish').args).toEqual(publishExpect(workDir, 'latest'));
    expect(labels(calls)).not.toContain('dist-tag-add');
    // pre 快照先于 publish（「next 不动」的基准必须取在任何写操作前）
    expect(labels(calls).indexOf('view-tags:pre')).toBeLessThan(labels(calls).indexOf('publish'));
    expect(labels(calls)).not.toContain('git-tag:create');
  });
});

describe('runRelease 演习矩阵：--dry-run 行为（检视/冒烟真做，写面全收）', () => {
  it('dry-run → publish 带 --dry-run、零 dist-tag add、终态走纯函数投影、git tag 不打不推', async () => {
    const version = '1.0.0-alpha.3';
    const base = greenBase(version);
    base['git-tag:list'] = () => ({ code: 0, stdout: '', stderr: '' });
    base['git-rev:head'] = () => ({ code: 0, stdout: 'abc123\n', stderr: '' });
    const { io, calls } = scriptedIo(base);

    const summary = await runRelease(['--dry-run'], io, {
      workDir,
      pkg: { name: 'berry-agent-os', version, binName: 'berry' },
    });

    expect(summary.published).toBe(false);
    expect(summary.dryRun).toBe(true);
    expect(calls.find((c) => c.label === 'publish').args).toEqual(publishExpect(workDir, 'next', true));
    const ran = labels(calls);
    expect(ran).not.toContain('dist-tag-add');
    expect(ran).not.toContain('view-tags:post'); // 无注入时终态走投影断言
    expect(ran).not.toContain('git-tag:create');
    expect(ran).not.toContain('git-tag:push');
    // build/pack/冒烟在 dry-run 下照真做（契约 3 真做）
    expect(ran).toContain('build');
    expect(ran).toContain('pack:inspect');
    expect(ran).toContain('smoke:run');
    // tarball 即用即清在 dry-run 路径同律（演习不留残留）
    expect(existsSync(join(workDir, 'berry-agent-os-fake.tgz'))).toBe(false);
  });

  it('正式版 dry-run → 投影断言不喂 nextBefore（期望终态自身即绿，遗漏大扫 20260901-c #8）', async () => {
    const version = '1.0.0';
    const base = greenBase(version);
    // 正式版照取 pre 快照（「next 不动」基准）——投影断言路不吃它，实测路才吃；
    // 修复前投影路误喂 nextBefore，期望终态无 next 键必炸「next 被动过」假象
    base['view-tags:pre'] = () => ({
      code: 0,
      stdout: JSON.stringify({ latest: '0.9.0', next: '1.0.0-rc.9' }),
      stderr: '',
    });
    base['git-tag:list'] = () => ({ code: 0, stdout: '', stderr: '' });
    base['git-rev:head'] = () => ({ code: 0, stdout: 'abc123\n', stderr: '' });
    const { io, calls } = scriptedIo(base);

    const summary = await runRelease(['--dry-run'], io, {
      workDir,
      pkg: { name: 'berry-agent-os', version, binName: 'berry' },
    });

    expect(summary.published).toBe(false);
    expect(summary.expectedTags).toEqual({ latest: '1.0.0' });
    expect(calls.find((c) => c.label === 'publish').args).toEqual(publishExpect(workDir, 'latest', true));
    expect(labels(calls)).not.toContain('dist-tag-add');
    // pre 快照照取（正式版两态同律），只是投影断言不消费它
    expect(labels(calls)).toContain('view-tags:pre');
  });
});

describe('runRelease 失败注入谱（--inject 与测试同表——演习两轮留档即本组）', () => {
  it('gate-red：门禁红拒——probe/publish 永不触达（无 skip 出口）', async () => {
    const version = '1.0.0-alpha.3';
    const base = greenBase(version); // 谱外步骤照走 canned 底座
    const { io, calls } = scriptedIo(base);
    await expect(
      runRelease(['--inject', 'gate-red'], applyScenario(io, INJECT_SCENARIOS['gate-red']), {
        workDir,
        pkg: { name: 'berry-agent-os', version, binName: 'berry' },
      }),
    ).rejects.toThrow(/门禁红拒/);
    const ran = labels(calls);
    expect(ran).toContain('gate:typecheck'); // typecheck 先真跑过
    expect(ran).not.toContain('probe'); // 门禁红即止
    expect(ran).not.toContain('publish');
  });

  it('smoke-exit-red：dump-config 退出码非 0 拒——publish 永不触达（G-1 真握手闸红例，遗漏大扫 20260901-b #25）', async () => {
    const version = '1.0.0-alpha.3';
    const base = greenBase(version);
    const { io, calls } = scriptedIo(base);
    await expect(
      runRelease(['--inject', 'smoke-exit-red'], applyScenario(io, INJECT_SCENARIOS['smoke-exit-red']), {
        workDir,
        pkg: { name: 'berry-agent-os', version, binName: 'berry' },
      }),
    ).rejects.toThrow(/安装冒烟失败：.* dump-config 退出码 1/);
    const ran = labels(calls);
    expect(ran).toContain('smoke:run'); // 冒烟段真到过（smoke:apps 本尊被注入器接管不进记录）
    expect(ran).not.toContain('publish'); // 装机产物不可装配即止
  });

  it('smoke-apps-missing：dump-config 未见「默认应用：berrycode」拒——publish 永不触达（G-1 真握手闸红例，遗漏大扫 20260901-b #25）', async () => {
    const version = '1.0.0-alpha.3';
    const base = greenBase(version);
    const { io, calls } = scriptedIo(base);
    await expect(
      runRelease(['--inject', 'smoke-apps-missing'], applyScenario(io, INJECT_SCENARIOS['smoke-apps-missing']), {
        workDir,
        pkg: { name: 'berry-agent-os', version, binName: 'berry' },
      }),
    ).rejects.toThrow(/未见「默认应用：berrycode」/);
    const ran = labels(calls);
    expect(ran).toContain('smoke:run'); // 冒烟段真到过（smoke:apps 本尊被注入器接管不进记录）
    expect(ran).not.toContain('publish');
  });

  it('shasum-mismatch：同版本异质响亮拒——publish 永不触达', async () => {
    const version = '1.0.0-alpha.3';
    const base = greenBase(version); // probe 被谱接管（在场异质），其余照底座
    const { io, calls } = scriptedIo(base);
    await expect(
      runRelease(['--dry-run', '--inject', 'shasum-mismatch'], applyScenario(io, INJECT_SCENARIOS['shasum-mismatch']), {
        workDir,
        pkg: { name: 'berry-agent-os', version, binName: 'berry' },
      }),
    ).rejects.toThrow(/同版本异质/);
    expect(labels(calls)).not.toContain('publish');
  });

  it('assert-fail：dist-tag 断言失败拒——publish 已干跑、断言吃注入终态后炸', async () => {
    const version = '1.0.0-alpha.3';
    const base = greenBase(version);
    const { io, calls } = scriptedIo(base);
    await expect(
      runRelease(['--dry-run', '--inject', 'assert-fail'], applyScenario(io, INJECT_SCENARIOS['assert-fail']), {
        workDir,
        pkg: { name: 'berry-agent-os', version, binName: 'berry' },
      }),
    ).rejects.toThrow(/dist-tag 断言失败/);
    const pub = calls.find((c) => c.label === 'publish');
    expect(pub.args).toContain('--dry-run'); // 断言失败演习不触网写
    // 注入拦截发生在 applyScenario 层（不进 calls 记录）——「注入终态走了实测
    // 断言路」的证据即上面那条 rejects：纯函数投影路在 prerelease 期望终态上
    // 恒绿，能炸的只有 canned 终态穿过 assertDistTagTerminal 这一条路
  });

  it('assert-fail 无 --dry-run → 组合闸拦在契约 1 之前（遗漏大扫 20260901-c #7）', async () => {
    const version = '1.0.0-alpha.3';
    const { io, calls } = scriptedIo(greenBase(version));
    await expect(
      runRelease(['--inject', 'assert-fail'], applyScenario(io, INJECT_SCENARIOS['assert-fail']), {
        workDir,
        pkg: { name: 'berry-agent-os', version, binName: 'berry' },
      }),
    ).rejects.toThrow(/须配 --dry-run/);
    // 闸在契约 1 之前：零步骤触达（连门禁都没跑）——无闸形态会一路真上传到
    // 契约 5 才撞注入终态，留半成功态
    expect(calls).toEqual([]);
  });

  it('interrupt-rerun（dry-run）：幂等跳过 publish——后续步骤照跑', async () => {
    const version = '1.0.0-alpha.3';
    const base = greenBase(version); // probe 被谱接管（deferEqual 等价）
    base['git-tag:list'] = () => ({ code: 0, stdout: '', stderr: '' });
    base['git-rev:head'] = () => ({ code: 0, stdout: 'abc123\n', stderr: '' });
    const { io, calls } = scriptedIo(base);
    const summary = await runRelease(
      ['--dry-run', '--inject', 'interrupt-rerun'],
      applyScenario(io, INJECT_SCENARIOS['interrupt-rerun']),
      { workDir, pkg: { name: 'berry-agent-os', version, binName: 'berry' } },
    );
    expect(summary.skippedPublish).toBe(true);
    expect(summary.published).toBe(false);
    expect(labels(calls)).not.toContain('publish'); // 版本字节上传被跳过
    expect(labels(calls)).toContain('smoke:run'); // 冒烟照跑（后续步骤照跑）
  });

  it('interrupt-rerun（真跑形态）：publish 跳过但 dist-tag add 与终态断言照跑', async () => {
    const version = '1.0.0-alpha.3';
    const base = greenBase(version);
    base['dist-tag-add'] = () => ({ code: 0, stdout: '', stderr: '' });
    base['view-tags:post'] = () => ({
      code: 0,
      stdout: JSON.stringify({ latest: version, next: version }),
      stderr: '',
    });
    base['git-tag:list'] = () => ({ code: 0, stdout: '', stderr: '' });
    base['git-rev:head'] = () => ({ code: 0, stdout: 'abc123\n', stderr: '' });
    base['git-tag:create'] = () => ({ code: 0, stdout: '', stderr: '' });
    base['git-tag:push'] = () => ({ code: 0, stdout: '', stderr: '' });
    const { io, calls } = scriptedIo(base);
    const summary = await runRelease(
      ['--inject', 'interrupt-rerun'],
      applyScenario(io, INJECT_SCENARIOS['interrupt-rerun']),
      {
        workDir,
        pkg: { name: 'berry-agent-os', version, binName: 'berry' },
      },
    );
    expect(summary.skippedPublish).toBe(true);
    expect(labels(calls)).not.toContain('publish');
    expect(labels(calls)).toContain('dist-tag-add'); // 断腿的 dist-tag 照补
    expect(labels(calls)).toContain('view-tags:post'); // 终态断言照跑
    expect(summary.gitTag).toBe('create'); // 尾件照挂
  });
});

describe('runRelease 前置防线（净空核 / 不可达拒 / 检视不过）', () => {
  it('工作树非净空 → 拒发未提交态', async () => {
    const version = '1.0.0-alpha.3';
    const base = greenBase(version);
    base['git-clean'] = () => ({ code: 0, stdout: 'M src/app/main.ts\n', stderr: '' });
    const { io } = scriptedIo(base);
    await expect(
      runRelease([], io, { workDir, pkg: { name: 'berry-agent-os', version, binName: 'berry' } }),
    ).rejects.toThrow(/非净空/);
  });

  it('registry 探测不可达 → 拒发不盲发', async () => {
    const version = '1.0.0-alpha.3';
    const base = greenBase(version);
    base.probe = () => ({ code: 1, stdout: '', stderr: 'npm error code ETIMEDOUT' });
    const { io, calls } = scriptedIo(base);
    await expect(
      runRelease([], io, { workDir, pkg: { name: 'berry-agent-os', version, binName: 'berry' } }),
    ).rejects.toThrow(/不可达/);
    expect(labels(calls)).not.toContain('publish');
  });

  it('pack 检视违禁（测试产物混入）→ 构建后即拒', async () => {
    const version = '1.0.0-alpha.3';
    const base = greenBase(version);
    base['pack:inspect'] = () => ({
      code: 0,
      stdout: JSON.stringify([
        {
          filename: 'berry-agent-os-fake.tgz',
          files: ['package.json', 'README.md', 'dist/app/main.js', 'dist/webui/index.html', 'dist/tools/fs.test.js'],
        },
      ]),
      stderr: '',
    });
    const { io, calls } = scriptedIo(base);
    await expect(
      runRelease([], io, { workDir, pkg: { name: 'berry-agent-os', version, binName: 'berry' } }),
    ).rejects.toThrow(/检视不过/);
    expect(labels(calls)).not.toContain('pack:real');
  });
});

describe('安装冒烟两断言负例（遗漏大扫 20260901 O-10 + L-6——探针执行锁）', () => {
  it('smoke:run 版本漂移（异 semver 代号形态）→ 拒；publish 永不触达', async () => {
    const version = '1.0.0-alpha.3';
    const base = greenBase(version);
    base['smoke:run'] = () => ({ code: 0, stdout: '0.9.9-evil "Old"\n', stderr: '' });
    const { io, calls } = scriptedIo(base);
    await expect(
      runRelease([], io, { workDir, pkg: { name: 'berry-agent-os', version, binName: 'berry' } }),
    ).rejects.toThrow(/版本漂移/);
    expect(labels(calls)).not.toContain('publish');
  });

  it('smoke:run 前缀吞 prerelease（bin=1.0.0-alpha.9 而 package.json=1.0.0）→ 拒（naive startsWith 假绿腿）', async () => {
    // 断言形态锁的窄缝：裸 startsWith('1.0.0') 会放行 '1.0.0-alpha.9 "…"'——
    // 正式版发版窗口 version.ts 残留 prerelease 即该形态，结构前缀断言必红
    const version = '1.0.0';
    const base = greenBase(version);
    base['smoke:run'] = () => ({ code: 0, stdout: '1.0.0-alpha.9 "Peiligang"\n', stderr: '' });
    const { io } = scriptedIo(base);
    await expect(
      runRelease([], io, { workDir, pkg: { name: 'berry-agent-os', version, binName: 'berry' } }),
    ).rejects.toThrow(/版本漂移/);
  });

  it('smoke:apps 未见「默认应用：berrycode」→ 拒（dump-config 真握手探针的执行锁——探针被删/断言放空必红）', async () => {
    // L-6 锁体：greenBase 只供应答不锁探针在岗——本例罐头应答取「合法退出码但
    // 无标记」形态，若探针步骤或其断言被整块拆除，本测必红（O-10 即该假绿实证）
    const version = '1.0.0-alpha.3';
    const base = greenBase(version);
    base['smoke:apps'] = () => ({ code: 0, stdout: '（官方应用清单空）\n', stderr: '' });
    const { io, calls } = scriptedIo(base);
    await expect(
      runRelease([], io, { workDir, pkg: { name: 'berry-agent-os', version, binName: 'berry' } }),
    ).rejects.toThrow(/默认应用/);
    expect(labels(calls)).not.toContain('publish');
  });
});

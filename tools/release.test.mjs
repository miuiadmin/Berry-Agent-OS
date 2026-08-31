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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INJECT_SCENARIOS,
  applyScenario,
  assertDistTagTerminal,
  classifyGitTag,
  classifyProbe,
  decideIdempotent,
  inspectPackEntries,
  planTagOperations,
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
  /** 通过检视的最小合法清单（bin 入口 + SPA + 技能资产 + README + LICENSE + 教学例 + 官方应用清单 + 出厂技能） */
  const CLEAN = [
    'package.json',
    'README.md',
    'LICENSE',
    'dist/app/main.js',
    'dist/webui/index.html',
    'dist/admin/skills/admin/SKILL.md',
    'examples/tool-echo/index.ts',
    'examples/tool-echo/README.md',
    'apps/coder.app.yaml',
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
});

describe('契约 6 classifyGitTag：git tag 幂等判定', () => {
  it('不在 → 打挂；在且同 commit → 跳过；在且异 commit → 响亮拒', () => {
    expect(classifyGitTag(false, undefined, 'sha1')).toEqual({ action: 'create' });
    expect(classifyGitTag(true, 'sha1', 'sha1')).toEqual({ action: 'skip' });
    expect(classifyGitTag(true, 'sha2', 'sha1')).toEqual({ action: 'reject' });
  });
});

// ───────────────── 编排骨舞（io 注入缝全脚本化——零真实 npm/git） ─────────────────

/** 每测独立的临时工作目录（pack 落点/dist 清扫锚定；不污染仓库） */
let workDir;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'release-test-'));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 假 tarball 内容（sha1 稳定——幂等比对基准） */
const FAKE_TARBALL_BYTES = 'fake-tarball-bytes-for-sha1';

/**
 * 全脚本化 io：canned 表按步骤标签喂应答（缺标签即抛——每测的 canned 面必须
 * 恰好覆盖其路径真实触达的每个步骤，静默缺口 = 测试脚本自身的 bug）。
 * 返回 { io, calls }——calls 记录每次调用（label/args），供步骤序与参数断言。
 */
function scriptedIo(canned) {
  const calls = [];
  return {
    calls,
    io: {
      exec(label, command, args) {
        calls.push({ label, command, args });
        const handler = canned[label];
        if (!handler) throw new Error(`测试脚本缺口：步骤 ${label} 未编入 canned 表`);
        return handler();
      },
    },
  };
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
          filename: 'berryagent-fake.tgz',
          files: [
            'package.json',
            'README.md',
            'LICENSE',
            'dist/app/main.js',
            'dist/webui/index.html',
            'dist/admin/skills/admin/SKILL.md',
            'examples/tool-echo/index.ts',
            'examples/tool-echo/README.md',
            'apps/coder.app.yaml',
            'skills/commit-checklist/SKILL.md',
          ],
        },
      ]),
      stderr: '',
    }),
    'pack:real': () => {
      writeFileSync(join(workDir, 'berryagent-fake.tgz'), FAKE_TARBALL_BYTES);
      return { code: 0, stdout: JSON.stringify([{ filename: 'berryagent-fake.tgz' }]), stderr: '' };
    },
    'smoke:install': () => ({ code: 0, stdout: '', stderr: '' }),
    'smoke:run': () => ({ code: 0, stdout: version + '\n', stderr: '' }),
    // 真握手（复盘 G-1）：dump-config 断言官方应用清单在场（默认应用 = coder）
    'smoke:apps': () => ({ code: 0, stdout: '默认应用：coder\n', stderr: '' }),
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

    const summary = await runRelease([], io, { workDir, pkg: { name: 'berryagent', version, binName: 'berry' } });

    expect(summary.published).toBe(true);
    expect(summary.gitTag).toBe('create');
    // publish 单点：上传物 = tarball 本体 + prerelease 显式 next
    const pub = calls.find((c) => c.label === 'publish');
    expect(pub.args).toEqual(['publish', join(workDir, 'berryagent-fake.tgz'), '--tag', 'next']);
    // dist-tag add 补 latest 腿（next 腿由 publish 立起）
    expect(labels(calls).filter((l) => l === 'dist-tag-add')).toEqual(['dist-tag-add']);
    expect(calls.find((c) => c.label === 'dist-tag-add').args).toEqual([
      'dist-tag',
      'add',
      'berryagent@1.0.0-alpha.3',
      'latest',
    ]);
    // 步骤序：探测先于 pack（契约 2 先行），publish 先于终态断言
    expect(labels(calls).indexOf('probe')).toBeLessThan(labels(calls).indexOf('pack:real'));
    expect(labels(calls).indexOf('publish')).toBeLessThan(labels(calls).indexOf('view-tags:post'));
    // preview 期不需要 pre 快照
    expect(labels(calls)).not.toContain('view-tags:pre');
    // tarball 即用即清：真发路径收口后工作目录无打包产物残留（防下一轮净空核验自锁）
    expect(existsSync(join(workDir, 'berryagent-fake.tgz'))).toBe(false);
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

    const summary = await runRelease([], io, { workDir, pkg: { name: 'berryagent', version, binName: 'berry' } });

    expect(summary.published).toBe(true);
    expect(summary.gitTag).toBe('skip'); // 同 commit 幂等跳过
    expect(calls.find((c) => c.label === 'publish').args).toEqual([
      'publish',
      join(workDir, 'berryagent-fake.tgz'),
      '--tag',
      'latest',
    ]);
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
      pkg: { name: 'berryagent', version, binName: 'berry' },
    });

    expect(summary.published).toBe(false);
    expect(summary.dryRun).toBe(true);
    expect(calls.find((c) => c.label === 'publish').args).toEqual([
      'publish',
      join(workDir, 'berryagent-fake.tgz'),
      '--tag',
      'next',
      '--dry-run',
    ]);
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
    expect(existsSync(join(workDir, 'berryagent-fake.tgz'))).toBe(false);
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
        pkg: { name: 'berryagent', version, binName: 'berry' },
      }),
    ).rejects.toThrow(/门禁红拒/);
    const ran = labels(calls);
    expect(ran).toContain('gate:typecheck'); // typecheck 先真跑过
    expect(ran).not.toContain('probe'); // 门禁红即止
    expect(ran).not.toContain('publish');
  });

  it('shasum-mismatch：同版本异质响亮拒——publish 永不触达', async () => {
    const version = '1.0.0-alpha.3';
    const base = greenBase(version); // probe 被谱接管（在场异质），其余照底座
    const { io, calls } = scriptedIo(base);
    await expect(
      runRelease(['--dry-run', '--inject', 'shasum-mismatch'], applyScenario(io, INJECT_SCENARIOS['shasum-mismatch']), {
        workDir,
        pkg: { name: 'berryagent', version, binName: 'berry' },
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
        pkg: { name: 'berryagent', version, binName: 'berry' },
      }),
    ).rejects.toThrow(/dist-tag 断言失败/);
    const pub = calls.find((c) => c.label === 'publish');
    expect(pub.args).toContain('--dry-run'); // 断言失败演习不触网写
    // 注入拦截发生在 applyScenario 层（不进 calls 记录）——「注入终态走了实测
    // 断言路」的证据即上面那条 rejects：纯函数投影路在 prerelease 期望终态上
    // 恒绿，能炸的只有 canned 终态穿过 assertDistTagTerminal 这一条路
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
      { workDir, pkg: { name: 'berryagent', version, binName: 'berry' } },
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
        pkg: { name: 'berryagent', version, binName: 'berry' },
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
      runRelease([], io, { workDir, pkg: { name: 'berryagent', version, binName: 'berry' } }),
    ).rejects.toThrow(/非净空/);
  });

  it('registry 探测不可达 → 拒发不盲发', async () => {
    const version = '1.0.0-alpha.3';
    const base = greenBase(version);
    base.probe = () => ({ code: 1, stdout: '', stderr: 'npm error code ETIMEDOUT' });
    const { io, calls } = scriptedIo(base);
    await expect(
      runRelease([], io, { workDir, pkg: { name: 'berryagent', version, binName: 'berry' } }),
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
          filename: 'berryagent-fake.tgz',
          files: ['package.json', 'README.md', 'dist/app/main.js', 'dist/webui/index.html', 'dist/tools/fs.test.js'],
        },
      ]),
      stderr: '',
    });
    const { io, calls } = scriptedIo(base);
    await expect(
      runRelease([], io, { workDir, pkg: { name: 'berryagent', version, binName: 'berry' } }),
    ).rejects.toThrow(/检视不过/);
    expect(labels(calls)).not.toContain('pack:real');
  });
});

#!/usr/bin/env node
/**
 * 发布机器（技术栈篇 §8.3，第四十批规范先行 2026-08-31；路线图 Ring 3 前置
 * 行动 6 承接）。手写脚本——仓库手写纪律同向（argv/logger/topology 门禁/MCP
 * 桥皆手写）；npm CLI 为唯一传输层，不自写 registry HTTP。
 *
 * 六道契约（探测序即防线序；触网写面全集 = publish / dist-tag add /
 * git push tag 三点显式在册，除此之外零触网写）：
 *   1. 门禁前置不可绕——四门禁任一红即止（无 skip 旗标）+ 工作树净空核验
 *   2. registry 探测（只读三态：缺席 E404 / 在场 / 不可达拒发）
 *   3. 构建即打包与发布物验收——清 dist 全新 build → pack --dry-run 白名单
 *      检视 → 真打包 → 安装冒烟（tarball 装临时 prefix 后 bin --version = 版本号）
 *   4. 幂等收口与 publish 单点——在场等价（同 shasum）跳过 publish；异质响亮
 *      拒；publish 上传物 = 本脚本打出的 tarball 本体（检视即所传）
 *   5. dist-tag 终态机器断言——preview 期统一律 latest===next===刚发版
 *      （alpha/rc 同律）；首个正式版起分叉（latest=版本号、next 不动）
 *   6. 尾件 git tag——v<version> 幂等打挂（同 commit 跳过 / 异 commit 拒）
 *
 * 用法：
 *   node tools/release.mjs                 # 真发布（六道全跑）
 *   node tools/release.mjs --dry-run       # 演习：门禁/探测/build/pack/冒烟真做，
 *                                          #   publish 走 npm --dry-run、dist-tag
 *                                          #   与 git tag 只断言不执行
 *   node tools/release.mjs --dry-run --inject <谱项>
 *                                          # 失败注入演习（--dry-run 保护下注入
 *                                          #   canned 应答；谱项见 INJECT_SCENARIOS）
 *
 * 失败注入机制 = npm 调用边界注入脚本化应答（dsh scripted registry 的本仓
 * 形态：不真起 HTTP server，在 exec 边界喂 canned 输出/错误）。注入谱场景
 * 全量收进 tools/release.test.mjs 常规测试面——测试即演习留档（完成判据）。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（脚本自身位置上一级——与 copy-app-assets.mjs 同款锚定） */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 四门禁名（技术栈篇 §2.3；契约 1 逐个真跑，任一非零即止） */
const GATES = ['typecheck', 'test', 'lint:topology', 'format:check'];

/**
 * 读包自述（name / version / bin 名单一等读自 package.json——脚本内零品牌
 * 字面量，去品牌化纪律；bin 名用于安装冒烟解析 .bin 链接）。
 * @param {string} workDir 工作目录（真跑 = 仓库根；测试注入临时目录）
 */
export function readPackageFace(workDir = REPO_ROOT) {
  const pkg = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf8'));
  const binName = pkg.bin && typeof pkg.bin === 'object' ? Object.keys(pkg.bin)[0] : undefined;
  if (!pkg.name || !pkg.version || !binName) {
    throw new Error('package.json 缺 name/version/bin——发布面不完整，拒跑');
  }
  return { name: pkg.name, version: pkg.version, binName };
}

// ───────────────────────── 纯决策函数（测试面直测） ─────────────────────────

/**
 * 契约 2：registry 探测三态分类。
 * E404 与网络错的区分是本道命门——按 npm 错误类型分支，禁按退出码一刀切：
 *   - code 0 → 在场（stdout = `npm view <pkg>@<v> dist.shasum --json` 的
 *     JSON 字符串，形如 "a1b2..."）
 *   - code 非 0 且 stderr 含 E404 → 缺席（该版本未发过，正常发）
 *   - 其余（网络错/registry 不可达/认证异常）→ 不可达 → 拒发（不盲发）
 * @param {{code:number, stdout:string, stderr:string, deferEqual?:boolean}} raw
 *   npm 调用原始结果；deferEqual 为注入谱专用旗标（见 decideIdempotent）
 */
export function classifyProbe(raw) {
  if (raw.deferEqual) return { state: 'present', shasum: null, deferEqual: true };
  if (raw.code === 0) return { state: 'present', shasum: JSON.parse(raw.stdout) };
  if (/E404/.test(raw.stderr)) return { state: 'absent' };
  return { state: 'unreachable', stderr: raw.stderr };
}

/**
 * 契约 4：幂等收口两支判定（在场再分等价/异质）。
 * @param {{state:'absent'|'present'|'unreachable', shasum?:string|null, deferEqual?:boolean}} probe
 *   探测结果（present 且 deferEqual 时视为「与本地 tarball 等价」——注入谱
 *   interrupt-rerun 场景：probe 先于 pack 执行，等价承诺在收口时刻兑现）
 * @param {string} localShasum 契约 3 本地 tarball 的 sha1（registry dist.shasum 同口径）
 * @returns {{action:'publish'}|{action:'skip'}|{action:'reject', reason:string}}
 */
export function decideIdempotent(probe, localShasum) {
  if (probe.state === 'unreachable') {
    // registry 不可达：盲发会在无比对基准下覆盖心智模型，拒发
    return { action: 'reject', reason: 'registry 探测不可达（网络/registry 异常）——拒发不盲发' };
  }
  if (probe.state === 'absent') return { action: 'publish' };
  // 在场：等价跳过 / 异质响亮拒（同号不同内容永不可写——registry 不可重写同版本）
  if (probe.deferEqual || probe.shasum === localShasum) {
    return { action: 'skip', reason: 'registry 已有同字节版本（中断重跑态）——publish 跳过、后续步骤照跑' };
  }
  return {
    action: 'reject',
    reason: `同版本异质：registry shasum ${probe.shasum} ≠ 本地 ${localShasum}——同号不同内容永不可写；若怀疑 npm 工具链升级致打包漂移，人工核对 registry integrity 字段`,
  };
}

/**
 * 契约 5/6：tag 作战计划（纯函数——preview 期与正式期两形态）。
 * preview 期统一律：latest 与 next 恒同指最新 prerelease（alpha/rc 同律——
 * §8.1「latest 跟 alpha」的精确化：latest 停 alpha 反而 npm i 装到更旧）。
 * publish --tag next 先立 next 腿，dist-tag add 补 latest 腿。
 * 首个正式版起分叉：publish 缺省打 latest；next 不动（对照 publish 前快照）。
 * @param {string} version 版本号（含 prerelease 段即 preview 期形态）
 */
export function planTagOperations(version) {
  const isPrerelease = version.includes('-');
  if (isPrerelease) {
    return {
      isPrerelease: true,
      /** publish 旗标：next（prerelease 显式——防 npm 缺省误打 latest） */
      publishTag: 'next',
      /** publish 后需 dist-tag add 的腿（next 已由 publish 立起，只补 latest） */
      postAdds: ['latest'],
      /** preview 期终态断言：两腿同指刚发版（等值判断即全量断言） */
      expectedTags: { latest: version, next: version },
    };
  }
  return {
    isPrerelease: false,
    publishTag: 'latest',
    postAdds: [],
    /** 正式期终态断言退化：只断 latest=版本号；next 不动由 nextBefore 快照比对（见 assertDistTagTerminal） */
    expectedTags: { latest: version },
  };
}

/**
 * 契约 5：dist-tag 终态机器断言（失败抛错——发布半成功态必须被人看见；
 * dsh 唯一漂移点教训：人工干预 dist-tag 必须回写脚本）。
 * @param {{latest?:string, next?:string}} observed npm view dist-tags 实测终态
 * @param {{isPrerelease:boolean, version:string, nextBefore?:string}} ctx
 *   正式期 nextBefore = publish 前 next 快照（「next 不动」的机械形态）
 */
export function assertDistTagTerminal(observed, { isPrerelease, version, nextBefore }) {
  if (observed.latest !== version) {
    throw new Error(
      `dist-tag 断言失败：latest=${observed.latest} 期望 ${version}（preview 期统一律/正式期接管均要求 latest 指刚发版）`,
    );
  }
  if (isPrerelease) {
    if (observed.next !== version) {
      throw new Error(`dist-tag 断言失败：next=${observed.next} 期望 ${version}（preview 期两腿同指）`);
    }
  } else if (nextBefore !== undefined && observed.next !== nextBefore) {
    throw new Error(`dist-tag 断言失败：正式期 next 被动过（${nextBefore} → ${observed.next}）`);
  }
}

/**
 * 契约 3：pack 内容面检视（files 白名单机器验收）。
 * 必在：bin 入口 dist/app/main.js / SPA dist/webui/ / 官方件技能资产
 * *SKILL.md / README.md / LICENSE（2026-08-31 第四十八批——license=MIT 拍板后
 * 缺席即发布物残缺；npm 对根 LICENSE 恒随包，files 白名单拦不住它，检视面
 * 显式验收防误删）/ examples/ 教学例三件套（2026-08-31 第四十四批——
 * examples/*.ts 教学源码是「必在」例外：它们是随包发布物不是待编译源码）/
 * apps/<id>.app.yaml + skills/<name>/SKILL.md（2026-09-01 全面复盘 G-1——官方应用
 * 清单与出厂技能缺席时两消费点〔loadOfficialApps/factorySkillRoot〕均走
 * 「目录缺失=静默降级」，装机后默认应用承诺无声破裂，检视面显式验收）。
 * 必不在：测试产物 / 声明 / 映射 / src/ 前缀源码（examples/ 除外）/ 构建配置。
 * @param {(string|{path:string})[]} files npm pack --json 的 files 列表
 *   （新旧 npm 形状兼容：字符串或 {path} 对象皆收）
 * @returns {{ok:boolean, missing:string[], violations:string[]}}
 */
export function inspectPackEntries(files) {
  const paths = files.map((f) => (typeof f === 'string' ? f : f.path));
  const missing = [];
  const mustHave = (desc, test) => {
    if (!paths.some(test)) missing.push(desc);
  };
  mustHave('dist/app/main.js（bin 入口）', (p) => p === 'dist/app/main.js');
  mustHave('dist/webui/*（SPA 呈现面）', (p) => p.startsWith('dist/webui/'));
  mustHave('*SKILL.md（官方件技能资产）', (p) => /(^|\/)SKILL\.md$/.test(p));
  mustHave('README.md', (p) => p === 'README.md');
  mustHave('LICENSE（MIT 全文）', (p) => p === 'LICENSE');
  mustHave('examples/*（教学例三件套）', (p) => p.startsWith('examples/') && p !== 'examples/');
  mustHave('apps/*.app.yaml（官方应用清单）', (p) => /^apps\/[^/]+\.app\.yaml$/.test(p));
  mustHave('skills/*/SKILL.md（出厂技能）', (p) => /^skills\/[^/]+\/SKILL\.md$/.test(p));
  const violations = paths.filter(
    (p) =>
      /\.test\.js$/.test(p) ||
      /\.d\.ts$/.test(p) ||
      /\.js\.map$/.test(p) ||
      p.startsWith('src/') ||
      p.startsWith('tools/') ||
      p.startsWith('tsconfig') ||
      p.startsWith('设计文档'),
  );
  return { ok: missing.length === 0 && violations.length === 0, missing, violations };
}

/**
 * 契约 6：git tag 幂等判定——已在且同 commit 跳过 / 已在异 commit 响亮拒 /
 * 不在则打挂（打挂动作由调用方执行，本函数只判）。
 * @param {string} tagExists git tag -l 输出（trim 后非空 = 在）
 * @param {string} tagSha tag 指向 commit（不在时传 undefined）
 * @param {string} headSha 当前 HEAD
 */
export function classifyGitTag(tagExists, tagSha, headSha) {
  if (!tagExists) return { action: 'create' };
  return tagSha === headSha ? { action: 'skip' } : { action: 'reject' };
}

/** 安装占位符形态（成熟度扫描 20260901 P0-6）：README 快速开始里的仓库 URL 占位——
 *  中文三形（<仓库>/<仓库 URL>/<本仓库>）+ 外语 <repo> 形（英/西/法镜像同款）。
 *  仓转公开日回填前这些安装指引对装机用户全数 404，发布物不得带它们出门。 */
const INSTALL_PLACEHOLDER_PATTERN = /<[^<>\n]{0,20}(仓库|repo)[^<>\n]{0,20}>/i;

/**
 * publish 前置占位锚（成熟度扫描 20260901 P0-6 规范先行；**dry-run 不拦**——
 * 演习/CI 常跑面保持绿，闸只在真上传时刻执法）：抽 tarball 内 package/README*.md
 * 逐篇扫描安装占位符，命中即抛（fail-loud 拒发）。
 * @param {string} tarballPath 契约 3 打出的 tarball 路径（检视即所传——锚查的就是上传物本体）
 */
export function assertNoInstallPlaceholders(tarballPath) {
  const list = spawnSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' });
  if (list.status !== 0) throw new Error(`占位锚：tarball 清单读取失败（${list.stderr}）`);
  const readmes = list.stdout
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => /^package\/README[^/]*\.md$/.test(f));
  // README 缺席本身就是 pack 白名单漂移（发布物首屏文件不可缺）——同锚 fail-loud
  if (readmes.length === 0) throw new Error('占位锚：tarball 内 README*.md 缺席（pack 白名单漂移？）');
  const offenders = [];
  for (const entry of readmes) {
    const text = spawnSync('tar', ['-xOzf', tarballPath, entry], { encoding: 'utf8' });
    if (text.status !== 0) throw new Error(`占位锚：${entry} 读取失败（${text.stderr}）`);
    if (INSTALL_PLACEHOLDER_PATTERN.test(text.stdout)) offenders.push(entry);
  }
  if (offenders.length > 0) {
    throw new Error(`发布物占位锚：${offenders.join('、')} 含安装占位符——仓转公开日先回填实际 URL 再发`);
  }
}

/**
 * publish 参数面（成熟度扫描 20260901 P0-5 规范先行）：provenance 条件位——
 * GitHub Actions OIDC 环境在场（GITHUB_ACTIONS 检出）才带 --provenance；本机
 * 发布形态 npm 无 OIDC 供给必拒，故条件缺省 off 本机零影响。发布面若迁 CI 自动
 * 带上（历史版本不回溯——alpha 首发无 provenance 属可接受拍板）。
 * @param {string} tarballPath 上传物路径（契约 3 打出的 tarball 本体）
 * @param {{publishTag: string, dryRun: boolean, githubActions: boolean}} opts
 */
export function publishArgs(tarballPath, { publishTag, dryRun, githubActions }) {
  return [
    'publish',
    tarballPath,
    '--tag',
    publishTag,
    ...(githubActions ? ['--provenance'] : []),
    ...(dryRun ? ['--dry-run'] : []),
  ];
}

// ───────────────────────── 失败注入谱（演习两轮的机器载体） ─────────────────────────

/**
 * 注入谱（--inject 旗标与 tools/release.test.mjs 同表共用——测试即演习留档）。
 * 每场景 = { description, steps: { [步骤标签]: () => canned 结果 } }；被注入
 * 的步骤不跑真实命令。谱项对位 §8.3 演习形态四要求：
 *   gate-red 门禁红拒 / shasum-mismatch 同版本异质拒 / assert-fail dist-tag
 *   断言失败拒 / interrupt-rerun 中断重跑幂等跳过。
 */
export const INJECT_SCENARIOS = {
  'gate-red': {
    description: '契约 1 门禁红拒——四门禁之一非零即止，无 skip 出口',
    steps: {
      'gate:test': () => ({ code: 1, stdout: '', stderr: '注入：test 门禁红' }),
    },
  },
  'shasum-mismatch': {
    description: '契约 4 同版本异质拒——registry 在场但 shasum 与本地 tarball 不同',
    steps: {
      probe: () => ({ code: 0, stdout: JSON.stringify('0'.repeat(40)), stderr: '' }),
    },
  },
  'assert-fail': {
    description: '契约 5 dist-tag 断言失败——发布后半成功态必须被人看见（须配 --dry-run：publish 干跑、断言吃注入终态）',
    // 组合闸（遗漏大扫 20260901-c #7）：canned 步骤 view-tags:post 位于 publish 之后——
    // 不带 --dry-run 跑此谱 = 真上传后撞注入终态，留半成功态。此旗标由 CLI 解析层
    // 与 runRelease 入口双层执法（见 parseReleaseCli / runRelease 头部闸）。
    requiresDryRun: true,
    steps: {
      'view-tags:post': () => ({
        code: 0,
        stdout: JSON.stringify({ latest: '0.0.0-evil', next: '0.0.0-evil' }),
        stderr: '',
      }),
    },
  },
  'interrupt-rerun': {
    description:
      '契约 4 中断重跑幂等跳过——registry 已有同字节版本（deferEqual：probe 先于 pack，等价承诺在收口时刻兑现），publish 跳过、后续步骤照跑',
    steps: {
      probe: () => ({ code: 0, stdout: '', stderr: '', deferEqual: true }),
    },
  },
  'smoke-exit-red': {
    description:
      '契约 3/6 安装冒烟 dump-config 退出码非 0——装机产物不可装配，publish 永不触达（遗漏大扫 20260901-b #25：G-1 真握手闸补红例）',
    steps: {
      'smoke:apps': () => ({ code: 1, stdout: '', stderr: '注入：dump-config 炸' }),
    },
  },
  'smoke-apps-missing': {
    description:
      '契约 3/6 安装冒烟 dump-config 未见默认应用——apps/ 疑似缺席，首启默认应用承诺将静默破裂，publish 永不触达（遗漏大扫 20260901-b #25：G-1 真握手闸补红例）',
    steps: {
      'smoke:apps': () => ({ code: 0, stdout: '默认应用：（缺席）\n', stderr: '' }),
    },
  },
};

// ───────────────────────── 编排骨舞（io 注入缝） ─────────────────────────

/**
 * 默认 io：真实进程执行。exec(标签, 命令, 参数, {inherit, cwd, env}) —— inherit 时
 * stdio 直通操作者（门禁/build 活体输出），否则捕获返回 {code, stdout, stderr}；
 * cwd 透传 spawnSync（pack 落点锚定 workDir——测试临时目录同机制）；env 为
 * 增量覆盖（展开在 process.env 之上——安装冒烟真握手用它钉 APP_DATA_DIR
 * 防污染操作者真实数据域，G1 同款纪律）。
 */
export function defaultIo() {
  return {
    exec(label, command, args, opts = {}) {
      const r = spawnSync(command, args, {
        stdio: opts.inherit ? 'inherit' : 'pipe',
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
        encoding: 'utf8',
      });
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  };
}

/** 注入包装：谱内步骤吃 canned 应答（不跑真实命令），谱外照常真跑 */
export function applyScenario(io, scenario) {
  return {
    exec(label, command, args, opts) {
      const canned = scenario.steps[label];
      if (canned) {
        console.log(`  ⟂ 注入〔${label}〕：${scenario.description}`);
        return canned();
      }
      return io.exec(label, command, args, opts);
    },
  };
}

/** sha1（registry dist.shasum 同口径——tarball 字节的十六进制摘要） */
function sha1(file) {
  return createHash('sha1').update(readFileSync(file)).digest('hex');
}

/**
 * 发布主流程（六道契约编排队；决策逻辑全部上移纯函数，本函数只做接线）。
 * @param {string[]} argv CLI 参数（--dry-run / --inject <谱项>）
 * @param {{exec: Function}} io 执行缝（测试全脚本化注入）
 * @param {{workDir?: string, pkg?: {name:string,version:string,binName:string}}} opts
 *   workDir 真跑 = 仓库根（pack 落点/git 锚点）；pkg 缺省读 workDir/package.json
 * @returns {Promise<object>} 发布摘要（版本/tarball/shasum/是否真发/终态）
 */
export async function runRelease(argv = [], io = defaultIo(), opts = {}) {
  const workDir = resolve(opts.workDir ?? REPO_ROOT);
  const pkg = opts.pkg ?? readPackageFace(workDir);
  const dryRun = argv.includes('--dry-run');
  const injectIdx = argv.indexOf('--inject');
  const injectName = injectIdx >= 0 ? argv[injectIdx + 1] : undefined;
  const activeIo = injectName
    ? applyScenario(io, INJECT_SCENARIOS[injectName] ?? throwUnknownScenario(injectName))
    : io;
  // 注入谱组合闸（遗漏大扫 20260901-c #7）：canned 步骤位于 publish 之后的谱项必须
  // 配 --dry-run——闸在契约 1 之前，任何步骤（连门禁都不）触达；此处守编程调用路
  // （CLI 路由 parseReleaseCli 同判，输出为用法错退出 2）
  if (injectName && !dryRun && INJECT_SCENARIOS[injectName].requiresDryRun) {
    throw new Error(`注入谱 ${injectName} 的 canned 步骤位于 publish 之后——须配 --dry-run 演习（真跑形态会真上传）`);
  }

  // ── 契约 1：门禁前置不可绕 + 工作树净空 ──
  for (const gate of GATES) {
    console.log(`── 契约 1/6 门禁：${gate}`);
    const r = await activeIo.exec(`gate:${gate}`, 'npm', ['run', gate], { inherit: true });
    if (r.code !== 0) throw new Error(`门禁红拒：${gate} 退出码 ${r.code}——发布路径无 skip 出口`);
  }
  const clean = await activeIo.exec('git-clean', 'git', ['status', '--porcelain']);
  if (clean.code !== 0) throw new Error('git status 失败——工作树净空无法核验，拒发');
  if (clean.stdout.trim() !== '') {
    throw new Error(`工作树非净空（${clean.stdout.trim().split('\n').length} 处未提交改动）——禁发未提交态`);
  }

  // ── 契约 2：registry 探测（只读三态） ──
  console.log(`── 契约 2/6 registry 探测：${pkg.name}@${pkg.version}`);
  const probeRaw = await activeIo.exec('probe', 'npm', ['view', `${pkg.name}@${pkg.version}`, 'dist.shasum', '--json']);
  const probe = classifyProbe(probeRaw);
  console.log(`  探测终态：${probe.state}`);

  // ── 契约 3：构建即打包与发布物验收 ──
  console.log('── 契约 3/6 构建 + 打包 + 检视 + 安装冒烟');
  rmSync(join(workDir, 'dist'), { recursive: true, force: true }); // 全新 build：先清 dist
  const build = await activeIo.exec('build', 'npm', ['run', 'build'], { inherit: true });
  if (build.code !== 0) throw new Error(`构建失败（退出码 ${build.code}）`);
  const inspect = await activeIo.exec('pack:inspect', 'npm', ['pack', '--dry-run', '--json']);
  if (inspect.code !== 0) throw new Error('npm pack --dry-run 失败');
  const inspectResult = JSON.parse(inspect.stdout)[0];
  const verdict = inspectPackEntries(inspectResult.files ?? []);
  if (!verdict.ok) {
    throw new Error(`pack 检视不过：缺失 [${verdict.missing.join('; ')}] 违禁 [${verdict.violations.join('; ')}]`);
  }
  console.log(`  检视绿：${(inspectResult.files ?? []).length} 个文件全过白名单`);
  const packReal = await activeIo.exec('pack:real', 'npm', ['pack', '--json'], { cwd: workDir });
  if (packReal.code !== 0) throw new Error('npm pack 失败');
  const tarballName = JSON.parse(packReal.stdout)[0].filename;
  const tarballPath = join(workDir, tarballName);
  if (!existsSync(tarballPath)) throw new Error(`tarball 未落盘：${tarballPath}`);
  const localShasum = sha1(tarballPath);
  console.log(`  tarball：${tarballName}（sha1 ${localShasum.slice(0, 12)}…）`);
  // tarball 生命周期 = 契约 3 打出 → 契约 4 上传 → 收尾即弃；成功/失败两路
  // 同走 finally 兜底清理（与安装冒烟 prefix 同律「即用即清」）——tarball 滞留
  // 仓库根会成为未跟踪残留，污染下一轮契约 1 工作树净空核验（机器自锁死）；
  // 重跑自同一 commit 确定性重建，清理无损失
  try {
    await installSmoke(activeIo, { tarballPath, binName: pkg.binName, version: pkg.version });

    // ── 契约 4：幂等收口与 publish 单点 ──
    const plan = planTagOperations(pkg.version);
    const decision = decideIdempotent(probe, localShasum);
    if (decision.action === 'reject') throw new Error(decision.reason);
    // 正式期「next 不动」需要 publish 前快照（preview 期两腿同指不需要）——
    // 快照必须先于任何写操作：本脚本的正式期发布不触 next，比对即「我们没动它」
    let nextBefore;
    if (!plan.isPrerelease) {
      const pre = await activeIo.exec('view-tags:pre', 'npm', ['view', pkg.name, 'dist-tags', '--json']);
      if (pre.code !== 0) throw new Error('npm view dist-tags（pre 快照）失败——「next 不动」断言失去基准，拒发');
      nextBefore = JSON.parse(pre.stdout).next;
    }
    let published = false;
    if (decision.action === 'publish') {
      // 占位锚先于上传执法（真发路径专用——dry-run 不拦：演习/CI 常跑面保持绿，
      // 闸只在真上传时刻生效；成熟度扫描 20260901 P0-6）
      if (!dryRun) assertNoInstallPlaceholders(tarballPath);
      // provenance 条件位（P0-5）：GITHUB_ACTIONS 在场才带——本机无 OIDC 供给必拒
      const provenance = Boolean(process.env.GITHUB_ACTIONS);
      console.log(
        `── 契约 4/6 publish${dryRun ? '（dry-run 干跑）' : ''}：--tag ${plan.publishTag}${provenance ? ' --provenance' : ''}`,
      );
      const pub = await activeIo.exec(
        'publish',
        'npm',
        publishArgs(tarballPath, { publishTag: plan.publishTag, dryRun, githubActions: provenance }),
        { inherit: true },
      );
      if (pub.code !== 0) throw new Error(`npm publish 失败（退出码 ${pub.code}）`);
      published = !dryRun;
    } else {
      console.log(`── 契约 4/6 幂等跳过 publish：${decision.reason}`);
    }

    // ── 契约 5：dist-tag 终态机器断言 ──
    // 注入谱含 canned 终态时（assert-fail 场景）即便 dry-run 也走实测断言路——
    // 断言失败路径的演习必须穿过 assertDistTagTerminal 本体，不能只投影期望值
    const scenarioInjectsPost = injectName && INJECT_SCENARIOS[injectName].steps['view-tags:post'];
    if (!dryRun || scenarioInjectsPost) {
      if (!dryRun) {
        for (const tag of plan.postAdds) {
          const add = await activeIo.exec('dist-tag-add', 'npm', [
            'dist-tag',
            'add',
            `${pkg.name}@${pkg.version}`,
            tag,
          ]);
          if (add.code !== 0) throw new Error(`dist-tag add ${tag} 失败（退出码 ${add.code}）`);
        }
      }
      const post = await activeIo.exec('view-tags:post', 'npm', ['view', pkg.name, 'dist-tags', '--json']);
      if (post.code !== 0) throw new Error('npm view dist-tags 失败——终态无法断言');
      assertDistTagTerminal(JSON.parse(post.stdout), {
        isPrerelease: plan.isPrerelease,
        version: pkg.version,
        nextBefore,
      });
      console.log(`  终态断言绿：${JSON.stringify(plan.expectedTags)}`);
    } else {
      // dry-run：只调纯函数断言期望终态（不打 tag 不触网写）。
      // 投影断言不喂 nextBefore（遗漏大扫 20260901-c #8）：投影终态是 planTagOperations
      // 的期望值——正式版期望态无 next 键，observed.next=undefined ≠ nextBefore 会必
      // 触发「正式期 next 被动过」假象恒炸演习；「next 不动」比对语义只在实测路成立
      assertDistTagTerminal(plan.expectedTags, {
        isPrerelease: plan.isPrerelease,
        version: pkg.version,
      });
      console.log(`  期望终态（dry-run 不执行 dist-tag add）：${JSON.stringify(plan.expectedTags)}`);
    }

    // ── 契约 6：尾件 git tag（幂等打挂） ──
    console.log('── 契约 6/6 git tag');
    const tag = `v${pkg.version}`;
    const listRaw = await activeIo.exec('git-tag:list', 'git', ['tag', '-l', tag]);
    if (listRaw.code !== 0) throw new Error('git tag -l 失败');
    let tagSha;
    const tagExists = listRaw.stdout.trim() !== '';
    if (tagExists) {
      const rev = await activeIo.exec('git-rev:tag', 'git', ['rev-parse', `${tag}^{commit}`]);
      if (rev.code !== 0) throw new Error(`git rev-parse ${tag} 失败`);
      tagSha = rev.stdout.trim();
    }
    const head = await activeIo.exec('git-rev:head', 'git', ['rev-parse', 'HEAD']);
    if (head.code !== 0) throw new Error('git rev-parse HEAD 失败');
    const gitAction = classifyGitTag(tagExists, tagSha, head.stdout.trim());
    if (gitAction.action === 'reject') {
      throw new Error(`git tag ${tag} 已在但指向异 commit（${tagSha} ≠ ${head.stdout.trim()}）——响亮拒`);
    }
    if (gitAction.action === 'create' && !dryRun) {
      const mk = await activeIo.exec('git-tag:create', 'git', ['tag', tag]);
      if (mk.code !== 0) throw new Error(`git tag ${tag} 创建失败`);
      // push 恒带 HTTP/1.1（遗漏大扫 20260901-c #17）：与仓库管理推送纪律/归档机器
      // 同律——本机到 GitHub 的 HTTP/2 推流不稳，release 机器不得是全仓唯一裸 push 例外
      const push = await activeIo.exec('git-tag:push', 'git', ['-c', 'http.version=HTTP/1.1', 'push', 'origin', tag]);
      if (push.code !== 0) throw new Error(`git push origin ${tag} 失败（本地已打——人工补推）`);
      console.log(`  git tag ${tag} 已打挂`);
    } else {
      console.log(
        `  git tag ${tag}：${gitAction.action === 'skip' ? '已在同 commit，跳过' : dryRun ? 'dry-run 不打' : ''}`,
      );
    }

    return {
      version: pkg.version,
      tarball: tarballName,
      shasum: localShasum,
      published,
      skippedPublish: decision.action === 'skip',
      dryRun,
      expectedTags: plan.expectedTags,
      gitTag: gitAction.action,
    };
  } finally {
    // 即用即清（见上注释）：tarball 是过程产物非留存物
    rmSync(tarballPath, { force: true });
  }
}

/** 注入谱名不存在时即早炸（禁静默回落真跑——注入演习必须命中谱项；CLI 层已拦一道，此为程序调用兜底） */
function throwUnknownScenario(name) {
  throw new Error(`未知注入谱项：${name}（可用：${Object.keys(INJECT_SCENARIOS).join(' / ')}）`);
}

/**
 * 契约 3 尾步：安装冒烟——tarball 装入临时 prefix，跑 bin --version：
 * 退出码 0 且输出以版本号起头（裸 semver 或 `<semver> "<代号>"` 形态，第五十批
 * 起；transitively 核 src/app/version.ts 与 package.json 同步——漂移即冒烟红）。
 * 第二断言（2026-09-01 全面复盘 G-1）：bin dump-config 真握手——官方应用
 * 清单（apps/）缺席时 loadOfficialApps 静默空表、resolveDefaultApp 两跳皆断，
 * 装机产物「能起但首启无默认应用」的静默残缺在此截获（APP_DATA_DIR 钉入
 * 冒烟临时目录防污染真实数据域）。
 */
async function installSmoke(io, { tarballPath, binName, version }) {
  const prefix = mkdtempSync(join(tmpdir(), 'release-smoke-'));
  try {
    const install = await io.exec('smoke:install', 'npm', [
      'install',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      tarballPath,
      '--prefix',
      prefix,
    ]);
    if (install.code !== 0) throw new Error(`安装冒烟失败：npm install 退出码 ${install.code}`);
    const run = await io.exec('smoke:run', join(prefix, 'node_modules', '.bin', binName), ['--version']);
    if (run.code !== 0) throw new Error(`安装冒烟失败：${binName} --version 退出码 ${run.code}`);
    // 版本断言取结构前缀（遗漏大扫 20260901 O-10）：--version 自第五十批起打印
    // `<semver> "<代号>"`（VERSION_WITH_CODENAME），此前为裸 semver。断言面 = 输出
    // 以 package.json version 起头，且余段为空（裸形态同绿）或恰为代号后缀
    // ` "<字符串>"`——真 semver 漂移必红，含 `1.0.0` 前缀误吞 `1.0.0-alpha.x` 的假绿腿
    const smokeOut = run.stdout.trim();
    const smokeRest = smokeOut.startsWith(version) ? smokeOut.slice(version.length) : null;
    if (smokeRest === null || (smokeRest !== '' && !/^ "[^"]+"$/.test(smokeRest))) {
      throw new Error(
        `安装冒烟版本漂移：bin 输出 ${smokeOut} ≠ ${version}（或代号后缀形态异常）（src/app/version.ts 与 package.json 失同步）`,
      );
    }
    // 真握手（复盘 G-1）：dump-config 全装配零落盘（:memory:），断言官方应用清单
    // 非空且默认应用解析为 coder——apps/ 目录缺席即此处红，静默降级面收进发布闸
    const probe = await io.exec('smoke:apps', join(prefix, 'node_modules', '.bin', binName), ['dump-config'], {
      env: { APP_DATA_DIR: join(prefix, 'smoke-data'), APP_LOG_LEVEL: 'error' },
    });
    if (probe.code !== 0) {
      throw new Error(`安装冒烟失败：${binName} dump-config 退出码 ${probe.code}（发布物装机后不可装配）`);
    }
    if (!probe.stdout.includes('默认应用：coder')) {
      throw new Error(
        `安装冒烟失败：dump-config 未见「默认应用：coder」——官方应用清单（apps/）疑似缺席，首启默认应用承诺将静默破裂`,
      );
    }
    console.log(`  安装冒烟绿：${binName} --version = ${smokeOut}；dump-config 默认应用 = coder`);
  } finally {
    rmSync(prefix, { recursive: true, force: true }); // 冒烟现场即用即清
  }
}

// ───────────────────────── CLI 入口（手写 argv——仓库纪律） ─────────────────────────

/** 手写 argv 解析：--dry-run / --inject <谱项> / --help；未知参数用法错退出 2（防拼错静默跑半套） */
function parseReleaseCli(argv) {
  const opts = { dryRun: false, inject: undefined, help: false, error: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--inject') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        opts.error = '--inject 需要谱项参数';
        break;
      }
      opts.inject = next;
      i++;
    } else {
      opts.error = `未知参数：${a}`;
      break;
    }
  }
  if (!opts.error && opts.inject && !INJECT_SCENARIOS[opts.inject]) {
    opts.error = `未知注入谱项：${opts.inject}（可用：${Object.keys(INJECT_SCENARIOS).join(' / ')}）`;
  }
  // 组合闸（遗漏大扫 20260901-c #7）：requiresDryRun 谱项缺 --dry-run = 用法错退 2
  // （CLI 层闸在跑任何步骤之前；runRelease 入口另有一道守编程调用路）
  if (!opts.error && opts.inject && INJECT_SCENARIOS[opts.inject].requiresDryRun && !opts.dryRun) {
    opts.error = `注入谱 ${opts.inject} 须配 --dry-run（canned 步骤位于 publish 之后——真跑形态会真上传）`;
  }
  return opts;
}

/** CLI 主流程：恒返 Promise<退出码>（异步链不吞——process.exit 只吃已决码） */
function main() {
  const argv = process.argv.slice(2);
  const cli = parseReleaseCli(argv);
  if (cli.help) {
    console.log(
      [
        '用法：node tools/release.mjs [--dry-run] [--inject <谱项>]',
        '',
        '谱项：' +
          Object.entries(INJECT_SCENARIOS)
            .map(([k, v]) => `${k}（${v.description}）`)
            .join('；'),
        '',
        '失败注入演习建议组合（§8.3 演习形态）：',
        '  node tools/release.mjs --inject gate-red                 # 门禁红拒（无需 dry-run——门禁最先跑）',
        '  node tools/release.mjs --dry-run --inject shasum-mismatch',
        '  node tools/release.mjs --dry-run --inject assert-fail',
        '  node tools/release.mjs --dry-run --inject interrupt-rerun',
      ].join('\n'),
    );
    return Promise.resolve(0);
  }
  if (cli.error) {
    console.error(cli.error);
    return Promise.resolve(2);
  }
  return runRelease(argv)
    .then((summary) => {
      console.log(
        `\n发布收口：${summary.version}${summary.published ? '' : summary.skippedPublish ? '（幂等跳过）' : '（dry-run）'}`,
      );
      return 0;
    })
    .catch((err) => {
      console.error(`\n发布失败：${err.message}`);
      return 1;
    });
}

// 直接执行时才跑 main（测试 import 纯函数不触发）；exit 只吃已决退出码
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}

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
 *      → 子步 3.5 面快照归档（api/snapshots/<version>.json 落档 + COMPATIBILITY.md
 *      同笔再生 + 机械 commit——技术栈 §8.3，2026-09-03 第九十一批挂机；归档
 *      commit 先于契约 6 打 tag，tag 树必含本版快照；同版本同内容幂等跳过、
 *      异内容响亮拒；--dry-run 只投影不触 git 写面）
 *   4. 幂等收口与 publish 单点——在场等价（同 shasum）跳过 publish；字节不等
 *      先内容级深对照（剥离 dist/.build-meta.json 溯源戳：等价跳 / 实质差异拒 /
 *      对照不可行维持拒——技术栈 §8.3，全面复盘 20260903-91 刀四）；publish
 *      上传物 = 本脚本打出的 tarball 本体（检视即所传）
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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { createJiti } from 'jiti';
import {
  classifyFaceDiff,
  eraOf,
  judgeBreakages,
  loadArchivedSnapshots,
  renderCompatibility,
} from './generate-compatibility.mjs';

/** 仓库根（脚本自身位置上一级——与 copy-app-assets.mjs 同款锚定） */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const jiti = createJiti(import.meta.url);
/** 便利导入：仓库内相对路径 → 模块运行时面（子步 3.5 装载真册 DEP 注册簿用） */
const imp = (rel) => jiti.import(fileURLToPath(new URL(rel, import.meta.url)));

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

/**
 * 仓内官方清单的默认应用 id（基建大扫 #36：安装冒烟断言串动态读真源——
 * apps/<id>.app.yaml 的 default: true 键，与 readPackageFace「零硬编码」同拍；
 * 官方拍板换默认应用时 release 冒烟零人工同步）。无 default 键返回 undefined
 * （installSmoke 按缺席红——期望值本身缺席即断言不能成立）。
 * @param {string} workDir 仓库根（apps/ 清单所在）
 */
export function readDefaultAppId(workDir = REPO_ROOT) {
  const appsDir = join(workDir, 'apps');
  if (!existsSync(appsDir)) return undefined;
  for (const name of readdirSync(appsDir)) {
    if (!name.endsWith('.app.yaml')) continue;
    const manifest = parseYaml(readFileSync(join(appsDir, name), 'utf8'));
    if (manifest && manifest.default === true) return String(manifest.id);
  }
  return undefined;
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
 * 契约 4：幂等收口两支判定（在场再分等价/异质；字节不等时深对照三态裁决）。
 * @param {{state:'absent'|'present'|'unreachable', shasum?:string|null, deferEqual?:boolean}} probe
 *   探测结果（present 且 deferEqual 时视为「与本地 tarball 等价」——注入谱
 *   interrupt-rerun 场景：probe 先于 pack 执行，等价承诺在收口时刻兑现）
 * @param {string} localShasum 契约 3 本地 tarball 的 sha1（registry dist.shasum 同口径）
 * @param {{ok:boolean, equivalent?:boolean, differ?:string[]}|undefined} [contentEquiv]
 *   深对照产物（deepCompareTarballs——字节不等时编排层先跑内容级对照再复判）：
 *   undefined = 未做深对照（维持旧拒文案）；ok:false = 拉取/解包不可行（fail-closed
 *   维持拒）；ok:true+equivalent = 仅 build-meta 溯源戳漂移（跳过）；
 *   ok:true+!equivalent = 实质差异（拒，点名差异件）
 * @returns {{action:'publish'}|{action:'skip'}|{action:'reject', reason:string}}
 */
export function decideIdempotent(probe, localShasum, contentEquiv) {
  if (probe.state === 'unreachable') {
    // registry 不可达：盲发会在无比对基准下覆盖心智模型，拒发
    return { action: 'reject', reason: 'registry 探测不可达（网络/registry 异常）——拒发不盲发' };
  }
  if (probe.state === 'absent') return { action: 'publish' };
  // 在场：等价跳过 / 异质响亮拒（同号不同内容永不可写——registry 不可重写同版本）
  if (probe.deferEqual || probe.shasum === localShasum) {
    return { action: 'skip', reason: 'registry 已有同字节版本（中断重跑态）——publish 跳过、后续步骤照跑' };
  }
  // 字节不等 → 深对照裁决（刀四）：build-meta 溯源戳是发布物里唯一的「构建时刻
  // 环境指纹」——子步 3.5 归档 commit 先于本契约，中断重跑时 HEAD 已移、重建产物
  // 的 build-meta 嵌新 commit 而其余字节全同；不剥离它，一切中断重跑都会被误判异质
  if (contentEquiv === undefined) {
    return {
      action: 'reject',
      reason: `同版本异质：registry shasum ${probe.shasum} ≠ 本地 ${localShasum}——同号不同内容永不可写；若怀疑 npm 工具链升级致打包漂移，人工核对 registry integrity 字段`,
    };
  }
  if (!contentEquiv.ok) {
    return {
      action: 'reject',
      reason: `同版本字节不等且深对照不可行（${contentEquiv.reason ?? 'registry tarball 拉取/解包失败'}）——无对照基准不盲跳，维持拒；人工核对 registry integrity 字段`,
    };
  }
  if (contentEquiv.equivalent) {
    return {
      action: 'skip',
      reason:
        '同内容等价：registry 版本与本轮构建仅 dist/.build-meta.json 溯源戳漂移（中断重跑态——归档 commit 先于 publish 移动了 HEAD）——publish 跳过、后续步骤照跑',
    };
  }
  return {
    action: 'reject',
    reason: `同版本异质：registry 版本与本轮构建除溯源戳外仍有实质差异（${(contentEquiv.differ ?? []).slice(0, 5).join('、')}）——同号不同内容永不可写`,
  };
}

/**
 * 深对照豁免件：tarball 内唯一合法的「构建时刻环境指纹」——归档 commit 移动
 * HEAD 后重建，build-meta 嵌新 commit 而其余字节全同（技术栈 §8.3 契约 4）。
 * 路径形 = npm tarball 解包后的 package/ 前缀（compareExtractedTrees 走相对路径）
 */
const DEEP_COMPARE_EXEMPT = 'package/dist/.build-meta.json';

/**
 * 两棵解包树的内容级对照（纯文件系统走查——测试直测）。
 * 语义：文件集对称 + 逐文件字节等价，唯一豁免 DEEP_COMPARE_EXEMPT 一件。
 * @param {string} localDir 本地 tarball 解包目录
 * @param {string} remoteDir registry tarball 解包目录
 * @returns {{equivalent: boolean, differ: string[]}} differ = 差异相对路径清单
 *   （内容异/单边缺席都算——供拒绝文案点名）
 */
export function compareExtractedTrees(localDir, remoteDir) {
  /** 递归收割文件相对路径集（dir 为根，路径分隔统一 /——tar 解包产物跨平台形态） */
  const walk = (dir, base = '') => {
    const out = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const rel = base === '' ? ent.name : `${base}/${ent.name}`;
      if (ent.isDirectory()) out.push(...walk(join(dir, ent.name), rel));
      else if (ent.isFile()) out.push(rel);
    }
    return out;
  };
  const localFiles = new Set(walk(localDir));
  const remoteFiles = new Set(walk(remoteDir));
  /** 差异清单：对称并集里逐件比对（豁免件直接跳过——两边都该在但内容无关紧要） */
  const differ = [];
  for (const rel of new Set([...localFiles, ...remoteFiles])) {
    if (rel === DEEP_COMPARE_EXEMPT) continue;
    const localPath = join(localDir, rel);
    const remotePath = join(remoteDir, rel);
    // 单边缺席或字节不等都算实质差异（readFileSync 缺席抛错——先探在场性）
    const same =
      localFiles.has(rel) && remoteFiles.has(rel) && readFileSync(localPath).equals(readFileSync(remotePath));
    if (!same) differ.push(rel);
  }
  return { equivalent: differ.length === 0, differ };
}

/**
 * 契约 4 深对照编排：拉 registry tarball（公开包零鉴权——`npm pack <pkg>@<v>
 * --pack-destination`）与本地 tarball 双解包后 compareExtractedTrees。
 * 全程经 io 缝（测试注入 canned pack:remote + 真 tar 解包）；任一步失败返回
 * {ok:false}——decideIdempotent 对 ok:false 维持拒（fail-closed，不盲跳）。
 * @param {{exec: Function}} io 执行缝（runRelease 内传 anchoredIo）
 * @param {{name: string, version: string, localTarballPath: string}} input
 * @returns {Promise<{ok: true, equivalent: boolean, differ: string[]}|{ok: false, reason: string}>}
 */
export async function deepCompareTarballs(io, { name, version, localTarballPath }) {
  /** 对照工作区：拉取落点 + 两解包目录（收场即清——零残留） */
  const dir = mkdtempSync(join(tmpdir(), 'release-deepcmp-'));
  try {
    // 拉 registry 在场版本（公开包无鉴权面；--pack-destination 钉临时目录防落仓库根）
    const dl = await io.exec('pack:remote', 'npm', ['pack', `${name}@${version}`, '--pack-destination', dir, '--json']);
    if (dl.code !== 0) return { ok: false, reason: `registry tarball 拉取失败（退出码 ${dl.code}）` };
    const parsed = parseNpmPackJson(dl.stdout);
    if (parsed === null) return { ok: false, reason: 'npm pack（registry 拉取）输出不可解析' };
    const remoteTgz = join(dir, parsed[0].filename);
    if (!existsSync(remoteTgz)) return { ok: false, reason: `registry tarball 未落盘：${remoteTgz}` };
    // 双解包（tar 走真进程——与安装冒烟同律，机器缺 tar 时此处响亮失败进 ok:false）
    const localEx = join(dir, 'local');
    const remoteEx = join(dir, 'remote');
    mkdirSync(localEx);
    mkdirSync(remoteEx);
    const tx1 = await io.exec('tar:extract-local', 'tar', ['-xzf', localTarballPath, '-C', localEx]);
    if (tx1.code !== 0) return { ok: false, reason: `本地 tarball 解包失败（退出码 ${tx1.code}）` };
    const tx2 = await io.exec('tar:extract-remote', 'tar', ['-xzf', remoteTgz, '-C', remoteEx]);
    if (tx2.code !== 0) return { ok: false, reason: `registry tarball 解包失败（退出码 ${tx2.code}）` };
    return { ok: true, ...compareExtractedTrees(localEx, remoteEx) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
 * 解析 npm pack --json 的 stdout（CI run 33545358469 根因修）。
 * npm pack 前会跑 prepare 生命周期脚本，其 stdout（如 install-hooks 的
 * 「钩子已安装：core.hooksPath → …」）并入主命令 stdout 前置污染 JSON——
 * 直接 JSON.parse 整串必炸。npm --json 产物恒为行首 `[` 起的 JSON 数组
 * （嵌套结构都带缩进，行首 `[` 只在顶层），取首个行首 `[` 到串尾解析。
 * @param {string} stdout 子命令原始 stdout
 * @returns {object[]|null} tarball 描述数组；不可解析返回 null（调用方报原错）
 */
export function parseNpmPackJson(stdout) {
  const m = stdout.match(/(?:^|\n)(\[[\s\S]*)$/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
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
 * 必不在：测试产物 / 声明（API 治理三声明区例外：dist/api/ + dist/contracts/ +
 * llm/persist 两类型锚——§6.13.9 刻意随包，第八十七批批 2）/ 映射 / src/ 前缀
 * 源码（examples/ 除外）/ 构建配置。
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
  // 构建溯源面（遗漏大扫 20260902 #4）：build 链尾步写的 commit 元数据——此前仅靠
  // files 含 dist 整目录隐式随包，缺席时运行侧 readBuildMeta=null 静默降级无机器红
  //（G-1 apps/skills 缺席同型风险），显式锚定后 files 面漂移即检视红
  mustHave('dist/.build-meta.json（构建溯源面）', (p) => p === 'dist/.build-meta.json');
  // 版本史入口（遗漏大扫 20260902-b #12）：CHANGELOG.md 自我声明「npm 包内的
  // 消费者经本文件得到版本史入口」且 files 数组显式含它——同级随包物 README/
  // LICENSE 都有 mustHave，唯独它裸奔；手滑删 files 行即静默绿发布
  mustHave('CHANGELOG.md（版本史入口）', (p) => p === 'CHANGELOG.md');
  // API 面随包物（API 治理 §6.13.9，第八十七批批 2）：dist/api/ 是应用侧 tsc 的
  // 六虚拟键消费面——surface.json 运行时位 + .d.ts 面（≥6：六键手稳件）+ paths
  // 模板；六键 d.ts 的相对引用在**包内**解析到声明树（dist/contracts/** +
  // llm/provider-face + persist/app-sqlite 三个类型锚），缺席即应用沙盒 tsc
  // 断链。emit-api-decls 锚定核验只保构建期，检视面再保发布面（files 面漂移
  // /构建链漏子步两路都红——.build-meta.json 先例同型）。d.ts 计数不点名单文件
  // 而取 ≥6：api-decls/ 增第七键不需回改本清单（两真相源不立）。
  mustHave('dist/api/surface.json（API 面快照运行时位）', (p) => p === 'dist/api/surface.json');
  mustHave(
    'dist/api/*.d.ts（六虚拟键声明面，≥6）',
    () => paths.filter((q) => q.startsWith('dist/api/') && q.endsWith('.d.ts')).length >= 6,
  );
  mustHave('dist/api/tsconfig.paths.json（应用侧 paths 模板）', (p) => p === 'dist/api/tsconfig.paths.json');
  mustHave('dist/contracts/index.d.ts（公开根声明树锚）', (p) => p === 'dist/contracts/index.d.ts');
  mustHave('dist/llm/provider-face.d.ts（第五键类型锚）', (p) => p === 'dist/llm/provider-face.d.ts');
  mustHave('dist/persist/app-sqlite.d.ts（第六键类型锚）', (p) => p === 'dist/persist/app-sqlite.d.ts');
  // 声明豁免位（§6.13.9——零声明纪律的刻意例外，见 violations 处 DECL_OK 注记）
  const isDeclaredApiFace = (p) =>
    p.startsWith('dist/api/') ||
    p.startsWith('dist/contracts/') ||
    p === 'dist/llm/provider-face.d.ts' ||
    p === 'dist/persist/app-sqlite.d.ts';
  const violations = paths.filter(
    (p) =>
      /\.test\.js$/.test(p) ||
      // .d.ts 违禁 = 主构建产物零声明纪律；声明例外三区：dist/api/ 六键面 +
      // dist/contracts/ 公开根声明树 + llm/persist 两类型锚（§6.13.9 刻意随包，
      // tsconfig.api.json emitDeclarationOnly 子步产——主 tsconfig.build 零声明
      // 纪律不变，例外区外声明泄漏照红）
      (p.endsWith('.d.ts') && !isDeclaredApiFace(p)) ||
      /\.js\.map$/.test(p) ||
      p.startsWith('src/') ||
      p.startsWith('tools/') ||
      p.startsWith('tsconfig') ||
      p.startsWith('设计文档') ||
      // dist 内非 SKILL.md 的 .md 违禁（基建大扫 #35）：copy-app-assets 拷贝面
      // 是 src 内全部 .md、检视面此前只锚 SKILL.md——两侧对齐靠巧合不靠机制，
      // 未来在 src 放任何非 SKILL 的 .md 会静默进发布物；防线压在检视单点
      // （技能正文文档形态留弹性，拷贝侧不收窄）
      (p.startsWith('dist/') && p.endsWith('.md') && !/(^|\/)SKILL\.md$/.test(p)),
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
 *  中文三形（<仓库>/<仓库 URL>/<本仓库>）+ 外语 <repo>（英/西）与 <dépôt>/<ce dépôt>
 *  （法）形。仓转公开日回填前这些安装指引对装机用户全数 404，发布物不得带它们出门。 */
const INSTALL_PLACEHOLDER_PATTERN = /<[^<>\n]{0,20}(仓库|repo|dépôt)[^<>\n]{0,20}>/i;

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
    description:
      '契约 4 同版本异质拒——registry 在场但 shasum 与本地 tarball 不同；深对照（刀四）注入为拉取不可行 → fail-closed 维持拒（实质差异拒腿由 release.test.mjs 深对照 e2e 真锁）',
    steps: {
      probe: () => ({ code: 0, stdout: JSON.stringify('0'.repeat(40)), stderr: '' }),
      // 深对照拉取步注入失败：CLI 演习零触网确定性（真 fetch 会依赖 registry 实态）
      'pack:remote': () => ({ code: 1, stdout: '', stderr: 'npm error network unreachable（注入）' }),
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

/**
 * 契约 3 子步 3.5：面快照归档判定（纯函数——三态，与契约 4 decideIdempotent
 * 同形对称：缺席落档 / 等价跳过 / 异质响亮拒）。幂等语义覆盖中断重跑：归档
 * commit 已落的重跑同内容跳过（不造空 commit）；同版本异内容 = 版本号复用或
 * 归档损坏，静默覆盖会抹掉真历史——必须人工裁决。
 * @param {{archiveExists: boolean, identical: boolean}} input
 *   archiveExists = api/snapshots/<version>.json 在场；identical = 与构建产物字节等价
 */
export function planSnapshotArchive({ archiveExists, identical }) {
  if (!archiveExists) return { action: 'archive' };
  if (identical) return { action: 'skip', reason: '同版本同内容快照已归档（中断重跑幂等跳过）' };
  return { action: 'reject', reason: '同版本异内容快照已在档——版本号复用或归档损坏，先人工裁决（拒静默覆盖）' };
}

// ───────────── 子步 3.6 语料试跑（crater 骨架）纯决策函数（API 治理进化刀 M） ─────────────
// 技术栈 §8.3 子步 3.6：语料 = 官方清单 ∪ 本机已装清单，逐清单跑现役纯函数三件
// （adjudicateApiGate 两态注入 / readHostVersionFields / classifyFaceDiff×
// judgeBreakages 判级）——「点火后终态」的发布时点证据（试跑的是 injected 终态，
// pre-ignition 现态恒绿不构成证据）。三函数逐名现役零新概念（冷读 CR1）。

/**
 * 语料收集（纯读文件系统，零副作用）。两面：
 * - 官方面 = `<workDir>/apps/*.app.yaml` 全清单（默认层各行——目录缺席 = 面
 *   空不阻断，契约 3 files 检视另辖）；
 * - 已装面 = `<dataDir>/apps/sources.json` 装机账本逐键定位装机物根、根下单层
 *   发现 `*.app.yaml`（与 apps-check 面二同律：npm/git 键是 `apps/` 下相对定位
 *   串直接拼、local 键即绝对路径原样、`skills/` 键是技能通道非应用跳过）。
 *   账本缺席 = 首装零应用（面空——记录性）；账本在而装机物失联 = 记入 missing
 *   披露不红（账本卫生属 apps check 诊断面职，crater 只披露不执法）。
 * 清单坏 yaml / 缺 id 键直接抛——语料损坏 = 事故红，不静默缩语料（crater 的
 * 证据完整性先于通过率）。
 * @param {{workDir?: string, dataDir?: string}} opts 官方面仓库根 + 已装面数据
 *   目录（缺省 = APP_DATA_DIR ?? ~/.berry——与 src/app/paths.ts dataDir() 同源）
 * @returns {{corpus: Array<{appId: string, api: object|undefined, origin: string}>, missing: string[]}}
 */
export function collectCraterManifests({
  workDir = REPO_ROOT,
  dataDir = process.env.APP_DATA_DIR ?? join(homedir(), '.berry'),
} = {}) {
  const corpus = [];
  const missing = [];
  // 面一：官方清单目录（随包面——默认层各行 .app.yaml）
  const appsDir = join(workDir, 'apps');
  if (existsSync(appsDir)) {
    for (const name of readdirSync(appsDir).sort()) {
      if (!name.endsWith('.app.yaml')) continue;
      const manifest = parseYaml(readFileSync(join(appsDir, name), 'utf8'));
      if (manifest === null || typeof manifest !== 'object' || typeof manifest.id !== 'string') {
        throw new Error(`官方清单坏 yaml：apps/${name}（缺 id 键——语料损坏即事故红）`);
      }
      corpus.push({ appId: manifest.id, api: manifest.api, origin: `official:apps/${name}` });
    }
  }
  // 面二：第三方装机账本（账本 = 装机枚举——「组合树 = 装配枚举、账本 = 装机
  // 枚举」双源原则的物理面）
  const ledgerPath = join(dataDir, 'apps', 'sources.json');
  if (!existsSync(ledgerPath)) return { corpus, missing };
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  for (const key of Object.keys(ledger).sort()) {
    if (key.startsWith('skills/')) continue; // 技能通道键——非应用不进语料
    const root = isAbsolute(key) ? key : join(dataDir, 'apps', key); // local 形 / npm·git 形同律
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      missing.push(key); // 账本在而物不在——披露不红（重装或卸载收账属诊断面）
      continue;
    }
    for (const name of readdirSync(root).sort()) {
      if (!name.endsWith('.app.yaml')) continue;
      const manifest = parseYaml(readFileSync(join(root, name), 'utf8'));
      if (manifest === null || typeof manifest !== 'object' || typeof manifest.id !== 'string') {
        throw new Error(`已装清单坏 yaml：${join(root, name)}（缺 id 键——语料损坏即事故红）`);
      }
      corpus.push({ appId: manifest.id, api: manifest.api, origin: `installed:${key}/${name}` });
    }
  }
  return { corpus, missing };
}

/**
 * 装载腿拒载分类（纯函数）：把 adjudicateApiGate 的 throw 归入三桶——
 * 'missing-block'（缺 api 块——legacy 翻转拒载，设计内：crater 的发现产物）、
 * 'below-floor'（min 超地板——两态同抛的设计内拒载）、'unexpected'（其余一切：
 * 版本形坏 / 实验键未声明 / 能力缺席三类意外出口与非 AppError 形——两态恒红）。
 * 判据 = AppError 码 + 执法面原文短语；短语漂移由回归锁对真函数钉死（消息改
 * 文案必先过锁）。
 * @param {unknown} err adjudicateApiGate 抛出的错误（或任意形）
 * @returns {'missing-block' | 'below-floor' | 'unexpected'}
 */
export function classifyGateRejection(err) {
  const code = err !== null && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  // message 走鸭子形读取（AppError 真形与测试替身对象同吃）；无 message 键才
  // 落 String(err) 整体兜底
  const message =
    err !== null && typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err);
  if (code === 'API_VERSION_MISMATCH') {
    if (message.includes('缺 api 块')) return 'missing-block';
    if (message.includes('低于地板')) return 'below-floor';
  }
  return 'unexpected';
}

/**
 * 装载腿裁决（纯函数——gate 注入缝，产码调用点传真 adjudicateApiGate）。
 * 逐清单 × ignited 两态注入跑装载门，断言谓词写死为机器可判形（冷读 CR2/CR3）：
 * - ignited=false 态：零拒载——任何 throw 均事故红（含 below-floor：官方件
 *   min 超过正在发布的宿主本身就是事故）；
 * - ignited=true 态：拒载集合 ⊆ {missing-block ∪ below-floor} 且逐项随摘要
 *   落发布日志（机器差异可见）——非空不红只记录（发现产物：点火日预告面）；
 * - 'unexpected' 三类意外出口：两态恒红。
 * @param {{manifests: Array<{appId: string, api: object|undefined, origin: string}>,
 *   hostApiVersion: string, gate: Function}} input gate = (api, hostApiVersion, appId, ignited)
 * @returns {{pass: boolean, accidents: Array<{appId, origin, kind, message}>,
 *   rejections: Array<{appId, origin, kind, message}>}}
 */
export function judgeCraterGate({ manifests, hostApiVersion, gate }) {
  const accidents = []; // false 态拒载（全量 = 事故红）
  const rejections = []; // true 态拒载（⊆ 两设计内桶 = 记录不红）
  for (const { appId, api, origin } of manifests) {
    try {
      gate(api, hostApiVersion, appId, false);
    } catch (err) {
      accidents.push({
        appId,
        origin,
        kind: classifyGateRejection(err),
        message: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      gate(api, hostApiVersion, appId, true);
    } catch (err) {
      rejections.push({
        appId,
        origin,
        kind: classifyGateRejection(err),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const pass = accidents.length === 0 && rejections.every((r) => r.kind !== 'unexpected');
  return { pass, accidents, rejections };
}

/**
 * semver 三段号的 major 段（判级腿「已判 MAJOR」的版本号判据——判 MAJOR 即
 * 合法破坏，版本号 major 段升位是其发布机器可见形态）。非形 → NaN（NaN 比较
 * 恒假 → major 桶非空时恒走红支——fail-closed）。
 * @param {string} v 宿主 release 号（semver 三段，可带 prerelease 尾）
 */
function majorSegmentOf(v) {
  const m = /^(\d+)\./.exec(v);
  return m === null ? Number.NaN : Number(m[1]);
}

/**
 * 判级腿裁决（纯函数——纪元门镜像查 9，冷读 CR3）：classifyFaceDiff（上一档
 * 归档快照 vs 本版快照）× judgeBreakages（§6.13.6 语义）。比较基准取归档族中
 * **除本版外**的最新档（子步 3.5 已先归档本版——不过滤则 diff 恒零假绿；重跑
 * 幂等态同律）。三态：
 * - 纪元门休眠（eraOf ≠ 'ignited'）→ 'recorded'：记录性通过，输出面 diff 供
 *   人读不阻断（pre-release 自由 rename 窗口内无 DEP 的面演进是合法变更）；
 * - 基线门休眠（除本版外归档族空 = 首档无上一档基线）→ 'recorded'；
 * - 执法（ignited 后）：removed/changed 逐键「有生效 DEP（sanctioned）或该版
 *   已判 MAJOR（release 号 major 段 > 上一档 major 段）」二者其一即过；major
 *   桶非空而版本未升 major = 无凭证破坏 → 'red'。
 * @param {{currentSurface: object, archives: Array<{version: string, surface: object}>,
 *   deprecations: Array<{symbol: string, dep: string, removalIn: string}>, releaseVersion: string}} input
 * @returns {{status: 'recorded'|'pass'|'red', note?: string, base?: string,
 *   diff?: object, breakages?: Array<{kind: 'removed'|'changed', keys: string[]}>}}
 */
export function judgeCraterFace({ currentSurface, archives, deprecations, releaseVersion }) {
  if (eraOf(currentSurface) !== 'ignited') {
    return { status: 'recorded', note: `执法纪元 ${eraOf(currentSurface)}——纪元门休眠（记录性通过）` };
  }
  // 基线 = 除本版外的最新归档（3.5 已先落本版档——自比恒零，必滤）
  const prior = archives.filter((a) => a.version !== releaseVersion);
  if (prior.length === 0) {
    return { status: 'recorded', note: '归档族空（首档基线未成）——记录性通过' };
  }
  const last = prior[prior.length - 1];
  const diff = classifyFaceDiff(last.surface, currentSurface);
  const breakages = [];
  for (const kind of ['removed', 'changed']) {
    const judged = judgeBreakages(diff[kind], kind, deprecations, currentSurface.apiVersion);
    // major 桶 = 无 DEP 凭证的破坏——合法当且仅当版本号已判 MAJOR（major 段升位）
    if (judged.major.length > 0 && !(majorSegmentOf(releaseVersion) > majorSegmentOf(last.version))) {
      breakages.push({ kind, keys: judged.major });
    }
  }
  if (breakages.length > 0) return { status: 'red', base: last.version, diff, breakages };
  return { status: 'pass', base: last.version, diff };
}

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
 * @param {{workDir?: string, pkg?: {name:string,version:string,binName:string}, dataDir?: string}} opts
 *   workDir 真跑 = 仓库根（pack 落点/git 锚点）；pkg 缺省读 workDir/package.json；
 *   dataDir = 子步 3.6 已装面数据目录（缺省 APP_DATA_DIR ?? ~/.berry——与
 *   src/app/paths.ts dataDir() 同源；测试钉临时目录防真装机态入语料）
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
  // 子进程锚定发布根（基建大扫 #21 统一模型）：包装层缺省注入 cwd: workDir——
  // 「子进程锚定发布根」成为缺省语义，显式传 opts.cwd 才偏离。此前 git 净空核验
  // /pack 检视/git tag 十五调用点全落 process.cwd()（仅 pack:real 自带 cwd——
  // 同契约内不对称）：从非包根目录以绝对路径调用时净空核验会在恰好的另一净空
  // git 仓意外绿。注入谱不受影响（canned 按 label 应答，不看 opts）
  const anchoredIo = {
    exec(label, command, args, opts = {}) {
      return activeIo.exec(label, command, args, { cwd: workDir, ...opts });
    },
  };
  // 注入谱组合闸（遗漏大扫 20260901-c #7）：canned 步骤位于 publish 之后的谱项必须
  // 配 --dry-run——闸在契约 1 之前，任何步骤（连门禁都不）触达；此处守编程调用路
  // （CLI 路由 parseReleaseCli 同判，输出为用法错退出 2）
  if (injectName && !dryRun && INJECT_SCENARIOS[injectName].requiresDryRun) {
    throw new Error(`注入谱 ${injectName} 的 canned 步骤位于 publish 之后——须配 --dry-run 演习（真跑形态会真上传）`);
  }

  // ── 契约 1：门禁前置不可绕 + 工作树净空 ──
  for (const gate of GATES) {
    console.log(`── 契约 1/6 门禁：${gate}`);
    const r = await anchoredIo.exec(`gate:${gate}`, 'npm', ['run', gate], { inherit: true });
    if (r.code !== 0) throw new Error(`门禁红拒：${gate} 退出码 ${r.code}——发布路径无 skip 出口`);
  }
  const clean = await anchoredIo.exec('git-clean', 'git', ['status', '--porcelain']);
  if (clean.code !== 0) throw new Error('git status 失败——工作树净空无法核验，拒发');
  if (clean.stdout.trim() !== '') {
    throw new Error(`工作树非净空（${clean.stdout.trim().split('\n').length} 处未提交改动）——禁发未提交态`);
  }

  // ── 契约 2：registry 探测（只读三态） ──
  console.log(`── 契约 2/6 registry 探测：${pkg.name}@${pkg.version}`);
  const probeRaw = await anchoredIo.exec('probe', 'npm', [
    'view',
    `${pkg.name}@${pkg.version}`,
    'dist.shasum',
    '--json',
  ]);
  const probe = classifyProbe(probeRaw);
  console.log(`  探测终态：${probe.state}`);

  // ── 契约 3：构建即打包与发布物验收 ──
  console.log('── 契约 3/6 构建 + 打包 + 检视 + 安装冒烟');
  rmSync(join(workDir, 'dist'), { recursive: true, force: true }); // 全新 build：先清 dist
  const build = await anchoredIo.exec('build', 'npm', ['run', 'build'], { inherit: true });
  if (build.code !== 0) throw new Error(`构建失败（退出码 ${build.code}）`);
  const inspect = await anchoredIo.exec('pack:inspect', 'npm', ['pack', '--dry-run', '--json']);
  if (inspect.code !== 0) throw new Error('npm pack --dry-run 失败');
  // prepare 钩子 stdout 前置污染剥离（parseNpmPackJson 单源——CI 33545358469 根因）
  const inspectParsed = parseNpmPackJson(inspect.stdout);
  if (inspectParsed === null) throw new Error(`npm pack --dry-run 输出不可解析：${inspect.stdout.slice(0, 120)}`);
  const inspectResult = inspectParsed[0];
  const verdict = inspectPackEntries(inspectResult.files ?? []);
  if (!verdict.ok) {
    throw new Error(`pack 检视不过：缺失 [${verdict.missing.join('; ')}] 违禁 [${verdict.violations.join('; ')}]`);
  }
  console.log(`  检视绿：${(inspectResult.files ?? []).length} 个文件全过白名单`);
  // pack:real 的 cwd 走包装层缺省（基建大扫 #21 统一后与全体调用点同源——不再单点显式传）
  const packReal = await anchoredIo.exec('pack:real', 'npm', ['pack', '--json']);
  if (packReal.code !== 0) throw new Error('npm pack 失败');
  const packParsed = parseNpmPackJson(packReal.stdout);
  if (packParsed === null) throw new Error(`npm pack 输出不可解析：${packReal.stdout.slice(0, 120)}`);
  const tarballName = packParsed[0].filename;
  const tarballPath = join(workDir, tarballName);
  if (!existsSync(tarballPath)) throw new Error(`tarball 未落盘：${tarballPath}`);
  const localShasum = sha1(tarballPath);
  console.log(`  tarball：${tarballName}（sha1 ${localShasum.slice(0, 12)}…）`);
  // tarball 生命周期 = 契约 3 打出 → 契约 4 上传 → 收尾即弃；成功/失败两路
  // 同走 finally 兜底清理（与安装冒烟 prefix 同律「即用即清」）——tarball 滞留
  // 仓库根会成为未跟踪残留，污染下一轮契约 1 工作树净空核验（机器自锁死）；
  // 重跑自同一 commit 确定性重建，清理无损失
  try {
    await installSmoke(anchoredIo, {
      tarballPath,
      binName: pkg.binName,
      version: pkg.version,
      defaultAppId: readDefaultAppId(workDir),
    });

    // ── 契约 3 子步 3.5：面快照归档（技术栈 §8.3——快照与兼容档案一币两面）──
    // 源 = 契约 3 构建产出的 dist/api/surface.json（上传物同源——检视即所传同律）；
    // 归档 commit 先于契约 6 打 tag（tag 树必含本版快照）且同笔携再生
    // COMPATIBILITY.md。机械 commit 走普通 git commit——pre-commit 四门禁照跑
    // （树 = 契约 1 已绿之树 + 确定性生成物，绿是预期；发布机不豁免执法）；若
    // add 后 commit 失败，staged 残留会被下轮契约 1 净空核验拦下——fail-loud
    // 由净空闸兜底。
    const builtSurfacePath = join(workDir, 'dist/api/surface.json');
    if (!existsSync(builtSurfacePath)) {
      throw new Error('dist/api/surface.json 缺席——build 链断在面快照步（契约 3 必在清单应已拦，此处兜底响亮）');
    }
    const builtSurfaceText = readFileSync(builtSurfacePath, 'utf8');
    const archiveDir = join(workDir, 'api/snapshots');
    const archivePath = join(archiveDir, `${pkg.version}.json`);
    const archivePlan = planSnapshotArchive({
      archiveExists: existsSync(archivePath),
      identical: existsSync(archivePath) && readFileSync(archivePath, 'utf8') === builtSurfaceText,
    });
    if (archivePlan.action === 'reject') throw new Error(`子步 3.5 拒：${archivePlan.reason}`);
    if (archivePlan.action === 'skip') {
      console.log(`── 子步 3.5 面快照归档：${pkg.version} ${archivePlan.reason}`);
    } else if (dryRun) {
      console.log(
        `── 子步 3.5 面快照归档（dry-run 只投影）：将落 api/snapshots/${pkg.version}.json + 同笔再生 COMPATIBILITY.md + 机械 commit`,
      );
    } else {
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(archivePath, builtSurfaceText);
      // 同笔再生 COMPATIBILITY.md：新归档激活「变更史」逐版判级小节（渲染输入 =
      // 含刚落档本次快照的档族全体）；DEP 注册簿走真册（机器判级认登记不认动机）
      const regenerated = renderCompatibility({
        surface: JSON.parse(builtSurfaceText),
        deprecations: (await imp('../src/contracts/deprecations.ts')).DEPRECATIONS,
        snapshots: loadArchivedSnapshots(archiveDir),
      });
      writeFileSync(join(workDir, 'COMPATIBILITY.md'), regenerated);
      console.log(
        `── 子步 3.5 面快照归档：api/snapshots/${pkg.version}.json + COMPATIBILITY.md 同笔再生（机械 commit）`,
      );
      const add = await anchoredIo.exec('snapshot:add', 'git', [
        'add',
        `api/snapshots/${pkg.version}.json`,
        'COMPATIBILITY.md',
      ]);
      if (add.code !== 0) throw new Error(`git add 快照归档两件失败（退出码 ${add.code}）`);
      const commit = await anchoredIo.exec('snapshot:commit', 'git', [
        'commit',
        // --only 点名两件（刀四）：commit 只带归档快照 + 再生 COMPATIBILITY.md——
        // 「只带两件」由契约 1 净空环境假设升为结构保证，index 内任何他物（并发
        // 会话半成品等）被卷入结构性不可能；--only 照跑 pre-commit 四门禁（发布
        // 机器不豁免执法——净空闸 + 门禁闸双在）
        '--only',
        `api/snapshots/${pkg.version}.json`,
        'COMPATIBILITY.md',
        '-m',
        `chore(release): API surface snapshot ${pkg.version}`,
      ]);
      if (commit.code !== 0) throw new Error(`快照归档 commit 失败（退出码 ${commit.code}）`);
    }

    // ── 契约 3 子步 3.6：语料试跑（crater 骨架——技术栈 §8.3；3.5 归档之后、
    // 契约 4 publish 之前）──
    // 语料 = 官方清单 ∪ 本机已装清单，逐清单跑现役纯函数三件（adjudicateApiGate
    // 两态注入 / readHostVersionFields / classifyFaceDiff×judgeBreakages 判级）。
    // --dry-run 照跑（只读纯函数面，零 git/npm 触达）；ignited=true 态的拒载 =
    // crater 的发现产物（点火日预告面——逐项落发布日志，非空不红只记录）。
    {
      const { corpus, missing } = collectCraterManifests({
        workDir,
        dataDir: opts.dataDir ?? process.env.APP_DATA_DIR ?? join(homedir(), '.berry'),
      });
      // 三函数逐名现役（冷读 CR1）：装载门 + 宿主版本双字段都走真源 jiti 装载
      const gateMod = await imp('../src/contracts/api.ts');
      const hostApiVersion = (await imp('../src/app/host-face.ts')).readHostVersionFields().apiVersion;
      const gateVerdict = judgeCraterGate({ manifests: corpus, hostApiVersion, gate: gateMod.adjudicateApiGate });
      console.log(
        `── 子步 3.6 语料试跑（crater）：装载腿 ${corpus.length} 清单 × ignited 两态（宿主面号 ${hostApiVersion}）` +
          (corpus.length === 0
            ? '——语料空（首装零应用——记录性通过非跳过）'
            : gateVerdict.rejections.length === 0
              ? '——ignited=true 态零拒载'
              : `——ignited=true 态拒载 ${gateVerdict.rejections.length} 项（发现产物，记录不红）`),
      );
      for (const key of missing) {
        console.log(`   ⚠ 装机物失联（账本在而物不在——apps check 诊断面职）：${key}`);
      }
      for (const rej of gateVerdict.rejections) {
        console.log(`   · [${rej.kind}] ${rej.appId}（${rej.origin}）——${rej.message.replace(/\n/g, ' ')}`);
      }
      if (gateVerdict.accidents.length > 0) {
        const head = gateVerdict.accidents[0];
        throw new Error(
          `子步 3.6 装载腿拒：ignited=false 注入态须零拒载（任何 throw 均事故红）——` +
            `${gateVerdict.accidents.length} 项：首项 [${head.kind}] ${head.appId}（${head.origin}）${head.message.replace(/\n/g, ' ')}`,
        );
      }
      if (gateVerdict.rejections.some((r) => r.kind === 'unexpected')) {
        const bad = gateVerdict.rejections.find((r) => r.kind === 'unexpected');
        throw new Error(
          `子步 3.6 装载腿拒：ignited=true 态出现意外出口（版本形坏/实验键未声明/能力缺席三类——两态恒红）` +
            `：[${bad.kind}] ${bad.appId}（${bad.origin}）${bad.message.replace(/\n/g, ' ')}`,
        );
      }
      // 判级腿：纪元门镜像查 9（pre-ignition 现态 = 记录性通过，机制常驻、点火
      // 日即执法日）；归档族取真位（3.5 已先归档本版——judgeCraterFace 内滤自比）
      const faceVerdict = judgeCraterFace({
        currentSurface: JSON.parse(builtSurfaceText),
        archives: loadArchivedSnapshots(archiveDir),
        deprecations: (await imp('../src/contracts/deprecations.ts')).DEPRECATIONS,
        releaseVersion: pkg.version,
      });
      if (faceVerdict.status === 'recorded') {
        console.log(`── 子步 3.6 判级腿：${faceVerdict.note}`);
      } else {
        const d = faceVerdict.diff;
        console.log(
          `── 子步 3.6 判级腿：${faceVerdict.status === 'pass' ? '过' : '拒'}（基线 ${faceVerdict.base} → ` +
            `面 diff 新增 ${d.added.length} / 移除 ${d.removed.length} / 改形 ${d.changed.length} / ` +
            `重定级 ${d.reTiered.length}${d.capabilitiesChanged ? ' / capabilities 有变' : ''}）`,
        );
        if (faceVerdict.status === 'red') {
          const lines = faceVerdict.breakages.map((b) => `${b.kind}: ${b.keys.join(', ')}`).join('；');
          throw new Error(
            `子步 3.6 判级腿拒：ignited 后 removed/changed 须有生效 DEP 凭证或该版已判 MAJOR（major 段升位）` +
              `二者其一——无凭证破坏 ${lines}`,
          );
        }
      }
    }

    // ── 契约 4：幂等收口与 publish 单点 ──
    const plan = planTagOperations(pkg.version);
    let decision = decideIdempotent(probe, localShasum);
    if (decision.action === 'reject' && probe.state === 'present' && !probe.deferEqual) {
      // 字节不等先深对照再裁决（刀四）：build-meta 溯源戳漂移是中断重跑的必然
      // 形态（3.5 归档 commit 先于本步移动 HEAD），不剥离它一切重跑都被误判异质；
      // 对照不可行时 decideIdempotent 对 ok:false 维持拒（fail-closed 不盲跳）
      console.log('── 契约 4/6 字节不等——内容级深对照（剥离 dist/.build-meta.json 溯源戳）');
      const contentEquiv = await deepCompareTarballs(anchoredIo, {
        name: pkg.name,
        version: pkg.version,
        localTarballPath: tarballPath,
      });
      decision = decideIdempotent(probe, localShasum, contentEquiv);
    }
    if (decision.action === 'reject') throw new Error(decision.reason);
    // 正式期「next 不动」需要 publish 前快照（preview 期两腿同指不需要）——
    // 快照必须先于任何写操作：本脚本的正式期发布不触 next，比对即「我们没动它」
    let nextBefore;
    if (!plan.isPrerelease) {
      const pre = await anchoredIo.exec('view-tags:pre', 'npm', ['view', pkg.name, 'dist-tags', '--json']);
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
      const pub = await anchoredIo.exec(
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
          const add = await anchoredIo.exec('dist-tag-add', 'npm', [
            'dist-tag',
            'add',
            `${pkg.name}@${pkg.version}`,
            tag,
          ]);
          if (add.code !== 0) throw new Error(`dist-tag add ${tag} 失败（退出码 ${add.code}）`);
        }
      }
      const post = await anchoredIo.exec('view-tags:post', 'npm', ['view', pkg.name, 'dist-tags', '--json']);
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
    const listRaw = await anchoredIo.exec('git-tag:list', 'git', ['tag', '-l', tag]);
    if (listRaw.code !== 0) throw new Error('git tag -l 失败');
    let tagSha;
    const tagExists = listRaw.stdout.trim() !== '';
    if (tagExists) {
      const rev = await anchoredIo.exec('git-rev:tag', 'git', ['rev-parse', `${tag}^{commit}`]);
      if (rev.code !== 0) throw new Error(`git rev-parse ${tag} 失败`);
      tagSha = rev.stdout.trim();
    }
    const head = await anchoredIo.exec('git-rev:head', 'git', ['rev-parse', 'HEAD']);
    if (head.code !== 0) throw new Error('git rev-parse HEAD 失败');
    const gitAction = classifyGitTag(tagExists, tagSha, head.stdout.trim());
    if (gitAction.action === 'reject') {
      throw new Error(`git tag ${tag} 已在但指向异 commit（${tagSha} ≠ ${head.stdout.trim()}）——响亮拒`);
    }
    if (gitAction.action === 'create' && !dryRun) {
      const mk = await anchoredIo.exec('git-tag:create', 'git', ['tag', tag]);
      if (mk.code !== 0) throw new Error(`git tag ${tag} 创建失败`);
      // push 恒带 HTTP/1.1（遗漏大扫 20260901-c #17）：与仓库管理推送纪律/归档机器
      // 同律——本机到 GitHub 的 HTTP/2 推流不稳，release 机器不得是全仓唯一裸 push 例外
      const push = await anchoredIo.exec('git-tag:push', 'git', ['-c', 'http.version=HTTP/1.1', 'push', 'origin', tag]);
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
async function installSmoke(io, { tarballPath, binName, version, defaultAppId }) {
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
    // 非空且默认应用解析为装机产物内清单的 default 键（基建大扫 #36：期望值由
    // readDefaultAppId 从仓内清单动态读——官方拍板换默认应用时零人工同步，与
    // readPackageFace「零硬编码字面量」纪律同拍）——apps/ 目录缺席即此处红，
    // 静默降级面收进发布闸
    const probe = await io.exec('smoke:apps', join(prefix, 'node_modules', '.bin', binName), ['dump-config'], {
      env: { APP_DATA_DIR: join(prefix, 'smoke-data'), APP_LOG_LEVEL: 'error' },
    });
    if (probe.code !== 0) {
      throw new Error(`安装冒烟失败：${binName} dump-config 退出码 ${probe.code}（发布物装机后不可装配）`);
    }
    if (defaultAppId === undefined || !probe.stdout.includes(`默认应用：${defaultAppId}`)) {
      throw new Error(
        `安装冒烟失败：dump-config 未见「默认应用：${defaultAppId ?? '(仓内清单无 default 键)'}」——官方应用清单（apps/）疑似缺席，首启默认应用承诺将静默破裂`,
      );
    }
    console.log(`  安装冒烟绿：${binName} --version = ${smokeOut}；dump-config 默认应用 = ${defaultAppId}`);
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

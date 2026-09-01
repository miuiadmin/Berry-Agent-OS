/**
 * L5 app — `berry upgrade` 第六命令（技术栈篇 §8.5，第五十一批「升级与上手基建」）。
 *
 * 纯函数核心 + 编排器分离：dist-tags 解析 / semver 比对 / 装机形态判定 /
 * 指引文案全为纯函数（可测）；网络（node:fetch 零新依赖）与 spawn 只活在
 * 编排器——编排器携注入面（UpgradeMainIo，遗漏大扫 20260901-b #8 第五十三批）：
 * 行为契约（target 白名单/五态分派/退出码/npm 半态）进 vitest，真链路手验。
 *
 * 网络面正交声明（与 §8 末「默认不发任何网络包」的关系）：本命令是 CLI
 * 维护动词——与 npm install 同族的进程外用户显式维护动作，只读 GET
 * dist-tags、不回传数据、不在 agent 运行时探测版本；不跑 upgrade 即零网络。
 */

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';

/** 装机形态：npm 全局装（可自升级） / 源码树（给指引不自动执行——本地改动风险） */
export type InstallForm = 'npm' | 'source';

/** registry dist-tags 查询结果三态（未发布 / 网络失败与成功分立——诚实披露） */
export type DistTagsResult =
  | { readonly status: 'ok'; readonly tags: Readonly<Record<string, string>> }
  | { readonly status: 'unpublished' }
  | { readonly status: 'network'; readonly message: string };

/** 查询超时（毫秒）——用户在终端等着，快速失败好过悬挂 */
const FETCH_TIMEOUT_MS = 10_000;

/* ---------------- 纯函数核心（测试面） ---------------- */

/**
 * semver 比对（规范简化版，本用例足够）：三段数字比大小；prerelease 缺席 > 在场
 * （1.0.0 > 1.0.0-alpha.0）；同在场按点分段——纯数字段比数字、混合段字典序、
 * 前缀相同短者小（semver 规则 11-12 的简化实现，非标场景按字典序兜底）。
 * @returns -1（a<b）/ 0（相等）/ 1（a>b）
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa.core[i]! < pb.core[i]!) return -1;
    if (pa.core[i]! > pb.core[i]!) return 1;
  }
  // 三段相等：无 prerelease 者大
  if (pa.pre === undefined && pb.pre === undefined) return 0;
  if (pa.pre === undefined) return 1;
  if (pb.pre === undefined) return -1;
  // 双 prerelease：逐段比（数字段数值序、其余字典序；前缀同则短者小）
  const sa = pa.pre.split('.');
  const sb = pb.pre.split('.');
  const len = Math.min(sa.length!, sb.length!);
  for (let i = 0; i < len; i++) {
    const na = /^\d+$/.test(sa[i]!);
    const nb = /^\d+$/.test(sb[i]!);
    if (na && nb) {
      const va = Number(sa[i]);
      const vb = Number(sb[i]);
      if (va < vb) return -1;
      if (va > vb) return 1;
    } else {
      // 同段一数字一字母：数字段恒小（semver 规则）——先于字典序判（否则死码）
      if (na !== nb) return na ? -1 : 1;
      const cmp = sa[i]! < sb[i]! ? -1 : sa[i]! > sb[i]! ? 1 : 0;
      if (cmp !== 0) return cmp;
    }
  }
  if (sa.length! < sb.length!) return -1;
  if (sa.length! > sb.length!) return 1;
  return 0;
}

/** 拆 semver：core 三段数字 + 可选 prerelease 串（非法输入按 0.0.0 兜底不抛） */
function parseSemver(v: string): { core: [number, number, number]; pre: string | undefined } {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (m === null) return { core: [0, 0, 0], pre: undefined };
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] };
}

/**
 * 装机形态判定：入口文件 real path 含 `node_modules` 段 = npm 全局装
 * （bin 链接解析到包内 dist/）；源码 clone（含 npm link 形态——realpath
 * 解回仓库目录）= source。升级路径分立的法律判据。
 */
export function detectInstallForm(entryRealPath: string): InstallForm {
  // 按路径段判定（win32 反斜杠同分——realpathSync 在 win32 返回反斜杠形态）
  return entryRealPath.split(/[\\/]/).includes('node_modules') ? 'npm' : 'source';
}

/**
 * npm 形态的包管理器甄别（冷读 m1 余款）：pnpm/yarn/bun 全局装路径同样含
 * node_modules（会误入 npm 分支）——spawn `npm i -g` 会装出第二份、原装不
 * 升级。检出 `.pnpm` / `pnpm-global` / `yarn`（大小写不敏感——win32 yarn
 * classic 大写段）/ `.bun→install→global` / BUN_INSTALL 自定义根前缀路径
 * 形时给原管理器指引。
 */
export function detectPackageManager(entryRealPath: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  const segs = entryRealPath.split(/[\\/]/);
  // `.pnpm`（虚拟仓）/ `.pnpm-*`（home 变体）/ `pnpm-global`（无点形）三形并收
  if (segs.some((x) => x === '.pnpm' || x.startsWith('.pnpm-') || x.startsWith('pnpm-global'))) {
    return 'pnpm';
  }
  // yarn 段大小写不敏感比对（遗漏大扫 20260901-c #10）：yarn classic (v1) 在
  // Windows 的全局装目录是 %LOCALAPPDATA%\Yarn\config\global——段名首字母大写，
  // 小写精确比对漏检即误判 npm 后 spawn npm i -g 装出第二份、原装不升级
  if (segs.some((x) => x.toLowerCase() === 'yarn')) return 'yarn';
  // bun 全局装：`~/.bun/install/global/node_modules/…`——三段序判定（裸 `bun`
  // 目录名不构成判据，防普通项目目录误伤）
  const bunIdx = segs.indexOf('.bun');
  if (bunIdx >= 0 && segs[bunIdx + 1] === 'install' && segs[bunIdx + 2] === 'global') {
    return 'bun';
  }
  // bun 自定义安装根（遗漏大扫 20260901-c #18）：BUN_INSTALL 可整体换根
  // （默认 ~/.bun 只是缺省值非协议不变量）——根下同样落 install/global 段序；
  // BUN_INSTALL_GLOBAL_DIR 直改全局目录本体。两变量任一前缀命中即 bun。
  // 比对大小写不敏感（win32 盘符/目录大小写不定形），分隔符归一正斜杠；
  // 尾斜杠归一后带 / 前缀比对防相似名兄弟目录误伤（/opt/bunny ≠ /opt/bun）
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const entryNorm = norm(entryRealPath);
  for (const root of [process.env.BUN_INSTALL, process.env.BUN_INSTALL_GLOBAL_DIR]) {
    if (root && entryNorm.startsWith(`${norm(root)}/`)) return 'bun';
  }
  return 'npm';
}

/** 非 npm 包管理器的升级指引（原管理器一条命令——本命令不代执行） */
export function foreignManagerGuidance(manager: 'pnpm' | 'yarn' | 'bun'): string {
  const cmd =
    manager === 'pnpm'
      ? 'pnpm add -g berryagent'
      : manager === 'yarn'
        ? 'yarn global add berryagent'
        : 'bun add -g berryagent';
  return `检测到 ${manager} 全局安装形态——请用原包管理器升级（\`${cmd}\`），本命令不代执行（npm i -g 会装出第二份）。`;
}

/**
 * 目标版本选择：preview 期 latest 跟 alpha（§8.1 律）——latest 缺席时回落
 * next（alpha/rc 演习 tag）；两者皆缺 = 无可升级目标。
 */
export function pickTargetVersion(tags: Readonly<Record<string, string>>): string | undefined {
  return tags['latest'] ?? tags['next'] ?? undefined;
}

/** 源码形态升级指引（不自动执行——源码树可能有本地改动，自动 pull 危险） */
export function sourceUpgradeGuidance(currentVersion: string): string {
  return [
    `当前为源码安装形态（berry ${currentVersion}）——不自动执行升级（源码树可能有本地改动）。`,
    '手动升级四步：',
    '  1. git pull            # 拉取最新代码（有本地改动先 stash/commit）',
    '  2. npm install         # 依赖对齐',
    '  3. npm run build       # 重新构建',
    '  4. npm link            # 刷新 berry 命令链接',
  ].join('\n');
}

/** 未发布态指引（registry 404——发布前形态诚实告知） */
export function unpublishedGuidance(currentVersion: string): string {
  return [
    `berryagent 尚未发布到 npm（registry 404）——当前 ${currentVersion} 为源码/预发布形态。`,
    '发布后可用 `berry upgrade` 自升级；此前请走源码升级路（git pull → npm install → npm run build → npm link）。',
  ].join('\n');
}

/* ---------------- 编排器（网络与 spawn 只在此） ---------------- */

/** 官方 registry 根（解析失败/空输出的回退位——技术栈篇 §8.5 条 1） */
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org';

/**
 * 拼接 dist-tags 查询端点（纯函数——#16 判定腿与执行腿同源）。
 * 尾斜杠归一（npm config 输出两种形态都常见）；空/空白串回退官方源。
 */
export function distTagsUrlFor(registryBase: string): string {
  const base = registryBase.trim();
  if (base === '') return `${OFFICIAL_REGISTRY}/-/package/berryagent/dist-tags`;
  return `${base.replace(/\/+$/, '')}/-/package/berryagent/dist-tags`;
}

/** npm 进程执行面（resolveRegistry 的注入位——测试假面换跑，真面 spawn） */
export type NpmRunner = (args: readonly string[]) => Promise<{ code: number; stdout: string }>;

/** registry 解析结果：base = 拼端点用的根；fallback = 是否走了官方源回退（注记位） */
export interface RegistryResolution {
  readonly base: string;
  readonly fallback: boolean;
}

/** 真面：spawn npm（win32 走 npm.cmd + shell——与安装腿同款形态；10s 超时） */
const realNpmRunner: NpmRunner = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', [...args], {
      shell: process.platform === 'win32',
      timeout: FETCH_TIMEOUT_MS,
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    // 失败/超时/空输出一律走回退——registry 解析是尽力而为的取齐，不是硬前置
    child.on('error', () => resolve({ code: 1, stdout: '' }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });

/**
 * 解析用户 npm 配置源（#16：判定腿与安装腿同源——spawn npm i -g 走用户 .npmrc，
 * 版本检查原硬编码官方源即两腿分叉：镜像滞后窗口「可升级」结论失真 + 重试恒败）。
 * 不自研 .npmrc 解析层（global/user/project 三层与 scoped registry 属 npm 自家
 * 配置_resolution），`npm config get registry` 是唯一诚实单源；失败/空输出回退
 * 官方源并立 fallback 旗标——编排器据此输出注记（技术栈篇 §8.5 条 1）。
 */
export async function resolveRegistry(run: NpmRunner = realNpmRunner): Promise<RegistryResolution> {
  const { code, stdout } = await run(['config', 'get', 'registry']);
  // code≠0 但 stdout 可能非空（npm 报错时吐过的残值）——失败态不以输出为准
  const raw = code === 0 ? stdout.trim() : '';
  return raw === '' ? { base: OFFICIAL_REGISTRY, fallback: true } : { base: raw, fallback: false };
}

/**
 * 查询 registry dist-tags（node:fetch + 超时；404 = 未发布，与网络错分立）。
 * @param resolved registry 解析结果（缺省现场解析一次——编排器已解析时传入复用，
 *                 避免判定腿双 spawn）
 */
export async function fetchDistTags(resolved?: RegistryResolution): Promise<DistTagsResult> {
  const url = distTagsUrlFor((resolved ?? (await resolveRegistry())).base);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 404) return { status: 'unpublished' };
    if (!res.ok) return { status: 'network', message: `registry 返回 ${res.status}` };
    const tags = (await res.json()) as Record<string, string>;
    return { status: 'ok', tags };
  } catch (err) {
    return { status: 'network', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 只读检查（/upgrade TUI 薄壳与 CLI 共用）：本地版本 + 形态 + 远端结果 + 结论。
 * 零副作用——网络检查只读 GET，不执行任何升级动作。
 */
export interface UpgradeCheck {
  readonly localVersion: string;
  readonly form: InstallForm;
  readonly remote: DistTagsResult;
  /** 结论：已是最新 / 可升级到 X / 未发布 / 网络失败 / 源码形态（比对结果同给） */
  readonly verdict:
    | { kind: 'up-to-date'; target: string }
    | { kind: 'available'; target: string }
    | { kind: 'unpublished' }
    | { kind: 'network' }
    | { kind: 'source'; target: string };
}

export async function runUpgradeCheck(
  localVersion: string,
  entryRealPath: string,
  io: { readonly fetchDistTags?: () => Promise<DistTagsResult> } = {},
): Promise<UpgradeCheck> {
  const form = detectInstallForm(entryRealPath);
  const remote = await (io.fetchDistTags ?? fetchDistTags)();
  const base = { localVersion, form, remote } as const;
  if (remote.status === 'unpublished') return { ...base, verdict: { kind: 'unpublished' } };
  if (remote.status === 'network') return { ...base, verdict: { kind: 'network' } };
  const target = pickTargetVersion(remote.tags);
  if (target === undefined) return { ...base, verdict: { kind: 'unpublished' } };
  if (form === 'source') return { ...base, verdict: { kind: 'source', target } };
  return compareSemver(localVersion, target) >= 0
    ? { ...base, verdict: { kind: 'up-to-date', target } }
    : { ...base, verdict: { kind: 'available', target } };
}

/** 终端输出微样式（步骤行着色——CLI 面轻量 ANSI，不引依赖） */
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;

/**
 * 编排器依赖注入面（遗漏大扫 20260901-b #8 回归锁——技术栈篇 §8.5 条 1）：
 * 网络/spawn/stdio 全可换假面，vitest 锁行为契约（target 白名单安全线 / 五态
 * verdict 分派 / 退出码契约 / npm 半态收场）；缺省全真面，真链路由
 * `berry upgrade` 手验——两层互补不互代。
 */
export interface UpgradeMainIo {
  /** registry 解析（缺省真面 spawn `npm config get registry`——#16 判定腿） */
  readonly registryBase?: () => Promise<RegistryResolution>;
  /** dist-tags 查询（缺省真网络面） */
  readonly fetchDistTags?: () => Promise<DistTagsResult>;
  /** npm 安装腿（缺省真 spawn npm i -g；resolve = 退出码） */
  readonly spawnNpm?: (target: string) => Promise<number>;
  /** 入口 real path（缺省 argv[1] 解析） */
  readonly entryRealPath?: () => string;
  /** stdout 写口（缺省 process.stdout.write） */
  readonly out?: (s: string) => void;
  /** stderr 写口（缺省 process.stderr.write） */
  readonly err?: (s: string) => void;
}

/** npm 安装腿真面（stdio 继承——npm 自带进度即显示面；resolve 退出码） */
const realSpawnNpm = (target: string): Promise<number> =>
  new Promise<number>((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '-g', `berryagent@${target}`], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', (err) => {
      process.stderr.write(red(`npm 进程启动失败：${err.message}\n`));
      resolve(1);
    });
    child.on('close', (exitCode) => resolve(exitCode ?? 1));
  });

/**
 * `berry upgrade` 主流程（CLI 编排器）：
 * 检查 → 三态分派（npm 自升级 / 源码指引 / 未发布告知）→ 重启提示。
 * @param io 注入面（测试假面——缺省全真）
 * @returns 进程退出码（0 成功/已最新/指引类态；1 升级失败或网络检查失败——用法错由 CLI 层退 2）
 */
export async function upgradeMain(io: UpgradeMainIo = {}): Promise<number> {
  const out = io.out ?? ((s: string) => void process.stdout.write(s));
  const err = io.err ?? ((s: string) => void process.stderr.write(s));
  // registry 解析一次过（#16 判定腿与安装腿同源）：缺省注入面接管；真面解析结果
  // 传入 fetchDistTags 复用（判定腿单次 spawn）。
  const resolvedRegistry = await (io.registryBase ?? resolveRegistry)();
  const fetcher = io.fetchDistTags ?? ((): Promise<DistTagsResult> => fetchDistTags(resolvedRegistry));
  const spawnNpm = io.spawnNpm ?? realSpawnNpm;
  const realPath = io.entryRealPath ?? entryRealPath;

  const localVersion = VERSION;
  out(`${bold(`Berry ${localVersion}（${CODENAME}）`)} ${dim('— 升级维护动词（berry upgrade）')}\n`);

  const form = detectInstallForm(realPath());
  out(`${dim('· 装机形态：')}${form === 'npm' ? 'npm 全局' : '源码'}\n`);

  out(`${dim('· 检查更新（registry dist-tags）…')}\n`);
  if (resolvedRegistry.fallback) {
    // 解析失败回退官方源的注记（技术栈篇 §8.5 条 1）——镜像用户知道为何查了 npmjs.org
    out(dim('· （npm registry 配置未解析成功——检查更新回退官方源 registry.npmjs.org）\n'));
  }
  const check = await runUpgradeCheck(localVersion, realPath(), { fetchDistTags: fetcher });

  if (check.verdict.kind === 'unpublished') {
    out(red('· 未发布：') + 'berryagent 尚未发布到 npm\n\n' + unpublishedGuidance(localVersion) + '\n');
    return 0;
  }
  if (check.verdict.kind === 'network') {
    const netMessage = check.remote.status === 'network' ? check.remote.message : '未知网络错误';
    out(red(`· 网络检查失败：${netMessage}\n`));
    out(dim('（registry 不可达不影响使用；稍后重试或走源码升级路）\n'));
    return 1;
  }
  const target = check.verdict.target;
  out(`${dim('· 远端最新：')}${target}\n`);

  if (check.verdict.kind === 'source') {
    out('\n' + sourceUpgradeGuidance(localVersion) + '\n');
    return 0;
  }
  if (check.verdict.kind === 'up-to-date') {
    out(green(`✓ 已是最新（${localVersion} ≥ ${target}）\n`));
    return 0;
  }

  // 包管理器甄别（冷读 m1 余款）：pnpm/yarn 全局装 → 原管理器指引不代执行
  const manager = detectPackageManager(realPath());
  if (manager !== 'npm') {
    out('\n' + foreignManagerGuidance(manager) + '\n');
    return 0;
  }
  // npm 形态自升级：spawn npm i -g（stdio 继承——npm 自带进度即显示面）。
  // target 来自 registry 响应（不可信输入）——进 spawn 参数前过 semver 形状
  // 白名单（win32 shell:true 形态下插值即命令注入面，白名单钉死）
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(target)) {
    err(red(`✗ 远端版本号形状非法（${target}）——拒绝执行，请人工核对 registry\n`));
    return 1;
  }
  out(`${dim('· 升级到')} ${bold(target)} ${dim('（npm i -g berryagent@' + target + '）…')}\n`);
  const code = await spawnNpm(target);
  if (code !== 0) {
    err(red(`✗ 升级失败（npm 退出码 ${code}）——包未变动，可重试\n`));
    return 1;
  }
  out(green(`✓ 升级完成：${localVersion} → ${target}\n`));
  out(
    dim('运行中的进程仍持旧版（升级不热替换内存）——重启 berry / daemon 后生效：\n') +
      dim('  · TUI：退出后重新 `berry`\n') +
      dim('  · daemon：`berry daemon stop && berry daemon start`\n'),
  );
  return 0;
}

/** 入口文件 real path（argv[1] 解析；异常兜底原值——形态判定降级为 source 档指引）。/upgrade TUI 薄壳复用（commands.ts） */
export function entryRealPath(): string {
  try {
    return realpathSync(process.argv[1] ?? '');
  } catch {
    return process.argv[1] ?? '';
  }
}

import { CODENAME, VERSION } from './version.js';

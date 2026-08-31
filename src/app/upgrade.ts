/**
 * L5 app — `berry upgrade` 第六命令（技术栈篇 §8.5，第五十一批「升级与上手基建」）。
 *
 * 纯函数核心 + 编排器分离：dist-tags 解析 / semver 比对 / 装机形态判定 /
 * 指引文案全为纯函数（可测）；网络（node:fetch 零新依赖）与 spawn 只活在
 * upgradeMain 编排器。
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

/** dist-tags 查询端点（轻量端点——不拉全量 packument） */
const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/berryagent/dist-tags';

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
 * npm 形态的包管理器甄别（冷读 m1 余款）：pnpm/yarn 全局装路径同样含
 * node_modules（会误入 npm 分支）——spawn `npm i -g` 会装出第二份、原装不
 * 升级。检出 `.pnpm` / `pnpm-global` / `yarn` 路径段时给原管理器指引。
 */
export function detectPackageManager(entryRealPath: string): 'npm' | 'pnpm' | 'yarn' {
  const segs = entryRealPath.split(/[\\/]/);
  // `.pnpm`（虚拟仓）/ `.pnpm-*`（home 变体）/ `pnpm-global`（无点形）三形并收
  if (segs.some((x) => x === '.pnpm' || x.startsWith('.pnpm-') || x.startsWith('pnpm-global'))) {
    return 'pnpm';
  }
  if (segs.includes('yarn')) return 'yarn';
  return 'npm';
}

/** 非 npm 包管理器的升级指引（原管理器一条命令——本命令不代执行） */
export function foreignManagerGuidance(manager: 'pnpm' | 'yarn'): string {
  const cmd = manager === 'pnpm' ? 'pnpm add -g berryagent' : 'yarn global add berryagent';
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

/** 查询 registry dist-tags（node:fetch + 超时；404 = 未发布，与网络错分立） */
export async function fetchDistTags(): Promise<DistTagsResult> {
  try {
    const res = await fetch(DIST_TAGS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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

export async function runUpgradeCheck(localVersion: string, entryRealPath: string): Promise<UpgradeCheck> {
  const form = detectInstallForm(entryRealPath);
  const remote = await fetchDistTags();
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
 * `berry upgrade` 主流程（CLI 编排器）：
 * 检查 → 三态分派（npm 自升级 / 源码指引 / 未发布告知）→ 重启提示。
 * @returns 进程退出码（0 成功/已最新/指引类态；1 升级失败或网络检查失败——用法错由 CLI 层退 2）
 */
export async function upgradeMain(): Promise<number> {
  const localVersion = VERSION;
  process.stdout.write(`${bold(`Berry ${localVersion}（${CODENAME}）`)} ${dim('— 升级维护动词（berry upgrade）')}\n`);

  const form = detectInstallForm(entryRealPath());
  process.stdout.write(`${dim('· 装机形态：')}${form === 'npm' ? 'npm 全局' : '源码'}\n`);

  process.stdout.write(`${dim('· 检查更新（registry dist-tags）…')}\n`);
  const check = await runUpgradeCheck(localVersion, entryRealPath());

  if (check.verdict.kind === 'unpublished') {
    process.stdout.write(
      red('· 未发布：') + 'berryagent 尚未发布到 npm\n\n' + unpublishedGuidance(localVersion) + '\n',
    );
    return 0;
  }
  if (check.verdict.kind === 'network') {
    const netMessage = check.remote.status === 'network' ? check.remote.message : '未知网络错误';
    process.stdout.write(red(`· 网络检查失败：${netMessage}\n`));
    process.stdout.write(dim('（registry 不可达不影响使用；稍后重试或走源码升级路）\n'));
    return 1;
  }
  const target = check.verdict.target;
  process.stdout.write(`${dim('· 远端最新：')}${target}\n`);

  if (check.verdict.kind === 'source') {
    process.stdout.write('\n' + sourceUpgradeGuidance(localVersion) + '\n');
    return 0;
  }
  if (check.verdict.kind === 'up-to-date') {
    process.stdout.write(green(`✓ 已是最新（${localVersion} ≥ ${target}）\n`));
    return 0;
  }

  // 包管理器甄别（冷读 m1 余款）：pnpm/yarn 全局装 → 原管理器指引不代执行
  const manager = detectPackageManager(entryRealPath());
  if (manager !== 'npm') {
    process.stdout.write('\n' + foreignManagerGuidance(manager) + '\n');
    return 0;
  }
  // npm 形态自升级：spawn npm i -g（stdio 继承——npm 自带进度即显示面）。
  // target 来自 registry 响应（不可信输入）——进 spawn 参数前过 semver 形状
  // 白名单（win32 shell:true 形态下插值即命令注入面，白名单钉死）
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(target)) {
    process.stderr.write(red(`✗ 远端版本号形状非法（${target}）——拒绝执行，请人工核对 registry\n`));
    return 1;
  }
  process.stdout.write(`${dim('· 升级到')} ${bold(target)} ${dim('（npm i -g berryagent@' + target + '）…')}\n`);
  const code = await new Promise<number>((resolve) => {
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
  if (code !== 0) {
    process.stderr.write(red(`✗ 升级失败（npm 退出码 ${code}）——包未变动，可重试\n`));
    return 1;
  }
  process.stdout.write(green(`✓ 升级完成：${localVersion} → ${target}\n`));
  process.stdout.write(
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

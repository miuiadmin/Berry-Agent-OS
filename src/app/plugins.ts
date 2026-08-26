/**
 * L5 app — 插件管理服务（ctx.plugins，契约篇 §1.5 表尾落码 2026-08-23 M2 /reload 纵切）。
 *
 * 有状态单例：list/install/toggle/update 同一实例，boot 与 /reload 经 applyLoad
 * 就地更新装载状态——provide 一次恒定（§1.3 服务集不变式保持）。
 *
 * install 三源分发（§6.1）：
 * - npm（裸 spec）：装 `<数据目录>/plugins/node_modules/` 子树（--legacy-peer-deps
 *   --omit=peer 防 peer 冲突），overlay 行 plugin 写裸包名（resolvePluginEntry 走子树解析）；
 * - git（git@… / https://….git）：clone 到 `<数据目录>/plugins/git/<host>/<首路径段>/<repo 名>`
 *   分层防撞名，ref 经 opts 锁定；源 URL/ref 记入 sources.json（update 重克隆的依据）；
 *   overlay 行 plugin 写 clone 目录绝对路径；
 * - local（./ ../ 绝对路径）：直引不拷贝，overlay 行 plugin 写绝对路径——改动 + /reload 即见。
 *
 * install 只对账写回、不自动热应用——热应用 = 调用方 /reload（对账与组合正交，§1.5 表尾）。
 * 装机子进程失败统一 PLUGIN_INSTALL_FAILED（message 载命令与输出尾行）。
 * dry-run/rollback seam 保留未实现（§1.5 表注记）。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { writeAtomicFile } from '../persist/index.js';
import { AppError, COMPOSITION_ROW_INVALID, PLUGIN_INSTALL_FAILED } from '../contracts/errors.js';
import type { PluginLoadResult, PluginPlanRow } from '../contracts/plugin.js';
import {
  isPathReference,
  loadOverlayRows,
  toggleOverlayRow,
  upsertOverlayPluginRef,
  type CompositionReport,
  type PluginStatusRow,
} from './composition.js';

/** 插件源三分类（§6.1 三源分发） */
export type PluginSource = 'npm' | 'git' | 'local';

/** 装机子进程执行器（可注入——测试替身免真跑 npm/git；真面 spawn 子进程） */
export type InstallRunner = (command: string, args: readonly string[], opts: { cwd: string }) => Promise<void>;

/**
 * 插件管理服务（ctx.plugins）——组合根 provide 'plugins' 的实现。
 * 装配枚举唯一事实源 = 组合树（禁扫 node_modules/命名正则推断已装扩展，§1.5）。
 */
export interface PluginsService {
  /** 装载状态清单（组合树行序；装载前视角的行 = planned 兜底） */
  list(): readonly PluginStatusRow[];
  /**
   * 装机（三源分发按 ref 形态自动判定）+ overlay 对账写回。不自动热应用——
   * 热应用 = 调用方 /reload（TUI 薄壳命令链 install→reload）。
   * @param ref npm spec / git URL / 本地路径三形之一
   * @param opts gitRef 锁定分支或 tag（仅 git 源生效）
   */
  install(ref: string, opts?: { gitRef?: string }): Promise<InstallReport>;
  /** 禁用状态翻转（overlay 行 disabled 置 true / 删键）。@returns 翻转后禁用状态 */
  toggle(id: string): boolean;
  /** 按源分派更新：npm 重装同名 / git 删目录按原 ref 重克隆 / local no-op（改动即见） */
  update(id: string): Promise<UpdateReport>;
  /** boot 与 /reload 后装配方回灌最新装载结果（同实例就地更新——服务集恒定） */
  applyLoad(composition: CompositionReport, load: PluginLoadResult): void;
}

/** install 结果（TUI 直显的人读报告） */
export interface InstallReport {
  /** 本次写进 overlay 的行 id（npm=包名 / git=repo 名 / local=目录或文件名） */
  readonly id: string;
  readonly source: PluginSource;
  /** 写进 overlay 行的 plugin 引用（npm 裸包名 / local+git 绝对路径） */
  readonly pluginRef: string;
  /** 一句话结果（人读；TUI 打印后提示 /reload 生效） */
  readonly message: string;
}

/** update 结果（按源分派的不同结局说明） */
export interface UpdateReport {
  readonly id: string;
  readonly source: PluginSource;
  readonly message: string;
}

/**
 * 建插件管理服务实例。
 * @param opts.dataDir 数据目录（overlay 与装机子树的根）
 * @param opts.runner 装机子进程执行器（缺省真 spawn；测试注入替身）
 */
export function createPluginsService(opts: { dataDir: string; runner?: InstallRunner }): PluginsService {
  const dataDir = opts.dataDir;
  const runner = opts.runner ?? spawnRunner;
  /** 装载状态（applyLoad 回灌；boot 前空表） */
  let byId = new Map<string, PluginStatusRow>();
  let plan: readonly PluginPlanRow[] = [];

  return {
    applyLoad(composition, load) {
      const next = new Map<string, PluginStatusRow>();
      for (const item of load.activated) next.set(item.id, { id: item.id, status: 'activated', name: item.name });
      for (const item of load.failed)
        next.set(item.id, { id: item.id, status: 'failed', code: item.code, message: item.message });
      for (const item of load.skipped) next.set(item.id, { id: item.id, status: 'skipped', reason: item.reason });
      byId = next; // 原地替换引用——闭包内外一致（provide 一次恒定的实例）
      plan = composition.plan;
    },

    list() {
      return plan.map((row) => byId.get(row.id) ?? { id: row.id, status: 'planned' as const });
    },

    async install(ref, installOpts) {
      const source = classifyRef(ref);
      if (source === 'npm') {
        const name = npmPackageName(ref);
        await runInstallStep(runner, dataDir, 'npm', [
          'install',
          '--prefix',
          join(dataDir, 'plugins'),
          '--legacy-peer-deps',
          '--omit=peer',
          ref,
        ]);
        upsertOverlayPluginRef(dataDir, name, name);
        return { id: name, source, pluginRef: name, message: `npm 源已装入 plugins/node_modules 子树：${name}` };
      }
      if (source === 'git') {
        const parsed = parseGitUrl(ref);
        const absDir = join(dataDir, 'plugins', 'git', parsed.relDir);
        // 纵深防线（P33 第二道）：段净化之后仍强制校验归一路径在 git 子树内——
        // rmSync 前的最后一道闸，未来 parse 漂移也不可穿越出装机子树
        assertInsideGitRoot(dataDir, absDir);
        // 幂等：先清 clone 目录（重装/半装残骸都不留），父目录补齐（git 只建末级）
        rmSync(absDir, { recursive: true, force: true });
        mkdirSync(dirname(absDir), { recursive: true });
        await runInstallStep(runner, dataDir, 'git', [
          'clone',
          ...(installOpts?.gitRef !== undefined ? ['--branch', installOpts.gitRef] : []),
          '--',
          ref,
          absDir,
        ]);
        saveGitSource(dataDir, parsed.relDir, {
          url: ref,
          ...(installOpts?.gitRef !== undefined ? { ref: installOpts.gitRef } : {}),
        });
        upsertOverlayPluginRef(dataDir, parsed.repo, absDir);
        return {
          id: parsed.repo,
          source,
          pluginRef: absDir,
          message: `git 源已 clone：${ref} → ${absDir}`,
        };
      }
      // local：路径直引不拷贝；绝对化后写 overlay（cwd 无关——跨目录启动解析仍成立）
      const absRef = resolve(process.cwd(), ref);
      if (!existsSync(absRef)) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `install：local 引用路径不存在：${ref}（解析为 ${absRef}）——先确认路径再装`,
        );
      }
      const id = basename(parse(absRef).name); // 目录名 / 文件名去扩展名
      upsertOverlayPluginRef(dataDir, id, absRef);
      return { id, source, pluginRef: absRef, message: `local 源直引登记：${absRef}（改动 + /reload 即见）` };
    },

    toggle(id) {
      return toggleOverlayRow(dataDir, id); // 持久化半边在组合树模块（翻转语义见其 JSDoc）
    },

    async update(id) {
      const ref = overlayPluginRef(dataDir, id);
      if (ref === undefined) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `update：未知行 id「${id}」（overlay 与官方默认层皆无此行——清单以组合树为准）`,
        );
      }
      const gitRoot = join(dataDir, 'plugins', 'git');
      if (ref.startsWith(`${gitRoot}/`)) {
        // 纵深防线（P33 第二道）：overlay 手改/污染的 plugin 引用同受越界校验——
        // `gitRoot/../escape` 形态字面 startsWith 命中但归一后已在子树外
        assertInsideGitRoot(dataDir, ref);
        // git 源：删目录按原 ref 重克隆（sources.json 是 ref 的唯一存放处）
        const relDir = ref.slice(gitRoot.length + 1);
        const record = loadGitSources(dataDir)[relDir];
        if (!record) {
          throw new AppError(
            PLUGIN_INSTALL_FAILED,
            `update：${relDir} 无源记录（sources.json 缺项——手放目录请删除后重新 install）`,
          );
        }
        rmSync(ref, { recursive: true, force: true });
        await runInstallStep(runner, dataDir, 'git', [
          'clone',
          ...(record.ref !== undefined ? ['--branch', record.ref] : []),
          '--',
          record.url,
          ref,
        ]);
        return { id, source: 'git', message: `git 源已按原 ref 重克隆：${record.url}` };
      }
      if (isPathReference(ref)) {
        // local 源：直引不拷贝——改动即见，update 天生 no-op
        return { id, source: 'local', message: 'local 源无需 update——改动 + /reload 即见' };
      }
      // npm 源：重装同名（重新解析版本）
      await runInstallStep(runner, dataDir, 'npm', [
        'install',
        '--prefix',
        join(dataDir, 'plugins'),
        '--legacy-peer-deps',
        '--omit=peer',
        ref,
      ]);
      return { id, source: 'npm', message: `npm 源已重装：${ref}` };
    },
  };
}

/* ---------------- 三源分类与 ref 解析 ---------------- */

/** 三源分类（§6.1）：git@… 或 https://….git = git；./ ../ 绝对路径 = local；其余 = npm */
function classifyRef(ref: string): PluginSource {
  if (ref.startsWith('git@')) return 'git';
  if (/^https?:\/\/.+\/(.+)$/.test(ref) && ref.endsWith('.git')) return 'git';
  if (isPathReference(ref)) return 'local';
  return 'npm';
}

/** npm spec → 包名（`pkg@^2`→pkg / `@scope/pkg@1.2`→@scope/pkg；npm: 别名前缀剥掉） */
function npmPackageName(spec: string): string {
  const bare = spec.startsWith('npm:') ? spec.slice(4) : spec;
  if (bare.startsWith('@')) {
    const parts = bare.split('/'); // ['@scope', 'pkg@1.2', ...]
    return parts.length >= 2 ? `@${parts[0]!.slice(1)}/${parts[1]!.split('@')[0]!}` : bare;
  }
  return bare.split('@')[0]!;
}

/** git URL 拆解产物：clone 目录分层（host/首路径段/repo 名，防撞名） */
interface GitUrlParts {
  /** repo 名（.git 剥离）——overlay 行 id */
  readonly repo: string;
  /** clone 相对目录：`<host>/<首路径段>/<repo>` */
  readonly relDir: string;
}

/** 拆 git URL（git@host:path / https://host/path 两形）→ repo 名 + 分层目录 */
function parseGitUrl(url: string): GitUrlParts {
  let host: string | undefined;
  let path: string | undefined;
  if (url.startsWith('git@')) {
    const at = url.indexOf(':'); // git@github.com:foo/bar.git
    host = at > 0 ? url.slice(0, at).slice('git@'.length) : undefined;
    path = at > 0 ? url.slice(at + 1) : undefined;
  } else {
    try {
      const parsed = new URL(url);
      host = parsed.host;
      path = parsed.pathname.slice(1);
    } catch {
      host = undefined; // 非 URL——留空由下方兜底报错
    }
  }
  const segments = (path ?? '').split('/').filter((seg) => seg.length > 0);
  // 段净化（P33 第一道，隔离案一第一刀 #15）：host 与每个路径段都必须是
  // 「纯文件名形态」——字符集白名单 [A-Za-z0-9._-] 且禁 `.`/`..` 相对段。
  // 修复前 `git@..:../..` 可拼出 relDir `../../..`，install 的幂等 rmSync
  // 会整删数据目录父级（全清单唯一「今日即炸」数据破坏活漏洞）；教训泛化：
  // 防了注入（数组参数 + `--` 分隔）≠ 防了穿越（`..` 段的路径语义面）
  if (!host || !isSafePathSegment(host) || segments.length < 2 || segments.some((seg) => !isSafePathSegment(seg))) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `install：git URL 形态无法拆解或含不安全段：${url}（期望 git@host:owner/repo.git 或 https://host/owner/repo.git；各段仅限字母/数字/._- 且禁 . 与 ..）`,
    );
  }
  const repo = segments[segments.length - 1]!.replace(/\.git$/, '');
  const first = segments[0]!;
  return { repo, relDir: `${host}/${first}/${repo}` };
}

/** git URL 段白名单字符集（防 `..`/路径分隔符/特殊字符构造穿越——B3 §10-4） */
const GIT_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** 单段安全判定：字符集合法且非 `.`/`..`（相对段 join 后会穿越出目标子树） */
function isSafePathSegment(segment: string): boolean {
  return GIT_SEGMENT_RE.test(segment) && segment !== '.' && segment !== '..';
}

/**
 * 越界防线（P33 第二道，纵深防御）：clone 目录经 resolve 归一后必须严格落在
 * `<数据目录>/plugins/git/` 子树**内**（子树根本身也不许——那是 sources.json 所在地）。
 * 段净化（第一道）拦 URL 形态；本防线拦「归一后越界」的一切路径来源——
 * install 的 parse 产物与 update 的 overlay 引用（手改/污染面）同受校验。
 */
function assertInsideGitRoot(dataDir: string, dir: string): void {
  const root = resolve(join(dataDir, 'plugins', 'git'));
  const target = resolve(dir);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `install/update：clone 目录越界（${dir} 归一为 ${target}，须在 ${root} 子树内）——路径穿越拒绝`,
    );
  }
}

/* ---------------- git 源登记（sources.json——update 重克隆的 ref 依据） ---------------- */

/** 一条 git 源记录：URL + 装机时锁定的 ref（可缺省 = 默认分支） */
interface GitSourceRecord {
  url: string;
  ref?: string;
}

/** sources.json 路径（<数据目录>/plugins/git/sources.json；relDir → 源记录） */
function gitSourcesPath(dataDir: string): string {
  return join(dataDir, 'plugins', 'git', 'sources.json');
}

/** 读 git 源登记表（文件缺 = 空表；解析失败响亮抛——对账依据损坏不静默当空表） */
function loadGitSources(dataDir: string): Record<string, GitSourceRecord> {
  const path = gitSourcesPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, GitSourceRecord>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (err) {
    throw new AppError(
      PLUGIN_INSTALL_FAILED,
      `git 源登记表损坏：${path}（${err instanceof Error ? err.message : String(err)}）——手工修复或删除后重装`,
    );
  }
}

/** 写一条 git 源登记（键排序稳定序列化——人对 diff 友好） */
function saveGitSource(dataDir: string, relDir: string, record: GitSourceRecord): void {
  const all = loadGitSources(dataDir);
  all[relDir] = record;
  const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => (a < b ? -1 : 1)));
  mkdirSync(dirname(gitSourcesPath(dataDir)), { recursive: true });
  writeAtomicFile(gitSourcesPath(dataDir), `${JSON.stringify(sorted, null, 2)}\n`);
}

/* ---------------- 装机子进程执行 ---------------- */

/** 装机子进程硬顶（毫秒）——P32：npm/git 卡死不再永挂（缺省 5 分钟） */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** 单流输出滚动尾窗上限（字符计）——P32：装机输出无界积累的帽，保尾部为诊断 */
const INSTALL_OUTPUT_CAP = 1024 * 1024;

/**
 * 真装机执行器：spawn 子进程，非零退出抛错（含输出尾行——诊断直达）。
 * P32 两道护栏（隔离案一第一刀 #16）：① 超时硬顶——到点 SIGKILL 强杀
 * （'close' 随后到达统一收尾，不再永挂）；② stdout/stderr 各 1MiB 滚动
 * 尾窗——超帽从头部丢弃（失败尾行是诊断要点），截断发生即在错误消息标注。
 * @param opts.timeoutMs 超时覆盖（测试注入用；缺省 5 分钟）
 */
export function spawnRunner(
  command: string,
  args: readonly string[],
  opts: { cwd: string; timeoutMs?: number },
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    // 滚动尾窗累加器（truncated 标记截断是否发生过——消息头标注用）
    const stdout = { text: '', truncated: false };
    const stderr = { text: '', truncated: false };
    const appendCapped = (acc: { text: string; truncated: boolean }, chunk: Buffer): void => {
      acc.text += chunk.toString();
      if (acc.text.length > INSTALL_OUTPUT_CAP) {
        acc.text = acc.text.slice(-INSTALL_OUTPUT_CAP);
        acc.truncated = true;
      }
    };
    child.stdout.on('data', (chunk: Buffer) => appendCapped(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => appendCapped(stderr, chunk));
    // 超时硬顶：SIGKILL 后 'close' 到达走 timedOut 分支（清钟防泄漏）
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? INSTALL_TIMEOUT_MS);
    const clearTimer = (): void => clearTimeout(timer);
    // spawn 级失败（命令不存在等）与退出非零同路归一
    child.on('error', (err) => {
      clearTimer();
      reject(err);
    });
    child.on('close', (code) => {
      clearTimer();
      if (timedOut) {
        reject(new Error(`装机子进程超时（${opts.timeoutMs ?? INSTALL_TIMEOUT_MS}ms）已强杀：${command}`));
        return;
      }
      if (code === 0) {
        resolvePromise();
        return;
      }
      const source = stderr.text.trim() || stdout.text.trim();
      const head = source.length > 0 && (stderr.truncated || stdout.truncated) ? '[输出超限已截断，保尾部]\n' : '';
      const tail = source.split('\n').slice(-5).join('\n');
      const body = tail.length > 0 ? `\n${head}${tail}` : '';
      reject(new Error(`退出码 ${code}${body}`));
    });
  });
}

/** 单步装机执行 + 统一失败包装（PLUGIN_INSTALL_FAILED，message 载命令与原因） */
async function runInstallStep(
  runner: InstallRunner,
  cwd: string,
  command: string,
  args: readonly string[],
): Promise<void> {
  try {
    await runner(command, args, { cwd });
  } catch (err) {
    throw new AppError(
      PLUGIN_INSTALL_FAILED,
      `装机子进程失败：${command} ${args.join(' ')}\n${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** 读 overlay 行的 plugin 引用（update 分派用；行不在 overlay 返回 undefined） */
function overlayPluginRef(dataDir: string, id: string): string | undefined {
  // 经装载面同一拒绝式校验读回——只取该行引用字段
  return loadOverlayRows(dataDir).find((row) => row.id === id)?.plugin;
}

/**
 * L3 memory — 工作区 canonical 根推导（记忆篇 §3 project 键定义，第十四批 A 组）。
 *
 * project 归属键的哈希入参 = canonical 工作区根而非字面 cwd：同一 git 仓库的
 * 主目录、worktree、任意子目录必须产生同一 project 键——否则从 worktree 或
 * 子目录启动 berry 会「裂库」（同项目记忆写进两个互不相见的桶）。
 *
 * 推导规则（纯文件系统探测，不 spawn git、不读 GIT_* 宿主环境变量——契约篇
 * §1.2 配置总线禁令同向）：
 *   1. 从 cwd 向上找最近的 `.git`（含 cwd 自身）——覆盖子目录启动场景；
 *   2. `.git` 是目录 → 主仓库，根 = 该祖先目录；
 *   3. `.git` 是文件（worktree/submodule 的 gitdir 指针）→ 解析 `gitdir: <path>`
 *      → 读 `<gitdir>/commondir`（相对路径）→ 主仓库 git 目录 → 根 = 其父目录；
 *      submodule 的 modules gitdir 无 commondir → 独立成域（submodule 本就是
 *      独立仓库，独立记忆域语义自洽）；
 *   4. 一路无 `.git` → 回退字面 cwd（非 git 目录按目录字面归属）。
 *
 * 探测结果按 cwd 进程内缓存——ownerKeys 在简报/检索/工具读面高频求值，
 * 同路径不重复打 fs；仓库移动属极端场景，重启自愈（缓存不设失效）。
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** 探测缓存：cwd（已 resolve 规范化）→ canonical 根。进程级 Map，随进程存亡 */
const rootCache = new Map<string, string>();

/**
 * 推导 canonical 工作区根（project 键的哈希入参）。
 * @param cwd 启动时的工作目录（任意绝对/相对路径，内部先 resolve 规范化）
 * @returns canonical 根绝对路径（git 仓库根或回退的规范化 cwd）
 */
export function canonicalWorkspaceRoot(cwd: string): string {
  const start = resolve(cwd);
  const cached = rootCache.get(start);
  if (cached !== undefined) return cached;
  const root = findGitRoot(start) ?? start;
  rootCache.set(start, root);
  return root;
}

/**
 * 从 start 向上找最近 `.git`，返回该仓库的 canonical 根。
 * @returns 仓库根绝对路径；一路到文件系统根都没有 `.git` 时返回 undefined
 */
function findGitRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    const dotGit = join(dir, '.git');
    const st = statQuiet(dotGit);
    if (st?.isDirectory()) {
      // .git 目录 = 主仓库形态；保险再读 commondir（linked 布局罕见情形），无则根即本目录
      return viaCommonDir(dotGit) ?? dir;
    }
    if (st?.isFile()) {
      // .git 文件 = worktree/submodule 的 gitdir 指针（内容 `gitdir: <path>`）
      return rootFromGitdirFile(dir, dotGit);
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined; // 已到文件系统根——非 git 目录
    dir = parent;
  }
}

/**
 * 解析 `.git` 指针文件（worktree/submodule）：gitdir → commondir → 主仓库根。
 * 任何一步解析失败都安全回退（指针目录 / 字面目录）——canonical 化是优化不是正确性前提。
 * @param literalDir `.git` 文件所在目录（回退锚点）
 * @param dotGitFile `.git` 文件路径
 */
function rootFromGitdirFile(literalDir: string, dotGitFile: string): string {
  let gitdir: string | undefined;
  try {
    const content = readFileSync(dotGitFile, 'utf8');
    // gitdir 行格式固定 `gitdir: <path>`（可能相对 .git 文件所在目录）
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (match?.[1]) gitdir = resolve(literalDir, match[1].trim());
  } catch {
    gitdir = undefined; // 读取失败走回退
  }
  if (!gitdir) return literalDir;
  // worktree 的 gitdir（<main>/.git/worktrees/<name>）内有 commondir 文件（内容如 `../..`）
  // → 主仓库 git 目录 → 其父目录即主仓库根；submodule 的 modules gitdir 无此文件 → 独立成域
  return viaCommonDir(gitdir) ?? literalDir;
}

/**
 * 读 git 目录内的 commondir 文件（存在则归并到主仓库根）。
 * @param gitDir git 目录（`.git` 目录形态，或 `.git` 指针文件解析出的 gitdir）
 * @returns 主仓库根绝对路径；无 commondir（主仓库自身/submodule）返回 undefined 由调用方回退
 */
function viaCommonDir(gitDir: string): string | undefined {
  try {
    const content = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    if (content === '') return undefined;
    // commondir 内容是相对 gitDir 的路径（worktree 场景为 `../..` → 主仓库 .git）
    const commonDir = resolve(gitDir, content);
    // commondir 指向自身（已是最外层）时按无归并处理，防 dirname 多剥一层
    if (commonDir === gitDir) return undefined;
    return dirname(commonDir);
  } catch {
    return undefined; // 无 commondir 文件——主仓库自身，调用方回退
  }
}

/** 静默 stat（路径不存在 / 无权限等一律 undefined——探测不是错误面） */
function statQuiet(path: string): { isDirectory(): boolean; isFile(): boolean } | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

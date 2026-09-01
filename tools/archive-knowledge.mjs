#!/usr/bin/env node
/**
 * 知识域定期归档机器（2026-08-31 公开回调批配套，AGENTS.md 仓库管理节常规动作）：
 * 把 gitignored 的 设计文档/ 与 真实测试题库/ 打成快照提交到 private-archive 分支，
 * 并推送到旧私有仓（remote legacy）——知识域在本地盘外的唯一异地备份。
 *
 * 安全模型：
 * - 全程在 os.tmpdir() 下的临时 git worktree 里操作，主工作区零接触——
 *   绝不在主工作区切换分支（checkout 会按目标分支增删文件，殃及并发兄弟 session）；
 * - private-archive 树基 = b395c44（861c85a 代码 + 知识域全量），此后每次只滚
 *   知识域两目录的差异；代码以 origin 为准不归档（origin 历史本就是代码正身）；
 * - 无差异且远端已同步才零提交零推送（幂等，可放心重复跑）；上次 push 失败留的
 *   悬置笔重跑时自动补推收口——幂等 ≠ 漏推（遗漏大扫 20260901-c #9）；
 * - 推送固定 HTTP/1.1（本机到 GitHub 的 HTTP2 framing 层错，与 AGENTS 仓库管理节同源）；
 * - 归档提交走 --no-verify：跳过产品码四门禁钩子（纯文档快照，门禁不消费此面）。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 知识域两目录（与 AGENTS.md 仓库管理节同源——改一处须同步另一处） */
const DOCS_DIRS = ['设计文档', '真实测试题库'];
/** 旧私有仓 remote 名（全量归档位，见 AGENTS.md 仓库管理节） */
const REMOTE = 'legacy';
/** 归档分支名（本地与 legacy 同名同链；基线 b395c44） */
const BRANCH = 'private-archive';

/** 同步跑 git 并返回 stdout（trim 后）；失败让异常直接炸出（fail-loud，不静默降级） */
function git(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...opts,
  }).trim();
}

/** 前置断言：remote 与归档分支必须已存在——缺了就指路退出，绝不自动建（建错基线比失败更糟） */
function preflight() {
  try {
    git(['remote', 'get-url', REMOTE]);
  } catch {
    console.error(`缺 remote "${REMOTE}"——先 git remote add ${REMOTE} <旧私有仓 URL>（见 AGENTS.md 仓库管理节）`);
    process.exit(1);
  }
  try {
    git(['rev-parse', '--verify', `refs/heads/${BRANCH}`]);
  } catch {
    console.error(
      `缺本地分支 "${BRANCH}"——从 legacy 拉：git fetch ${REMOTE} && git branch ${BRANCH} ${REMOTE}/${BRANCH}`,
    );
    process.exit(1);
  }
}

// 0) 前置：remote 与归档分支在场
preflight();

// 1) 临时 worktree 检出归档分支（隔离目录，不动主工作区）
const worktreeDir = mkdtempSync(join(tmpdir(), 'knowledge-archive-'));
try {
  git(['worktree', 'add', '--quiet', worktreeDir, BRANCH]);

  // 2) 镜像拷贝知识域进归档树（--delete 同步删除侧；排除 macOS 目录垃圾）
  for (const dir of DOCS_DIRS) {
    execFileSync('rsync', ['-a', '--delete', '--exclude', '.DS_Store', `${dir}/`, join(worktreeDir, dir, '/')], {
      stdio: 'inherit',
    });
  }

  // 3) 提交知识域差异（-f 防归档分支 .gitignore 语义漂移；status 空则幂等收场）
  git(['-C', worktreeDir, 'add', '-f', '--', ...DOCS_DIRS]);
  const dirty = git(['-C', worktreeDir, 'status', '--porcelain', '--', ...DOCS_DIRS]);
  if (!dirty) {
    // 悬置笔对账（遗漏大扫 20260901-c #9）：dirty 判定基准是已含悬置笔的 HEAD——
    // 上次 commit 已落本地分支但 push 失败后重跑会误入此分支，远端备份缺口被
    // 「幂等」文案静默吞掉。对账用远端追踪 ref（rev-list 数本地领先笔数）：
    // 单写者模型下追踪 ref 只被本机的成功 push 推进——不 fetch 即判，无变化路径
    // 保持离线友好；追踪 ref 陈旧只会多推（无害空推）不会漏推。
    let ahead = -1; // -1 = 追踪 ref 缺席（未知态）——按需对齐，补推是安全方向
    try {
      ahead = Number(git(['rev-list', '--count', `${REMOTE}/${BRANCH}..${BRANCH}`]));
    } catch {
      /* 追踪 ref 不在（从未 fetch/push 过的克隆形态）——走补推对齐 */
    }
    if (ahead !== 0) {
      git(['-C', worktreeDir, '-c', 'http.version=HTTP/1.1', 'push', REMOTE, BRANCH]);
      console.log(
        ahead > 0
          ? `知识域无变化，但本地领先远端 ${ahead} 笔——补推收口（上次推送曾失败）`
          : '知识域无变化，远端追踪 ref 缺席——补推对齐',
      );
    } else {
      console.log('知识域无变化——零提交零推送（幂等）');
    }
  } else {
    const date = new Date().toISOString().slice(0, 10);
    git(['-C', worktreeDir, 'commit', '--no-verify', '-m', `archive(知识域): 定期归档 ${date}`]);
    // 4) 推 legacy（HTTP/1.1 固定语义）
    git(['-C', worktreeDir, '-c', 'http.version=HTTP/1.1', 'push', REMOTE, BRANCH]);
    const tip = git(['rev-parse', '--short', BRANCH]);
    console.log(`已归档并推送 ${BRANCH} → ${REMOTE}（${date}，tip ${tip}）`);
  }
} finally {
  // 5) 无论成败拆 worktree（--force 容忍未提交残留；tmp 目录兜底再删一次）
  try {
    git(['worktree', 'remove', '--force', worktreeDir]);
  } catch {
    /* 拆不掉也不影响分支与远端——tmp 目录由下行兜底清除 */
  }
  rmSync(worktreeDir, { recursive: true, force: true });
}

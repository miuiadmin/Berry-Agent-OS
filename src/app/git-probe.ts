/**
 * L5 app — git 探测闭包（第六十一批「git Output 锚」宿主侧件）。
 *
 * execFile 只读三探，供 checkpoint 件 git/range 锚经组合根注入消费（browser
 * spawn 闭包同款纪律——checkpoint 模块不见 child_process）。git 缺席（ENOENT）
 * 或非 git 仓（exit 128 / 无 HEAD）= undefined 诚实缺席，调用侧整锚 no-op。
 */

import { execFile } from 'node:child_process';
import type { GitProbeDelta, GitProbeFace, GitProbeState } from '../checkpoint/index.js';

/** 单探超时（毫秒）——探测是观察面不是关键路径，快速失败好过悬挂 run 结算 */
const PROBE_TIMEOUT_MS = 5_000;

/** execFile promise 化（非零退出按异常处理——调用侧 undefined 兜底） */
function run(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err === null) resolve(stdout);
      else reject(err);
    });
  });
}

/** 构造 git 探测闭包（state + delta 两探面） */
export function createGitProbe(): GitProbeFace {
  return {
    /** 单时点状态：head 短哈希 + 脏文件计数（porcelain 行数——含未跟踪） */
    state: async (cwd): Promise<GitProbeState | undefined> => {
      try {
        const [head, status] = await Promise.all([
          run(cwd, ['rev-parse', '--short=12', 'HEAD']),
          run(cwd, ['status', '--porcelain']),
        ]);
        const headTrim = head.trim();
        if (headTrim === '') return undefined; // 无 HEAD（空仓未首提）——免锚
        return { head: headTrim, dirtyCount: status.split('\n').filter((l) => l !== '').length };
      } catch {
        return undefined; // 非 git 仓（128）/ git 缺席（ENOENT）——诚实缺席
      }
    },
    /** 区间增量：commit 数 + 变更文件清单（rev-list 计数 + diff --name-only） */
    delta: async (cwd, before, after): Promise<GitProbeDelta | undefined> => {
      try {
        const [count, files] = await Promise.all([
          run(cwd, ['rev-list', '--count', `${before}..${after}`]),
          run(cwd, ['diff', '--name-only', before, after]),
        ]);
        return {
          commits: Number(count.trim()) || 0,
          files: files.split('\n').filter((l) => l !== ''),
        };
      } catch {
        return undefined; // 区间查询失败（ref 被回收等）——事件照落、增量为空
      }
    },
  };
}

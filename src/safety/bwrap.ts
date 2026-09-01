/**
 * L3 safety — Linux bwrap（bubblewrap）后端（骨架篇 §7.2 顺序 ②）。
 *
 * 形态：拼 mount 参数。基础面 --ro-bind / /（全系统只读视图）+ 必要的
 * 虚拟设备挂载；逐根追加 --bind（真实读写）——/tmp 恒 tmpfs（临时面不留痕）。
 */

import { spawnSync } from 'node:child_process';
import type { SandboxBackend } from './types.js';
import { resolvePolicyRoots, type SandboxPolicy } from './sandbox.js';

/** bwrap argv 前缀（不含策略差异）：全系统只读 + 虚拟 /dev /proc + 隔离 PID 命名空间。
 *  /tmp tmpfs 恒前置为第一条挂载：bwrap 按参数序建挂载，若 tmpfs /tmp 出现在
 *  某 /tmp 子路径根的 bind 之后，会整树遮蔽该 bind（实测 bwrap 0.8：bind 先、
 *  tmpfs 后 → 挂载点不可见；tmpfs 先、bind 后 → bwrap 在 tmpfs 上自动造出
 *  dest 挂载点，根正确露出——刀四 CI 首跑红根因④，e2e server 脚本在
 *  /tmp/mcp-e2e-* 下被空 tmpfs 吞即此形）。 */
function bwrapBaseArgs(): string[] {
  return [
    '--tmpfs',
    '/tmp',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--unshare-pid',
    '--die-with-parent',
  ];
}

/**
 * 按策略生成 bwrap 参数前缀（纯函数）。两档统一消费 resolvePolicyRoots——
 * 缺省按档位推导（read-only 空根、workspace-write 工作区根族），**writableRoots
 * 显式覆盖在两档同等生效**（字段契约本义；e1 宿主 read-only 档携数据目录刚需根
 * 即走此路——与 seatbelt profile 同日统一）。不变式：/tmp 恒 tmpfs（临时面
 * 「能用不留痕」）由 base 前缀承接；根恰为 /tmp 时跳过重复挂载，/tmp 子路径根
 * 在 tmpfs 之上 bind 露出（宿主可写映射，见 base 前缀注）。
 */
export function bwrapArgs(policy: SandboxPolicy): string[] {
  const args = [...bwrapBaseArgs()];
  for (const root of resolvePolicyRoots(policy)) {
    // 可写根与 fs fence 同源；/tmp 已由 base tmpfs 覆盖，其余根真实 bind
    if (root !== '/tmp') args.push('--bind', root, root);
  }
  return args;
}

/**
 * 组装 Linux bwrap 后端。
 * 后端差异数据化下发：
 * - 策略拒绝 → stderr 含 "read-only file system"（只读 bind 上的写标准 errno 文案）；
 * - runner 自身失败（bwrap 未装/参数错/权限不够）→ stderr 前缀 "bwrap: "。
 */
export function createBwrapBackend(): SandboxBackend {
  return {
    id: 'bwrap',
    enforcement: 'full',
    denialSignatures: ['read-only file system'],
    runnerFailureRules: [{ fatalSignatures: ['bwrap: '] }],
    wrap(argv, policy) {
      return ['bwrap', ...bwrapArgs(policy), '--', ...argv];
    },
    probe(timeoutMs) {
      // 功能性探测：真跑一次 read-only 包装的 /bin/true——status 0 才算后端可用
      const confined = ['bwrap', ...bwrapArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', '/bin/true'];
      const result = spawnSync(confined[0]!, confined.slice(1), { timeout: timeoutMs });
      return result.status === 0;
    },
  };
}

/**
 * L3 safety — macOS Seatbelt 后端（骨架篇 §7.2 顺序 ①，首发）。
 *
 * 形态：拼 SBPL profile 字符串，argv = ['sandbox-exec','-p',profile,'--',...argv]。
 * 纯函数生成 profile（可测）；probe 用功能性探测（真跑一次 read-only 包装）。
 */

import { spawnSync } from 'node:child_process';
import type { SandboxBackend } from './types.js';
import { resolvePolicyRoots, type SandboxPolicy } from './sandbox.js';

/** SBPL 字符串字面量转义（SBPL 语法内 " 与 \ 需反斜杠转义） */
function sbplString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** read-only 档 SBPL：全默认放行 + 拒写 + /dev/null 例外（大量 CLI 静默写 /dev/null） */
export function seatbeltReadOnlyProfile(): string {
  return ['(version 1)', '(allow default)', '(deny file-write*)', '(allow file-write* (literal "/dev/null"))'].join(
    '\n',
  );
}

/** workspace-write 档 SBPL：read-only 基础上逐根追加 subpath 放行 */
export function seatbeltWorkspaceWriteProfile(policy: SandboxPolicy): string {
  // 可写根与 fs fence 同源（resolvePolicyRoots 缺省走 deriveWritableRoots）
  const allows = resolvePolicyRoots(policy)
    .map((root) => `(allow file-write* (subpath ${sbplString(root)}))`)
    .join('\n');
  return `${seatbeltReadOnlyProfile()}\n${allows}`;
}

/** 按策略生成 SBPL profile（两档各一形态；纯函数） */
export function seatbeltProfile(policy: SandboxPolicy): string {
  return policy.mode === 'workspace-write' ? seatbeltWorkspaceWriteProfile(policy) : seatbeltReadOnlyProfile();
}

/**
 * 组装 macOS Seatbelt 后端。
 * denialSignatures / runnerFailureRules 是数据化下发的后端差异：
 * - 策略拒绝 → stderr 含 "operation not permitted"（seatbelt 拒写标准句）；
 * - runner 自身失败（profile 语法错/内核拒绝加载）→ stderr 前缀 "sandbox-exec: "。
 */
export function createSeatbeltBackend(): SandboxBackend {
  return {
    id: 'seatbelt',
    enforcement: 'full',
    denialSignatures: ['operation not permitted'],
    runnerFailureRules: [{ fatalSignatures: ['sandbox-exec: '] }],
    wrap(argv, policy) {
      const profile = seatbeltProfile(policy);
      return ['sandbox-exec', '-p', profile, '--', ...argv];
    },
    probe(timeoutMs) {
      // 功能性探测：真跑一次 read-only 包装的 /usr/bin/true——status 0 才证明
      // 内核确实执行了 profile（版本检查会漏「有 syscall 但拒绝执行」的内核）
      const confined = ['sandbox-exec', '-p', seatbeltReadOnlyProfile(), '--', '/usr/bin/true'];
      const result = spawnSync(confined[0]!, confined.slice(1), { timeout: timeoutMs });
      return result.status === 0;
    },
  };
}

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

/** read-only 基座 SBPL：全默认放行 + 拒写 + /dev/null 例外（大量 CLI 静默写 /dev/null） */
export function seatbeltReadOnlyProfile(): string {
  return ['(version 1)', '(allow default)', '(deny file-write*)', '(allow file-write* (literal "/dev/null"))'].join(
    '\n',
  );
}

/** 按策略生成 SBPL profile（纯函数）。两档统一消费 resolvePolicyRoots——缺省按
 * 档位推导（read-only 空根 = 纯拒写、workspace-write 工作区根族），**writableRoots
 * 显式覆盖在两档同等生效**（字段契约本义；e1 宿主 read-only 档携数据目录刚需根
 * 即走此路——2026-08-27 真机冒烟实证原 mode 分支吃不到显式根，宿主建库被拒） */
export function seatbeltProfile(policy: SandboxPolicy): string {
  const allows = resolvePolicyRoots(policy)
    .map((root) => `(allow file-write* (subpath ${sbplString(root)}))`)
    .join('\n');
  return allows ? `${seatbeltReadOnlyProfile()}\n${allows}` : seatbeltReadOnlyProfile();
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

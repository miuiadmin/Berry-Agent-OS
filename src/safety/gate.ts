/**
 * L3 safety — 守门固定行（骨架篇 §8.1/§8.5：审动作不审回复；守门段由
 * 安全栈固定占据）。本行装在 tools_pre_execute 首位（prepend: true），
 * 承担 carve-out 细粒度判定 + 审批；粗粒度根 containment 在 tools/fs 的
 * fence（两层正交同源：roots 推导函数）。
 *
 * 分工（防重复拦截）：
 * - fence（tools/fs）：路径在可写根外 → FS_OUTSIDE_WRITABLE_ROOTS（防误操作护栏）；
 * - 本行：路径在根内但命中 carve-out 例外（.git / .env 类）→ 升权审批面
 *   ——allowed-once 放行本次，其余 block（denial marker + 升权 hint）。
 * - read-only 档：可写根为空，fence 已拒全量写，本行不再二次审批；
 *   danger-full-access：全放行，本行跳过。
 */

import { resolve as resolvePath } from 'node:path';
import { TOOL_PRE_EXECUTE_EVENT } from '../contracts/tools.js';
import type { GateAction, GateInput } from '../contracts/tools.js';
import type { Context, Disposer } from '../context/types.js';
import { parseApplyPatch } from '../tools/apply-patch.js';
import type { ApprovalService } from './approval.js';
import type { SandboxMode } from './types.js';
import { buildCarveOutTable, canonicalPath, deriveWritableRoots, type CarveOutEntry } from './roots.js';
import { resolveWritability } from './roots.js';
import { escalationHintMarker, sandboxDenialMarker } from './sandbox.js';

/** 内置默认 carve-out 条目（骨架篇 §7.3 例示：.git 转只读 + .env 类遮罩） */
export const DEFAULT_CARVE_OUT_ENTRIES: readonly CarveOutEntry[] = [
  { pattern: '.git', effect: 'deny', note: '版本库元数据默认只读' },
  { pattern: '.env', effect: 'deny', note: '环境变量敏感文件' },
  { pattern: '*.env', effect: 'deny', note: '环境变量敏感文件（glob）' },
  { pattern: '.env.*', effect: 'deny', note: '环境变量敏感文件（glob）' },
];

/** 守门行选项 */
export interface SafetyGateOptions {
  /** 审批服务（升权审批与守门审批共用，reason 区分） */
  readonly approval: ApprovalService;
  /** 工作区根（会话不可变 cwd；相对路径锚点） */
  readonly workspace: string;
  /** 当前生效档位取值器（三级解析产物；每次预检取最新——会话 override 即时生效） */
  readonly mode: () => SandboxMode;
  /** carve-out 例外条目（缺省内置 .git/.env 条目；传 [] 显式关闭） */
  readonly entries?: readonly CarveOutEntry[];
}

/**
 * 从写类工具参数提取目标路径集合（相对路径保持原样，统一由本行锚 workspace）。
 * 未知工具返回空（本行只管认识的写意图；其余交给 fence 与后续守门者）。
 */
function extractWritePaths(toolName: string, args: Record<string, unknown>): string[] {
  if (toolName === 'write') {
    // write 工具：单目标 path 参数
    return typeof args.path === 'string' ? [args.path] : [];
  }
  if (toolName === 'edit') {
    // edit 工具：apply_patch 补丁文本（多文件操作段，逐段提取路径）；
    // 补丁格式错不在本行的管辖面——放行给 edit 工具自身报 FS_PATCH_FAILED
    const patch = typeof args.patch === 'string' ? args.patch : '';
    try {
      return parseApplyPatch(patch).map((op) => op.path);
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * 安装安全守门行（tools_pre_execute 首位；返回 Disposer 随作用域回卷）。
 *
 * carve-out 判定表在装配期钉死（glob「先展开再遮罩」的展开时刻在此）——
 * 会话中途新建的 .env 新文件不追溯遮罩（诚实语义；要再遮罩须换条目重装）。
 */
export function installSafetyGate(ctx: Context, opts: SafetyGateOptions): Disposer {
  const workspace = canonicalPath(opts.workspace);
  const carveTable = buildCarveOutTable(workspace, opts.entries ?? DEFAULT_CARVE_OUT_ENTRIES);

  // 链续约定：放行必须 return next()（waterfall 是 koa-compose 式委托——
  // 不调 next 即短路，会吞掉链上后续守门者）；block 才可不调 next 短路整链
  const handler = async (
    input: GateInput,
    next: () => Promise<GateAction | undefined>,
  ): Promise<GateAction | undefined> => {
    const mode = opts.mode();
    // 两端档位不归本行管：read-only 由 fence 拒全量写（根为空）、danger 全放行
    if (mode !== 'workspace-write') return next();

    for (const rawPath of extractWritePaths(input.tool.name, input.args)) {
      // 与 fence 同源的 canonical 化（相对锚 workspace、解析符号链）
      const absPath = canonicalPath(resolvePath(workspace, rawPath));
      const verdict = resolveWritability(absPath, deriveWritableRoots(workspace), carveTable);
      if (verdict.allowed || verdict.kind !== 'carve-out') {
        // 放行 / 根外（outside-roots 是 fence 的拒绝面，本行不重复拦）
        continue;
      }
      // carve-out 命中：走升权审批（§7.4 同一词汇），不是硬失败
      const node = verdict.matched!;
      const outcome = await opts.approval.ask({
        summary: `写入 ${rawPath}（命中 carve-out 遮罩 ${node.entry.pattern}）`,
        reason: `carve-out：${node.entry.pattern}${node.entry.note ? `（${node.entry.note}）` : ''}；${mode} 档下此路径默认只读`,
        toolName: input.tool.name,
        toolCallId: input.callId,
      });
      if (outcome !== 'allowed-once') {
        // 拒绝/取消/无人应答：block（denial marker + 升权 hint 是 §7.4 统一文案）
        return {
          decision: 'block',
          reason: `${sandboxDenialMarker(mode)} ${rawPath} 被 carve-out 条目 ${node.entry.pattern} 遮罩（审批结果：${outcome}）。${escalationHintMarker()}`,
        };
      }
      // allowed-once：仅本次调用放行，下一个路径继续独立判定
    }
    return next(); // 全部放行：交棒链上后续守门者
  };

  // prepend: true —— 安全栈固定占守门段首位（骨架篇 §8.5 fixed 行）
  return ctx.on(TOOL_PRE_EXECUTE_EVENT, handler, { prepend: true });
}

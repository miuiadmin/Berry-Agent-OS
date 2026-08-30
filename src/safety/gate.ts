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
import { TOOL_POST_EXECUTE_EVENT, TOOL_PRE_EXECUTE_EVENT } from '../contracts/tools.js';
import type { GateAction, GateInput } from '../contracts/tools.js';
import type { Context, ContextScope, Disposer } from '../context/types.js';
import { appendHandlers, snapshotHandlers } from '../context/index.js';
import { parseApplyPatch } from '../tools/apply-patch.js';
import type { ApprovalService } from './approval.js';
import type { SandboxMode } from './types.js';
import { buildCarveOutTable, canonicalPath, deriveWritableRoots, type CarveOutEntry } from './roots.js';
import { resolveWritability } from './roots.js';
import { matchAllowlist, FS_WRITE_TOOLS, type AllowlistEntry } from './allowlist.js';
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
  /**
   * 跨会话 allowlist（第二十四批题1a——advisory 免问面）：命中即跳过 carve-out
   * 升权审批直接放行本行。只影响「问不问」：fence/根推导/执行段照走，deny 面
   * （carve-out 拒绝）不受影响。条目落用户配置层（storage/命令面随接线批落地，
   * 装配注入活数组引用——TTL 过期由引擎逐调用判定）。缺省无 = 功能关闭。
   */
  readonly allowlist?: readonly AllowlistEntry[];
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
    // read-only 档不归本行管（fence 拒全量写——根为空）；danger 档 carve-out
    // 照走（第二十四批题2a：「用户选了 danger」≠「敏感元数据静默可写」——CC
    // bypass 档免疫实证；例外表装配期钉死零运行时成本）
    if (mode === 'read-only') return next();

    // allowlist 免问（第二十四批题1a）：命中即跳过 carve-out 升权审批直接放行
    // 本行（advisory——只影响问不问；fence/根推导/执行段照走）。免问仍可审计：
    // gate/decision reason=allowlist:<条目序> 的标注需 contracts GateInput 扩
    // 字段 + pipeline reason 透传，随接线批落地（当前 pipeline 放行统一 reason=ok）。
    // 判定收窄 fs 族（§8.4 增补 2 落码形态③「F6(b) 彻底版」，2026-08-27）：
    // write/edit 是唯一在 gate 层有审批面可免的工具族——bash 的消费点在 exec
    // 升权裁决（tool.ts），整名族消费者出现（web 域粒度扩族）时再回 gate；
    // 此前 bash/整名命中是纯标注无行为效果（误导性冗余，「无消费者的匹配器
    // 不预造」同判据）。
    if (opts.allowlist !== undefined && opts.allowlist.length > 0 && FS_WRITE_TOOLS.has(input.tool.name)) {
      const hit = matchAllowlist(
        opts.allowlist,
        {
          tool: input.tool.name,
          writePaths: extractWritePaths(input.tool.name, input.args).map((p) =>
            canonicalPath(resolvePath(workspace, p)),
          ),
          workspace,
        },
        Date.now(),
      );
      if (hit !== undefined) {
        // 免问仍可审计：放行来源标注进 gate/decision reason（第二十四批题1a
        // 接线批——GateInput.allowReason → pipeline 透传，骨架篇 §8.4 粘性第 4 条）
        input.allowReason = `allowlist:${hit.index}`;
        return next();
      }
    }

    for (const rawPath of extractWritePaths(input.tool.name, input.args)) {
      // 与 fence 同源的 canonical 化（相对锚 workspace、解析符号链）
      const absPath = canonicalPath(resolvePath(workspace, rawPath));
      // 「始终允许」批量复查（§8.4 增补 2 落码形态④）：同一次调用的多路径循环
      // 里，前一路径的 always 已把条目写入活数组——本路径 ask 前复查一次
      // （单元素 writePaths，与开头全量判定有意不同粒度：carve-out 循环本就
      // 逐路径独立判定，全量输入在精确路径条目下恒 miss = 死码〔冷读 F1〕）
      if (opts.allowlist !== undefined && opts.allowlist.length > 0 && FS_WRITE_TOOLS.has(input.tool.name)) {
        const recheck = matchAllowlist(
          opts.allowlist,
          { tool: input.tool.name, writePaths: [absPath], workspace },
          Date.now(),
        );
        if (recheck !== undefined) continue; // 被新条目覆盖：免重复弹窗
      }
      const verdict = resolveWritability(absPath, deriveWritableRoots(workspace, mode), carveTable);
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
        // interrupt 小刀守门路填点：run 取消信号随 ask 载荷透传（answerer 桥接
        // 撤销；undefined = 服务面调用等无 run 语境，不携带）
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        // 推荐规则候选（§8.4 增补 2 落码形态①）：fs 草案 = 该次写目标的精确
        // canonical 路径（不取 commondir——「批这一次」不升格「常驻写全仓」）
        suggestedEntry: { tool: input.tool.name, pattern: absPath },
      });
      if (outcome !== 'allowed-once') {
        // cancelled 档是打断非拒绝（interrupt 小刀冷读 F6）：去「被拒」语义与
        // 升权重试引导——run 已 abort 时模型看不见（loop break 在先），收的是
        // durable 审计面与 resume 回放语境的诚实
        if (outcome === 'cancelled') {
          return {
            decision: 'block',
            reason: `${sandboxDenialMarker(mode)} ${rawPath} 被 carve-out 条目 ${node.entry.pattern} 遮罩（审批已取消——run 已打断）。`,
          };
        }
        // 拒绝/无人应答：block（denial marker + 升权 hint 是 §7.4 统一文案）
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

/**
 * 守门行传导判据（宿主组合根构造注入——subagent 子代理装配与 chat 驱动
 * fresh 作用域两消费面同源单件）。
 */
export interface GateRowFilter {
  /**
   * 锚作用域 owner 完整前缀集（根名 + 锚 fork 名拼成——/reload 重建锚同名，
   * 前缀恒定）。传导判据之一：entry.owner 须以某锚前缀开头。
   */
  readonly anchors: readonly string[];
  /**
   * main 载体行 id 活取值器（组合树活读——worker 行走分域装载不进 main 快照、
   * external 行 fail-closed 拒载不进装载序、disabled 行不在装载序，快照天然
   * 不含，无需再滤）。传导判据之二：entry.rowId ∈ main 行集。
   */
  readonly mainRows: () => ReadonlySet<string>;
}

/**
 * 守门行传导（骨架篇 §6.1「守门行传导 + context 腿」条）：把根总线**应用行**
 * 的 pre+post 两段 handler 传导进隔离作用域的 runtime——fresh/子代理作用域
 * 不 fork 根（隔离即过滤的极限形态），开放行不传导就结构性进不了该管道
 * （挖矿 B10「固定行进得了子管道、开放行进不去」的不对称收口）。
 *
 * 判据 = entry 自身 rowId（on() 登记时携注册方作用域行归属——loader 恒 fork
 * rowId = 行 id，结构性正确；前两代 owner 字符串切片载体在行 id 含 `:` 时
 * 取段错位，R2 测试补课批根治）：固定行 rowId 缺席结构性排除（子审批 never
 * 不被根面交互审批冒破）+ 锚前缀 + main 行集三滤。
 *
 * 传导的是 handler 引用非重注册：闭包仍捕根作用域（读根服务行为正确）、
 * owner 保真（appendHandlers 直写不走 on()——on() 会把 owner 记成目标作用域
 * 名）、目标作用域 dispose 不回卷根行。调用时点冻结：此后根链变化（/reload
 * 等）不影响已传导作用域，新开作用域取新链。execute 段不传导（拍板题 2
 * ——替换执行体风险大）。
 */
export function conductGateLines(from: ContextScope, to: ContextScope, filter: GateRowFilter): void {
  for (const event of [TOOL_PRE_EXECUTE_EVENT, TOOL_POST_EXECUTE_EVENT] as const) {
    const entries = snapshotHandlers(from, event).filter((entry) => {
      const rowId = entry.rowId;
      if (rowId === undefined) return false; // 固定行（根/宿主面注册）结构性排除
      if (!filter.anchors.some((prefix) => entry.owner.startsWith(prefix))) return false;
      return filter.mainRows().has(rowId);
    });
    if (entries.length > 0) appendHandlers(to, event, entries);
  }
}

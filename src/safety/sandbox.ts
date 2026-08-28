/**
 * L3 safety — 沙箱 seam（骨架篇 §7.1/§7.3/§7.4）。
 *
 * confine(argv, policy) → ConfinedArgv 是纯包装接口：provider 无状态、策略
 * 逐调用携带、消费方（bash 工具等）自行 spawn。后端差异数据化下发
 * （denialSignatures / runnerFailureRules），消费方零后端知识。
 * 无可用后端抛 SANDBOX_UNAVAILABLE——fail-closed，绝不静默裸跑。
 *
 * 本文件同时持有：effective mode 三级解析的 fold 半边（显式 mode 是调用方
 * 的事，override events 与部署默认在此折叠）、升权词汇（严格变宽阶梯 /
 * 成对非空校验 / 统一拒绝标记）——bash 与 fs 两族工具共享同一 home，
 * 防文案与顺序漂移。
 */

import {
  AppError,
  SANDBOX_ESCALATION_INVALID,
  SANDBOX_MODE_INVALID,
  SANDBOX_UNAVAILABLE,
} from '../contracts/errors.js';
import type { Disposer } from '../context/types.js';
import type { Context } from '../context/types.js';
import type {
  AllowlistDraft,
  ApprovalOutcome,
  ApprovalRequest,
  ConfinedSandboxMode,
  SandboxBackend,
  SandboxMode,
} from './types.js';
import { deriveWritableRoots } from './roots.js';
// 平台链引用（函数体内才调用，无顶层互调——与后端文件的双向引用安全）
import { createSeatbeltBackend } from './seatbelt.js';
import { createBwrapBackend } from './bwrap.js';

/* ------------------------------------------------------------------ */
/* 策略与结果类型                                                       */
/* ------------------------------------------------------------------ */

/** 沙箱策略（逐调用携带；danger-full-access 不进 confine——调用方直接透传） */
export interface SandboxPolicy {
  /** 请求档位（受限两档之一；越档走升权审批产物，见 §7.4） */
  readonly mode: ConfinedSandboxMode;
  /** 工作区根（canonical 绝对路径；可写根推导锚点） */
  readonly workspaceRoot: string;
  /** 可写根显式覆盖（缺省 deriveWritableRoots(workspaceRoot)——与 fs fence 同源） */
  readonly writableRoots?: readonly string[];
}

/** 策略实际生效的可写根列表（缺省按档位推导；两个后端与 fs fence 共用同一来源。
 * read-only 档空根——Seatbelt read-only profile 本就全拒写（不吃根列表）、
 * Bwrap 空根即无 rw bind（2026-08-25 mode 升一等输入后两后端语义同源收紧）） */
export function resolvePolicyRoots(policy: SandboxPolicy): readonly string[] {
  return policy.writableRoots ?? deriveWritableRoots(policy.workspaceRoot, policy.mode);
}

/** 后端强制完整性（如实上报，上层裁决；Windows ACL 受限令牌将是 partial 先例） */
export type SandboxEnforcement = 'full' | 'partial';

/** runner 自身失败分类规则：fatalSignatures 命中 = runner 没跑起来（区别于策略拒绝生效） */
export interface RunnerFailureRule {
  readonly fatalSignatures: readonly string[];
}

/** confine 产物：受限 argv + 后端差异元数据（消费方 spawn 后据此分类 stderr） */
export interface ConfinedArgv {
  /** 包装后的 argv（含 runner 前缀；消费方直接 spawn） */
  readonly argv: string[];
  /** 所用后端的强制完整性 */
  readonly enforcement: SandboxEnforcement;
  /** 本后端「策略拒绝了」的 stderr 识别特征（大小写不敏感子串） */
  readonly denialSignatures: readonly string[];
  /** runner 自身失败的分类规则 */
  readonly runnerFailureRules: readonly RunnerFailureRule[];
}

/* ------------------------------------------------------------------ */
/* 三级优先的 fold 半边（骨架篇 §7.3）                                  */
/* ------------------------------------------------------------------ */

/** 三档词汇守卫（fold 与配置解析共用；拼错档位必须响亮失败） */
export function isSandboxMode(value: string): value is SandboxMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access';
}

/**
 * 折叠会话 sandbox/mode 事件序列 → effective mode（最后一条胜出）。
 * 部署默认 read-only 为 fail-safe 兜底。载荷不在三档词汇内直接抛
 * SANDBOX_MODE_INVALID——静默跳过坏事件会沿用旧档，是 fail-open。
 */
export function resolveEffectiveMode(
  events: readonly { readonly mode: string }[],
  fallback: SandboxMode = 'read-only',
): SandboxMode {
  let mode = fallback;
  for (const event of events) {
    if (!isSandboxMode(event.mode)) {
      throw new AppError(
        SANDBOX_MODE_INVALID,
        `sandbox/mode 事件档位非法：${JSON.stringify(event.mode)}（三档词汇：read-only / workspace-write / danger-full-access）`,
      );
    }
    mode = event.mode;
  }
  return mode;
}

/* ------------------------------------------------------------------ */
/* 沙箱服务（ctx.sandbox；后端链 + confine fail-closed）                */
/* ------------------------------------------------------------------ */

/** ctx.sandbox 服务面（应用经 ctx.get<SandboxService>('sandbox') 取用） */
export interface SandboxService {
  /** 纯包装：受限档策略下把消费方 argv 变为受限 argv（消费方自行 spawn） */
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv;
  /** 注册沙箱后端（后端应用行；返回注销器，幂等） */
  registerBackend(backend: SandboxBackend): Disposer;
  /** 当前后端链快照（诊断/审计输出用） */
  listBackends(): readonly SandboxBackend[];
}

/** 沙箱服务选项 */
export interface SandboxServiceOptions {
  /** 初始后端链（缺省 createDefaultBackends() 平台链；传 [] 显式空链=测试用） */
  readonly backends?: readonly SandboxBackend[];
}

/**
 * 组装沙箱服务。选后端规则（骨架篇 §7.2「探测仲裁，不重复验证唯一候选」）：
 * - 空链 → confine 抛 SANDBOX_UNAVAILABLE（fail-closed）；
 * - 单候选 → 直接使用不预探测（探测有 spawn 开销，且坏了 spawn 会响亮失败，
 *   runnerFailureRules 负责分类）；
 * - 多候选 → 按注册序找首个 probe 通过者（无 probe 视为可用）——探测结果
 *   按后端缓存一次，探测失败的候选不重试。
 */
export function createSandboxService(opts: SandboxServiceOptions = {}): SandboxService {
  /** 后端链（注册序即优先序） */
  const chain: SandboxBackend[] = [...(opts.backends ?? createDefaultBackends())];
  /** probe 结果缓存（backend.id → 布尔；注销即清除） */
  const probeCache = new Map<string, boolean>();

  /** 单个后端的可用性判定（无 probe = 视为可用；结果缓存一次） */
  const isAvailable = (backend: SandboxBackend): boolean => {
    if (!backend.probe) return true;
    if (!probeCache.has(backend.id)) {
      // 功能性探测：真跑一次 read-only 包装（后端实现负责），status 0 才算内核确实执行
      probeCache.set(backend.id, backend.probe(PROBE_TIMEOUT_MS));
    }
    return probeCache.get(backend.id)!;
  };

  const service: SandboxService = {
    confine(argv, policy) {
      if (chain.length === 0) {
        // fail-closed：没有后端就拒绝执行，绝不静默裸跑
        throw new AppError(
          SANDBOX_UNAVAILABLE,
          `无可用沙箱后端，拒绝以 ${policy.mode} 档裸跑（本平台链为空；可安装沙箱后端或换 danger-full-access 档）`,
        );
      }
      // 单候选直接用；多候选按 probe 仲裁
      const backend = chain.length === 1 ? chain[0]! : (chain.find((b) => isAvailable(b)) ?? undefined);
      if (!backend) {
        throw new AppError(
          SANDBOX_UNAVAILABLE,
          `后端链全部探测失败（${chain.map((b) => b.id).join(' → ')}），拒绝以 ${policy.mode} 档裸跑`,
        );
      }
      return {
        argv: backend.wrap(argv, policy),
        enforcement: backend.enforcement,
        denialSignatures: backend.denialSignatures,
        runnerFailureRules: backend.runnerFailureRules,
      };
    },

    registerBackend(backend) {
      chain.push(backend);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        // 同位注销护栏：仅当链尾仍是本后端时弹出（防误撤他者注册的同 id 后端）
        if (chain[chain.length - 1] === backend) {
          chain.pop();
          probeCache.delete(backend.id);
        }
      };
    },

    listBackends() {
      return [...chain];
    },
  };
  return service;
}

/** 功能性探测超时（毫秒）：真跑一次包装不该超过这个时长，超过视为不可用 */
const PROBE_TIMEOUT_MS = 5_000;

/** 把沙箱服务挂进 ctx（ctx.provide('sandbox')，随作用域 LIFO 回卷） */
export function registerSandboxService(ctx: Context, service: SandboxService): Disposer {
  return ctx.provide('sandbox', service);
}

/** 平台默认后端链（骨架篇 §7.2 落地顺序：macOS Seatbelt 首发 / Linux bwrap 其次） */
export function createDefaultBackends(): SandboxBackend[] {
  if (process.platform === 'darwin') return [createSeatbeltBackend()];
  if (process.platform === 'linux') return [createBwrapBackend()];
  // 其余平台 M1 无后端——confine 会 fail-closed；如实空链不假装覆盖
  return [];
}

/* ------------------------------------------------------------------ */
/* 升权词汇（骨架篇 §7.4 钉死；bash 与 fs 共享同一 home）               */
/* ------------------------------------------------------------------ */

/** 严格变宽阶梯：只许变宽不许变窄绕行（read-only→两档 / workspace-write→danger / danger 无更宽） */
export const WIDER_MODES: Readonly<Record<SandboxMode, readonly SandboxMode[]>> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
  'danger-full-access': [],
};

/** 可请求的升权目标档（= 两档受限/放行词汇中「更宽」的那两个） */
export const ESCALATION_TARGETS: readonly SandboxMode[] = ['workspace-write', 'danger-full-access'];

/** 升权请求参数（模型经工具参数携带；current 由运行时注入防伪造） */
export interface EscalationArgs {
  /** 当前生效档（运行时注入——不是模型自报的「我现在什么档」 */
  readonly current: SandboxMode;
  /** 工具参数 sandbox_permissions（目标档；模型填写） */
  readonly sandboxPermissions: string | undefined;
  /** 工具参数 justification（升权理由；模型填写） */
  readonly justification: string | undefined;
}

/** 校验通过的升权请求 */
export interface ValidEscalation {
  readonly target: SandboxMode;
  readonly justification: string;
}

/**
 * 升权参数校验（骨架篇 §7.4 三条全在此）：sandbox_permissions 与
 * justification 强制成对非空（空句同非法）；目标必须是合法升权档；
 * 必须严格变宽（非变宽请求不弹窗直接 throw，防窄绕行与同档重试噪音）。
 */
export function validateEscalationArgs(args: EscalationArgs): ValidEscalation {
  const perm = args.sandboxPermissions?.trim();
  const just = args.justification?.trim();
  // 成对非空：一边有一边无 = 参数残缺，不给弹窗机会
  if (!perm && !just) {
    throw new AppError(
      SANDBOX_ESCALATION_INVALID,
      '升权请求缺 sandbox_permissions 与 justification（两者必须成对提供）',
    );
  }
  if (!perm || !just) {
    throw new AppError(
      SANDBOX_ESCALATION_INVALID,
      `升权参数不成对：sandbox_permissions=${JSON.stringify(perm ?? '')} justification=${JSON.stringify(just ?? '')}（两者必须成对非空）`,
    );
  }
  if (!ESCALATION_TARGETS.includes(perm as SandboxMode)) {
    throw new AppError(
      SANDBOX_ESCALATION_INVALID,
      `升权目标档非法：${perm}（合法目标：${ESCALATION_TARGETS.join(' / ')}）`,
    );
  }
  if (!WIDER_MODES[args.current].includes(perm as SandboxMode)) {
    // 非严格变宽（变窄或同档）：不弹窗直接拒——变窄绕行与无意义重试都不进审批
    throw new AppError(
      SANDBOX_ESCALATION_INVALID,
      `升权请求非严格变宽：${args.current} → ${perm}（当前档只可升至 ${WIDER_MODES[args.current].join(' / ') || '（已是最高档）'}）`,
    );
  }
  return { target: perm as SandboxMode, justification: just };
}

/** 统一拒绝标记：被策略拒绝时回给模型的固定句式（工具结果与守门 block 共用） */
export function sandboxDenialMarker(mode: SandboxMode): string {
  return `[sandbox: file access denied under ${mode}]`;
}

/** 升权提示标记：拒绝后引导模型基于真实 denial 走正道（明确不许投机） */
export function escalationHintMarker(): string {
  return '[sandbox hint: 若确需本次访问，在同一工具调用中同时提供 sandbox_permissions（workspace-write 或 danger-full-access）与 justification 发起升权；拒绝是最终的——不许绕路、不许无真实拒绝依据的投机升权]';
}

/** 升权审批请求（ask 载荷；allowed-once 只授予当次调用） */
export interface EscalationApprovalInput extends ValidEscalation {
  /** 升权起点档（审批 reason 注明） */
  readonly current: SandboxMode;
  /** 发起升权的工具名/调用 id（有则随审批记录） */
  readonly toolName?: string;
  readonly toolCallId?: string;
  /**
   * 推荐规则候选（骨架篇 §8.4 增补 2 落码形态①③）：bash 升权的「始终允许」
   * 草案（命令词干），仅 workspace-write 目标携带——danger-full-access 是
   * safetyLevel 高位 v1 刻度，恒不带草案（落码形态② danger 恒问边界）。
   */
  readonly suggestedEntry?: AllowlistDraft;
}

/**
 * 走审批的升权序列：校验产物 → ctx.approval.ask（reason 注明目标档与
 * 理由）→ 原样返回 outcome。allowed-once 的「只授予当次调用」由调用方
 * 保证（把返回的 target 仅用于本次 spawn，不写回会话 override）。
 */
export function requestEscalation(
  approval: { ask(req: ApprovalRequest): Promise<ApprovalOutcome> },
  input: EscalationApprovalInput,
): Promise<ApprovalOutcome> {
  return approval.ask({
    summary: `沙箱升权 ${input.current} → ${input.target}`,
    reason: `目标档 ${input.target}；理由：${input.justification}`,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    ...(input.suggestedEntry !== undefined ? { suggestedEntry: input.suggestedEntry } : {}),
  });
}

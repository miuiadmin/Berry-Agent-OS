/**
 * L3 safety — 公共类型（骨架篇 §7 沙箱栈 / §8 审批；内核篇 2.5 宿主面安全栈）。
 *
 * 两个正交 knob（骨架篇 §8.2）：sandbox mode（三档文件效果）× approval policy
 * （ask / never）。预设只是用户面打包，组合逻辑不进执行路径。
 */

import type { RunnerFailureRule, SandboxEnforcement, SandboxPolicy } from './sandbox.js';
import type { CarveOutEntry } from './roots.js';

/** 三档文件效果词汇（骨架篇 §7.1）：只管文件效果，网络与进程可见性显式排除在词汇外 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** 受限档（danger-full-access 之外的档位——SandboxPolicy 能携带的 mode） */
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>;

/** 审批策略档（骨架篇 §8.3）：ask 默认（无人应答 fail-closed）/ never 确定性拒绝 */
export type ApprovalPolicyMode = 'ask' | 'never';

/** 审批结局闭集（骨架篇 §8.3 钉死；allowed-once 只授予当次调用） */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** answerer（审批应答者）的三值决策——通道插件在 approval/answer waterfall 上短路返回 */
export type ApprovalAnswer = 'approve' | 'reject' | 'cancel';

/** 审批请求（骨架篇 §8.4：含 reason、请求方、目标动作摘要——审计自包含） */
export interface ApprovalRequest {
  /** 目标动作摘要（人可读一行；升权场景含目标档与理由） */
  readonly summary: string;
  /** 请求方/理由（升权审批注明目标档与 justification） */
  readonly reason?: string;
  /** 发起审批的工具名（有则记录） */
  readonly toolName?: string;
  /** 关联的工具调用 id（有则记录） */
  readonly toolCallId?: string;
}

/** 沙箱后端统一接口（后端是可替换插件行；seam 与强制点在内核） */
export interface SandboxBackend {
  /** 后端标识（'seatbelt' / 'bwrap' / 自定义） */
  readonly id: string;
  /** 本后端的强制完整性（如实上报，上层裁决） */
  readonly enforcement: SandboxEnforcement;
  /** 本后端被策略拒绝时的 stderr 识别特征（大小写不敏感子串） */
  readonly denialSignatures: readonly string[];
  /** runner 自身失败的分类规则（区别「runner 没跑起来」与「策略拒绝生效」） */
  readonly runnerFailureRules: readonly RunnerFailureRule[];
  /** 纯包装：消费方 argv → 受限 argv（消费方自行 spawn） */
  wrap(argv: readonly string[], policy: SandboxPolicy): string[];
  /** 功能性探测：真跑一次 read-only profile 验证内核确实执行（可选；单候选链不预探测） */
  probe?(timeoutMs: number): boolean;
}

/** 可写根推导输入（骨架篇 §7.3：writableRoots 唯一推导函数 + carve-out 例外表） */
export interface WritableRootsInput {
  /** 工作区根（会话不可变 cwd） */
  readonly workspace: string;
  /** carve-out 例外条目（层叠：父可写/子拒绝/孙再可写） */
  readonly entries?: readonly CarveOutEntry[];
}

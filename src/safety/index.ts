/**
 * L3 safety — 桶导出（沙箱栈 + 审批 + 可写根推导 + 守门行）。
 */

/* 公共类型 */
export type {
  SandboxMode,
  ConfinedSandboxMode,
  ApprovalPolicyMode,
  ApprovalOutcome,
  ApprovalAnswer,
  ApprovalRequest,
  SandboxBackend,
  WritableRootsInput,
} from './types.js';

/* 可写根唯一推导 + carve-out 层叠例外（骨架篇 §7.3） */
export type { CarveOutEntry, CarveOutNode, WritabilityVerdict } from './roots.js';
export {
  canonicalPath,
  deriveWritableRoots,
  externalWritableRoots,
  externalEffectiveRoots,
  intersectRoots,
  isInsideRoot,
  expandCarveOutEntry,
  buildCarveOutTable,
  resolveWritability,
  createRootsProvider,
  absolutize,
} from './roots.js';

/* 沙箱 seam：类型 + 服务 + 三级 fold + 升权词汇（骨架篇 §7.1/§7.3/§7.4） */
export type {
  SandboxPolicy,
  SandboxEnforcement,
  RunnerFailureRule,
  ConfinedArgv,
  EscalationArgs,
  ValidEscalation,
  EscalationApprovalInput,
  SandboxService,
  SandboxServiceOptions,
} from './sandbox.js';
export {
  resolvePolicyRoots,
  isSandboxMode,
  resolveEffectiveMode,
  createSandboxService,
  registerSandboxService,
  createDefaultBackends,
  WIDER_MODES,
  ESCALATION_TARGETS,
  validateEscalationArgs,
  sandboxDenialMarker,
  escalationHintMarker,
  requestEscalation,
} from './sandbox.js';

/* 平台后端（骨架篇 §7.2：Seatbelt 首发 / bwrap 其次） */
export { seatbeltReadOnlyProfile, seatbeltProfile, createSeatbeltBackend } from './seatbelt.js';
export { bwrapArgs, createBwrapBackend } from './bwrap.js';

/* Node PM 中层旗推导器（契约篇 §1.7 external 载体——external carrier 落码批） */
export { derivePmFlags } from './pm-flags.js';

/* 审批服务（骨架篇 §8.3） */
export type {
  ApprovalDecisionSink,
  ApprovalDecisionValue,
  ApprovalService,
  ApprovalServiceOptions,
} from './approval.js';
export { APPROVAL_ANSWER_EVENT, createApprovalService, bridgeApprovalSignal } from './approval.js';

/* 守门固定行（骨架篇 §8.1/§8.5）+ 守门行传导（§6.1——subagent 子代理装配与
   chat 驱动 fresh 作用域两消费面同源单件） */
export type { SafetyGateOptions, GateRowFilter } from './gate.js';
export { DEFAULT_CARVE_OUT_ENTRIES, installSafetyGate, conductGateLines } from './gate.js';
export { matchAllowlist, commandStem } from './allowlist.js';
export type { AllowlistEntry, AllowlistInput, AllowlistMatch } from './allowlist.js';

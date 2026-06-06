/**
 * 12.0 语义漂移防护 — 意图锚点与漂移信号契约。
 *
 * IntentAnchor 在 Brain 路由时同步产出，作为后续所有漂移检测的基准。
 * DriftSignal 是漂移检测器在各关键节点的输出。
 */

// ─────────────────────────────────────────────────────────────────
// 意图锚点
// ─────────────────────────────────────────────────────────────────

/** 预期产出类型 */
export type IntentOutputType = 'code_change' | 'explanation' | 'analysis' | 'creation' | 'other';

/** 意图锚点 — Brain 路由时同步产出，描述用户的结构化意图 */
export interface IntentAnchor {
  /** 用户想要达成的目标（一句话概括） */
  goal: string;
  /** 关键约束条件（如"不要改测试文件"、"用 TypeScript"） */
  constraints: string[];
  /** 预期产出类型 */
  outputType: IntentOutputType;
  /** 涉及的核心实体（文件、模块、概念） */
  entities: string[];
}

// ─────────────────────────────────────────────────────────────────
// 漂移信号
// ─────────────────────────────────────────────────────────────────

/** 漂移检测点类型 */
export type DriftCheckpointType = 'dialogue' | 'task_result' | 'final_response';

/** 漂移后建议的处置动作 */
export type DriftAction = 'continue' | 'correct' | 'verify' | 'abort';

/** 漂移信号 — DriftDetector 在关键节点的检测输出 */
export interface DriftSignal {
  /** 对齐度评分（0-1，1=完全对齐，0=完全偏离） */
  alignmentScore: number;
  /** 是否需要干预 */
  needsIntervention: boolean;
  /** 偏离描述（仅当 needsIntervention=true 时填充） */
  driftDescription?: string;
  /** 建议动作 */
  suggestedAction?: DriftAction;
  /** 检测点类型 */
  checkpointType: DriftCheckpointType;
}

// ─────────────────────────────────────────────────────────────────
// 验证闸门
// ─────────────────────────────────────────────────────────────────

/** Verify Gate 的判决结果 */
export interface VerifyVerdict {
  /** 是否通过验证 */
  pass: boolean;
  /** 判决理由 */
  reason: string;
  /** 不通过时的修正指导 */
  correction?: string;
}

// ─────────────────────────────────────────────────────────────────
// 阈值配置
// ─────────────────────────────────────────────────────────────────

/** 单个检测点的阈值 */
export interface DriftThresholdEntry {
  /** 低于此值触发纠偏（CorrectionFlow） */
  warnBelow: number;
  /** 低于此值触发阻断验证（Verify Gate） */
  blockBelow: number;
}

/** 各检测点的阈值配置 */
export interface DriftThresholds {
  dialogue: DriftThresholdEntry;
  task_result: DriftThresholdEntry;
  final_response: DriftThresholdEntry;
}

/** 默认阈值 — 对话宽松，最终回复严格 */
export const DEFAULT_DRIFT_THRESHOLDS: DriftThresholds = {
  dialogue: { warnBelow: 0.5, blockBelow: 0.3 },
  task_result: { warnBelow: 0.6, blockBelow: 0.4 },
  final_response: { warnBelow: 0.7, blockBelow: 0.5 },
};

// ─────────────────────────────────────────────────────────────────
// 漂移度量聚合
// ─────────────────────────────────────────────────────────────────

/** 漂移度量聚合结果 — 定期计算，暴露给前端 */
export interface DriftMetrics {
  /** 时间窗口内的平均对齐分数 */
  avgAlignmentScore: number;
  /** 触发干预的比例 */
  interventionRate: number;
  /** 干预后恢复对齐的比例 */
  recoveryRate: number;
  /** 最终回复的平均对齐分数 */
  finalResponseAlignment: number;
  /** 漂移高发的 agent 对 */
  hotspotPairs: Array<{ from: string; to: string; avgScore: number }>;
  /** 统计的信号总数 */
  totalSignals: number;
}

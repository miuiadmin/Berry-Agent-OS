export interface ToolAuditPayload {
  sessionId: string;
  taskId?: string;
  correlationId?: string;
  toolName: string;
  toolInput: string;
  permissionToken?: string;
  toolResult: string;
  isError: boolean;
  dangerLevel: string;
  durationMs: number;
}

// ─── 15.0 机制 C：Auditor 后置审计报告 ───

/**
 * Auditor 是被动事后审计者（不在关键路径，不阻塞）：扫描历史数据，给 Brain 出报告。
 * 报告由确定性 SQL 扫描产出（见 agents/bundled/auditor/scan.ts），Brain 据此决定行动
 * （划 scope / 升级用户 / 触发进化）。依据 CLAUDE.md「确定性逻辑优先做代码模块」——
 * Auditor 的扫描是确定性代码，只有模式解释可选地用 LLM。
 */

/** 跨任务模式：高频访问某路径、重复工具调用等 */
export interface AuditPattern {
  kind: 'high_freq_path' | 'repeated_tool' | 'anomalous_time';
  description: string;
  /** 命中次数 / 频率度量 */
  count: number;
  /** 相关实体（路径 / 工具名 / agent 名） */
  subject: string;
}

/** 累积风险项：低风险操作的累积效果 */
export interface AuditRisk {
  kind: 'accumulated_low_risk' | 'high_volume_access';
  description: string;
  severity: 'low' | 'medium' | 'high';
  count: number;
}

/** Brain 决策不一致 / 审核覆盖缺口 / 漂移回顾的通用问题项 */
export interface AuditIssue {
  kind: 'decision_inconsistency' | 'review_gap' | 'drift_approved';
  description: string;
  /** 关联 ID（session / task / correlation）便于定位 */
  refId?: string;
}

/** Auditor 给 Brain 的行动建议 */
export interface AuditRecommendations {
  /** 严重问题，建议升级用户（自然语言） */
  escalationToUser?: string;
  /** 建议触发的进化信号 */
  evolutionTriggers?: string[];
  /** 建议划的禁区工具（预防下一轮） */
  forbiddenTools?: string[];
}

/** Auditor 产出的完整审计报告 */
export interface AuditReport {
  /** 本次审计的时间范围（epoch ms） */
  timeRange: { from: number; to: number };
  /** 扫描的工具调用数 */
  taskCount: number;
  findings: {
    patterns: AuditPattern[];
    risks: AuditRisk[];
    inconsistencies: AuditIssue[];
    coverageGaps: AuditIssue[];
    driftRecap: AuditIssue[];
  };
  recommendations: AuditRecommendations;
  /** 整体风险评分 0-1（越高越需关注） */
  riskScore: number;
}

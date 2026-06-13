/**
 * Brain 中枢治理契约（15.0 第一部分）。
 *
 * 集中定义 Brain 作为「中枢治理者」的两种对外协议：
 * - BrainEscalation（机制 B）：Brain 任何职责拿不准时，统一升级给用户的协议
 * - BrainCommand（机制 D）：Brain 向任意 Agent 发号施令的指挥协议
 *
 * 设计原则（CLAUDE.md 架构优雅定律）：不引入新传输层概念，复用现有 IPC/ask_user。
 */

/**
 * 机制 B：统一升级通道。
 *
 * Brain 在四个职责里都可能「决定不了」，各自原先碎片化处理（review 有 needsClarification、
 * permission 无出口、route 无出口）。15.0 统一为 BrainEscalation：Brain 返回此结构，
 * orchestrator/flow 统一转给 Conversation 走标准 askUser 问用户。
 *
 * 数据流：Brain 职责返回 { escalation } → flow 发 conversation.escalation →
 * Conversation 用 askUser 提问 → askUser 再经 Brain ask_user 审核（闭环）。
 */
export interface BrainEscalation {
  /** 触发升级的 Brain 职责（checkpoint 对应 §3.3 的 checkpoint.evaluate.result 触发点） */
  source: 'review' | 'approval' | 'decision' | 'checkpoint';
  /** Brain 决定不了的原因（内部审计用） */
  reason: string;
  /** 要问用户的自然语言问题（已格式化，可直接展示给用户） */
  questionToUser: string;
  /** 附加上下文（可选，给 Conversation 拼上下文用） */
  context?: Record<string, unknown>;
}

/**
 * 机制 D：Brain 指挥通道指令类型。
 *
 * - execute：让目标 Agent 执行新任务（映射 mission 创建 / agent.delegate）
 * - inspect：让目标 Agent 做检查（映射 checker.dispatch / auditor 触发）
 * - report：让目标 Agent 返回状态（通用状态查询）
 *
 * Brain 的 command 是单向特权指令（指挥官→执行者），Agent 通过 brain.command.result 返回。
 * 不改变 FORBIDDEN_TARGETS 语义——Brain 不是 Agent 的对话伙伴，而是指挥官。
 */
export type BrainCommandType = 'execute' | 'inspect' | 'report';

/** BrainCommand 优先级（影响排队与审计粒度） */
export type BrainCommandPriority = 'low' | 'normal' | 'high' | 'critical';

/** 机制 D：Brain 指挥指令 */
export interface BrainCommand {
  /** 目标 Agent 名 */
  target: string;
  /** 指令类型 */
  type: BrainCommandType;
  /** 指令负载（随 type 而异：execute=任务描述 / inspect=检查维度 / report=查询字段） */
  payload: Record<string, unknown>;
  /** 优先级 */
  priority: BrainCommandPriority;
}

/** 机制 D：Brain 指挥指令结果 */
export interface BrainCommandResult {
  /** 执行是否成功 */
  success: boolean;
  /** 返回数据（inspect/report 用） */
  data?: unknown;
  /** 错误信息（success=false 时） */
  error?: string;
}

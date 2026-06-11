import type { RouteDecision } from './routing.js';

export type ReviewVerdict = 'approve' | 'modify' | 'reject';
export type ReviewLevel = 'A' | 'B' | 'C';

/**
 * 审核记录 — 提交给 Brain 审核的完整上下文。
 *
 * 13.0 §12.6: 增加 mission 上下文，让 Brain 审核时知道
 * "你分配给这个 agent 的任务是什么"。
 */
export interface TurnRecord {
  sessionId: string;
  userMessage: string;
  draftResponse: string;
  toolCalls: Array<{ name: string; input: string; result: string }>;
  level: ReviewLevel;
  /** 13.0 §12.6: 关联的 mission ID（Brain 创建 mission 后注入） */
  missionId?: string;
  /** 13.0 §12.6: 关联的 plan 任务 ID（用于审核后更新 plan 状态） */
  planTaskId?: string;
  /** 13.0 §12.6: 分配给 agent 的任务描述（Brain 审核时判断"目标是否达成"） */
  taskDescription?: string;
  /**
   * 13.0 §5.2.5: 本 turn 中跨 agent 对话次数。
   * 用于 classifyLevel 判定 C 级（> 5 次跨 agent 对话意味着复杂多步骤场景）。
   * 由 DelegationOrchestrator 在构建 TurnRecord 时从 dialogueRouter 统计。
   */
  agentDialogCount?: number;
}

export interface ReviewRequest {
  turn: TurnRecord;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  finalResponse?: string;
  reason?: string;
  reRoute?: RouteDecision;
}

/**
 * 13.0 §3.5 / §5.2.5: 审核上下文分级 — 确定性规则（非 LLM 判断）。
 *
 * C 级触发条件（任一满足即升级）：
 *   1. 工具调用超过 15 次（大量操作）
 *   2. 使用了危险工具（run_command、delete_file、web_fetch 等）
 *   3. 跨 agent 对话超过 5 次（复杂多步骤协作）
 *
 * B 级触发条件：
 *   - 有工具调用（中等复杂度）
 *   - 有 mission 上下文（多 agent 协作）
 *   - 输入+草稿总长度 > 800 字
 *
 * A 级：简单文本回复（无工具、无协作、短文本）
 */
export function classifyLevel(turn: TurnRecord): ReviewLevel {
  // ─── C 级判定 ───

  // C 级条件 1：大量工具调用
  if (turn.toolCalls.length > 15) return 'C';

  // C 级条件 2：使用了危险工具（§5.3.6 定义的不可逆/高风险工具类别）
  if (turn.toolCalls.length > 0 && hasDangerousTool(turn.toolCalls)) return 'C';

  // C 级条件 3：跨 agent 对话过多（复杂多步骤场景）
  if ((turn.agentDialogCount ?? 0) > 5) return 'C';

  // ─── B 级判定 ───

  // B 级：有工具调用（中等复杂度）
  if (turn.toolCalls.length > 0) return 'B';
  // B 级：有 mission 上下文（涉及多 agent 协作）
  if (turn.missionId) return 'B';
  // B 级：总长度超过 800 字
  const inputLength = turn.userMessage.length + turn.draftResponse.length;
  if (inputLength > 800) return 'B';

  // ─── A 级：简单文本回复 ───
  return 'A';
}

/**
 * §5.3.6 危险工具名称集合 — 不可逆/高风险工具。
 *
 * 与 src/safety/permissions.ts 的 DANGEROUS_TOOL_CATEGORIES 保持一致。
 * 此处用数组（而非 import Set）避免循环依赖和运行时开销。
 */
const DANGEROUS_TOOLS: readonly string[] = [
  // 已实现的实际工具
  'run_command',       // shell 执行
  'write_file',        // 文件覆盖（不可逆）
  'edit_code',         // 代码修改（不可逆）
  'delete_file',       // 文件删除（不可逆）
  'web_fetch',         // 外部网络访问
  'http_fetch',        // 外部网络访问
  'send_notification', // 给用户发消息
  'cron_create',       // 创建定时任务（持久化副作用）
  'plugin_execute',    // 插件调用（沙箱外执行）
  // §5.3.6 规范定义的抽象类别（前向兼容）
  'http_request',      // 外部 API 调用
  'send_email',        // 发送邮件
  'send_message',      // 发送消息到外部渠道
  'db_migrate',        // 数据库迁移
  'db_write',          // 数据库写入
];

/** 检查工具调用列表中是否包含危险工具 */
function hasDangerousTool(toolCalls: Array<{ name: string }>): boolean {
  const dangerousSet = new Set(DANGEROUS_TOOLS);
  return toolCalls.some(tc => dangerousSet.has(tc.name));
}

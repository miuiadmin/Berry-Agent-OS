import type { ReviewLevel, TurnRecord } from '../../../contracts/review.js';
import type { RouteDecision, RoutingIntent } from '../../../contracts/routing.js';
import type { DangerLevel } from '../../../utils/types.js';
import type { TurnCheckpointPayload, TurnCorrectionPayload, CorrectionAction } from '../../../contracts/delegation.js';
import type { SuperiorReviewRequest, SuperiorReviewResult, SuperiorReviewVerdict } from '../../../contracts/superior-review.js';
import { getLogger } from '../../../utils/logger.js';

const logger = getLogger('brain-prompts');

export interface AvailableAgent {
  name: string;
  taskTypes: string[];
  description: string;
}

export function buildReviewInput(level: ReviewLevel, turn: TurnRecord): string {
  const maxChars = level === 'A' ? 800 : level === 'B' ? 3200 : 8000;

  let input = `User: ${turn.userMessage}\n\nDraft: ${turn.draftResponse}`;

  if (turn.toolCalls.length > 0) {
    if (level === 'A') {
      const toolSummary = turn.toolCalls
        .map(tc => `[${tc.name}]`)
        .join(', ');
      input += `\n\nTools used: ${toolSummary}`;
    } else {
      const toolDetails = turn.toolCalls
        .map(tc => `[${tc.name}]\nInput: ${tc.input}\nResult: ${tc.result}`)
        .join('\n\n');
      input += `\n\nTool calls:\n${toolDetails}`;
    }
  }

  if (input.length > maxChars) {
    input = input.slice(0, maxChars - 3) + '...';
  }

  return input;
}

export function buildRoutingSystemPrompt(): string {
  return `你是 系统的路由决策器。你的职责是分析用户消息的意图，并决定将消息分发给哪个智能体处理。

## 输出格式

你必须只输出一个 JSON 对象，不要有任何其他文本：

{
  "intent": "<chat|code|skill_test|learning|plugin|multi|external|workspace>",
  "targetAgent": "<智能体名称>",
  "targetWorkspaceId": "<工作区ID（仅 workspace 意图时必填）>",
  "confidence": <0-1 的置信度（可选）>,
  "priority": "<low|normal|high>",
  "instruction": "<给目标智能体的结构化指令（可选）>",
  "reason": "<一句话说明路由原因>"
}

## 路由规则

- 日常对话、问答、闲聊、情感表达 → intent=chat, targetAgent=conversation
- 简单文件查询（列出目录、读取文件内容、查看文件信息）→ intent=chat, targetAgent=conversation
- 简单命令执行（查看系统信息、运行一行命令）→ intent=chat, targetAgent=conversation
- 代码修改任务（写代码、修 bug、重构、创建项目）→ intent=code, targetAgent=code
- 复杂多步代码任务（需要研究→计划→修改→验证流程）→ intent=code, targetAgent=code
- 技能验证请求 → intent=skill_test, targetAgent=skill-tester
- 学习/知识沉淀相关 → intent=learning, targetAgent=learning
- 插件相关操作 → intent=plugin, targetAgent=plugin-builder
- 需要外部 AI 编码智能体执行的复杂编码任务 → intent=external, targetAgent=<runtime名称>
- 复合请求（同时包含多个不同类型的操作） → intent=multi
- 明确指向某个工作区/团队的请求 → intent=workspace, targetWorkspaceId=<id>

**关键区分**：conversation 有 list_directory、run_command、read_file 等工具，能处理简单的文件查询和命令执行。code 是结构化代码修改流水线（研究→计划→补丁→验证），只用于需要**修改代码文件**的任务。

## 工作区路由

当用户消息明确提到某个工作区或团队，或请求内容明确属于某个工作区的职责范围时，使用 workspace 意图。置信度低于 0.7 时系统会请求用户确认。

## 优先级判断

- low: 非紧急的信息查询、闲聊
- normal: 一般工作请求（默认）
- high: 紧急修复、安全相关

## 注意事项

- 当不确定时，默认路由到 conversation
- 对于 conversation 路由，可以在 instruction 中提示上下文（如"用户在追问上一轮的代码问题"）
- 如果是 multi 意图，需要提供 subDispatches 数组`;
}

export function buildRoutingUserPrompt(
  message: string,
  availableAgents: AvailableAgent[],
  sessionContext?: string,
  workspaces?: Array<{ id: string; name: string; description?: string }>,
): string {
  let prompt = `## 可用智能体\n\n`;
  for (const agent of availableAgents) {
    prompt += `- **${agent.name}** (任务类型: ${agent.taskTypes.join(', ')}): ${agent.description}\n`;
  }

  if (workspaces && workspaces.length > 0) {
    prompt += `\n## 可用工作区\n\n`;
    for (const ws of workspaces) {
      prompt += `- **${ws.name}** (id: ${ws.id})${ws.description ? `: ${ws.description}` : ''}\n`;
    }
  }

  if (sessionContext) {
    prompt += `\n## 会话上下文\n\n${sessionContext}\n`;
  }

  prompt += `\n## 用户消息\n\n${message}`;
  return prompt;
}

export function buildPermissionJudgeSystemPrompt(): string {
  return `你是 系统的权限审批器。你的职责是判断一个工具调用是否应该被允许执行。

## 输出格式

你必须只输出一个 JSON 对象：

{
  "allowed": true/false,
  "reason": "<判断原因>",
  "conditions": "<附加条件（可选）>",
  "correction": {
    "instruction": "<给 Agent 的调整指令（可选）>",
    "forbidTools": ["<禁止使用的工具名>", ...]
  }
}

correction 字段是可选的。当你拒绝请求时，可以通过 correction 提供替代建议或限制：
- instruction: 建议 Agent 换一种方式完成任务
- forbidTools: 明确禁止 Agent 后续使用某些工具

## 判断规则

- 对用户文件的读取操作通常是安全的
- 文件修改/删除操作需要谨慎，但在代码任务上下文中通常允许
- 网络请求需要评估目标是否可信
- 系统命令执行需要评估命令是否有破坏性
- 考虑当前任务上下文：如果工具调用与任务目标一致，倾向允许

## 安全优先

当不确定时，倾向拒绝。但不要过度限制正常的开发操作。`;
}

export function buildPermissionJudgeUserPrompt(
  toolName: string,
  toolInput: string,
  dangerLevel: DangerLevel,
  taskContext?: string,
): string {
  let prompt = `## 工具调用\n\n- 工具名: ${toolName}\n- 危险等级: ${dangerLevel}\n- 输入:\n\`\`\`\n${toolInput}\n\`\`\`\n`;
  if (taskContext) {
    prompt += `\n## 任务上下文\n\n${taskContext}`;
  }
  return prompt;
}

export function buildAskUserReviewSystemPrompt(): string {
  return `你是 系统的追问审核器。智能体在执行任务时需要向用户追问，你需要判断这个追问是否合理。

## 输出格式

你必须只输出一个 JSON 对象：

{
  "approved": true/false,
  "rewrittenQuestion": "<改写后的问题（可选，用于改善表达）>",
  "autoAnswer": "<如果不需要追问用户，你直接给出的回答（仅当 approved=false 时）>"
}

## 判断规则

- 如果追问的信息在会话上下文中已经存在，则不批准并直接回答
- 如果追问合理且必要，批准
- 可以改写问题使其更清晰`;
}

const VALID_INTENTS: RoutingIntent[] = ['chat', 'code', 'skill_test', 'learning', 'plugin', 'multi', 'workspace'];

export function parseRouteDecision(llmOutput: string): RouteDecision {
  try {
    const jsonMatch = llmOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    const parsed = JSON.parse(jsonMatch[0]);

    const intent: RoutingIntent = VALID_INTENTS.includes(parsed.intent) ? parsed.intent : 'chat';
    const targetAgent = typeof parsed.targetAgent === 'string' ? parsed.targetAgent : 'conversation';
    const priority = ['low', 'normal', 'high'].includes(parsed.priority) ? parsed.priority : 'normal';

    return {
      intent,
      targetAgent,
      targetWorkspaceId: typeof parsed.targetWorkspaceId === 'string' ? parsed.targetWorkspaceId : undefined,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
      priority,
      instruction: parsed.instruction || undefined,
      subDispatches: parsed.subDispatches || undefined,
      contextHints: parsed.contextHints || undefined,
      reason: parsed.reason || '路由决策',
    };
  } catch {
    logger.warn({ rawOutput: llmOutput.slice(0, 500) }, 'brain:route-parse-failed');
    return {
      intent: 'chat' as RoutingIntent,
      targetAgent: 'conversation',
      priority: 'normal',
      reason: 'LLM 输出解析失败，默认路由到对话',
    };
  }
}

export function parsePermissionJudge(llmOutput: string): { allowed: boolean; reason: string; conditions?: string; correction?: { instruction?: string; forbidTools?: string[] } } {
  try {
    const jsonMatch = llmOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    const parsed = JSON.parse(jsonMatch[0]);

    let correction: { instruction?: string; forbidTools?: string[] } | undefined;
    if (parsed.correction && typeof parsed.correction === 'object') {
      const instr = typeof parsed.correction.instruction === 'string' ? parsed.correction.instruction : undefined;
      const forbid = Array.isArray(parsed.correction.forbidTools) ? parsed.correction.forbidTools.filter((t: unknown) => typeof t === 'string') : undefined;
      if (instr || (forbid && forbid.length > 0)) {
        correction = { instruction: instr, forbidTools: forbid };
      }
    }

    return {
      allowed: Boolean(parsed.allowed),
      reason: typeof parsed.reason === 'string' ? parsed.reason : '未知原因',
      conditions: parsed.conditions || undefined,
      correction,
    };
  } catch {
    logger.warn({ rawOutput: llmOutput.slice(0, 500) }, 'brain:permission-parse-failed');
    return { allowed: false, reason: 'LLM 输出解析失败，默认拒绝' };
  }
}

export function parseAskUserReview(llmOutput: string): { approved: boolean; rewrittenQuestion?: string; autoAnswer?: string } {
  try {
    const jsonMatch = llmOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      approved: Boolean(parsed.approved),
      rewrittenQuestion: parsed.rewrittenQuestion || undefined,
      autoAnswer: parsed.autoAnswer || undefined,
    };
  } catch {
    return { approved: true };
  }
}

// --- Checkpoint Evaluation (Layer 3 Correction) ---

export function buildCheckpointSystemPrompt(): string {
  return `你是任务监督者。一个智能体正在执行用户任务时触发了异常信号，你需要判断是否需要干预。

## 输出格式

你必须只输出一个 JSON 对象：

{
  "action": "continue" | "adjust" | "stop" | "restart",
  "instruction": "<调整指令（仅 adjust 时必填）>",
  "newConstraints": {
    "maxRemainingTokens": <数字，可选>,
    "forbiddenTools": ["工具名", ...],
    "requiredApproach": "<建议方法>",
    "reducedTimeout": <毫秒数，可选>
  }
}

## 干预级别

- **continue**: 方向正确，无需干预（误报/轻微问题，Agent 能自行恢复）
- **adjust**: 方向有偏差，给出调整指令让 Agent 修正方向（不重启）
- **stop**: 无法完成或不应继续，终止并回复用户当前状态
- **restart**: 完全走错方向，需要换个方法或 Agent 重来

## 判断原则

1. Agent 自主性优先 — 大部分情况选 continue
2. 连续失败通常因为方法错误 — 考虑 adjust 改变工具或策略
3. 如果已消耗 70%+ 预算但离目标很远 — 考虑 stop
4. 只有明确走错方向（任务理解错误）才选 restart`;
}

export function buildCheckpointUserPrompt(payload: TurnCheckpointPayload): string {
  const { trigger, context } = payload;
  const m = context.metrics;

  let prompt = `## 用户原始请求\n\n${context.userMessage}\n`;

  if (context.routeInstruction) {
    prompt += `\n## 给 Agent 的执行指令\n\n${context.routeInstruction}\n`;
  }

  prompt += `\n## 当前状态\n\n`;
  prompt += `- 已用 output token: ${m.tokenUsed.output}/${context.budget.maxOutputTokens}\n`;
  prompt += `- 工具调用: ${m.toolCallCount} 次\n`;
  prompt += `- 连续失败: ${m.consecutiveToolFailures} 次\n`;
  prompt += `- 同工具重复: ${m.sameToolRepeatCount} 次 (${m.lastToolName ?? 'N/A'})\n`;
  prompt += `- 触发原因: ${trigger}\n`;

  if (context.recentOutputs.length > 0) {
    prompt += `\n## 最近产出\n\n`;
    for (const out of context.recentOutputs) {
      prompt += `- ${out}\n`;
    }
  }

  if (context.failedTools.length > 0) {
    prompt += `\n## 失败记录\n\n`;
    for (const ft of context.failedTools) {
      prompt += `- ${ft.name}: ${ft.error} (${ft.count}次)\n`;
    }
  }

  return prompt;
}

const VALID_ACTIONS: CorrectionAction[] = ['continue', 'adjust', 'stop', 'restart'];

export function parseCheckpointResult(llmOutput: string, delegationId: string): TurnCorrectionPayload {
  try {
    const jsonMatch = llmOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    const parsed = JSON.parse(jsonMatch[0]);

    const action: CorrectionAction = VALID_ACTIONS.includes(parsed.action) ? parsed.action : 'continue';

    return {
      delegationId,
      action,
      instruction: typeof parsed.instruction === 'string' ? parsed.instruction : undefined,
      newConstraints: parsed.newConstraints && typeof parsed.newConstraints === 'object'
        ? {
            maxRemainingTokens: typeof parsed.newConstraints.maxRemainingTokens === 'number' ? parsed.newConstraints.maxRemainingTokens : undefined,
            forbiddenTools: Array.isArray(parsed.newConstraints.forbiddenTools) ? parsed.newConstraints.forbiddenTools : undefined,
            requiredApproach: typeof parsed.newConstraints.requiredApproach === 'string' ? parsed.newConstraints.requiredApproach : undefined,
            reducedTimeout: typeof parsed.newConstraints.reducedTimeout === 'number' ? parsed.newConstraints.reducedTimeout : undefined,
          }
        : undefined,
    };
  } catch {
    return { delegationId, action: 'continue' };
  }
}

// --- Superior Review (P5a) ---

export function buildSuperiorReviewSystemPrompt(): string {
  return `你是上级 Agent 的审核模块。你的职责是评估下级 Agent 的输出质量，判断是否应该通过。

## 输出格式

你必须只输出一个 JSON 对象：

{
  "verdict": "approve" | "modify" | "reject",
  "modifiedResponse": "<修改后的回复（仅 modify 时必填）>",
  "reason": "<一句话说明判断原因>"
}

## 审核标准

1. **准确性** — 回复内容是否正确、无误导
2. **完整性** — 是否充分回答了用户的问题
3. **安全性** — 是否存在安全风险或不当操作
4. **质量** — 表达是否清晰、专业

## 审核级别

- **approve**: 质量达标，直接通过
- **modify**: 基本方向正确但需要小调整（你提供修改版本）
- **reject**: 方向错误、质量严重不达标、存在安全风险（下级需重做）

## 原则

- 倾向通过：小瑕疵用 modify 而非 reject
- 只有严重问题才 reject
- 考虑下级 Agent 的信任等级：信任越高，审核越宽松`;
}

export function buildSuperiorReviewUserPrompt(request: SuperiorReviewRequest): string {
  let prompt = `## 下级 Agent 信息\n\n`;
  prompt += `- 名称: ${request.agentName}\n`;
  prompt += `- 信任等级: ${request.trustLevel}\n`;
  prompt += `- 审核链深度: ${request.chainDepth}\n`;

  prompt += `\n## 用户原始消息\n\n${request.userMessage}\n`;
  prompt += `\n## 下级回复草稿\n\n${request.draftResponse}\n`;

  if (request.toolCalls.length > 0) {
    prompt += `\n## 工具调用记录\n\n`;
    for (const tc of request.toolCalls) {
      prompt += `- [${tc.name}] 输入: ${tc.input.slice(0, 200)}\n  结果: ${tc.result.slice(0, 200)}\n`;
    }
  }

  return prompt;
}

const VALID_VERDICTS: SuperiorReviewVerdict[] = ['approve', 'modify', 'reject'];

export function parseSuperiorReviewResult(llmOutput: string, delegationId: string, superiorId: string, correlationId: string): SuperiorReviewResult {
  try {
    const jsonMatch = llmOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    const parsed = JSON.parse(jsonMatch[0]);

    const verdict: SuperiorReviewVerdict = VALID_VERDICTS.includes(parsed.verdict) ? parsed.verdict : 'approve';

    return {
      delegationId,
      correlationId,
      superiorId,
      verdict,
      modifiedResponse: typeof parsed.modifiedResponse === 'string' ? parsed.modifiedResponse : undefined,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    };
  } catch {
    return { delegationId, correlationId, superiorId, verdict: 'approve', reason: 'LLM 输出解析失败，默认通过' };
  }
}

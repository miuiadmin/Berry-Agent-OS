/**
 * @deprecated Use src/agents/bundled/evolution/ instead.
 * This agent is retained for backward compatibility during migration.
 * The evolution agent provides the same capabilities with a cleaner interface
 * per 6.0 §3.2 (Evolution Agent).
 */
import { EvolutionEngine } from '../../../evolution/index.js';
import type { AgentTaskPayload } from '../../../contracts/tasks.js';
import { getDb, startModuleAgent } from '../../module-agent.js';
import { detectLearningSignals, parseLearningSignalsFromText } from '../../../evolution/detector.js';
import { checkEvolutionTriggers, type EvolutionTriggerSignal } from '../../../observability/evolution-metrics.js';
import { runInsightsLifecycle } from '../../../kernel/insights-lifecycle.js';
import { genId } from '../../../utils/id.js';

/**
 * 13.0 §12.3: 构建 mission 上下文前缀。
 * 当 agent 在 mission 框架下工作时，将 mission 目标注入 LLM prompt，
 * 让 LLM 知道自己的工作在更大的任务中的位置。
 */
function buildMissionPrefix(missionPrompt?: string): string {
  if (!missionPrompt) return '';
  return `## 当前 Mission 上下文\n\n${missionPrompt}\n\n---\n\n`;
}

startModuleAgent(async (payload: AgentTaskPayload, context) => {
  const input = payload.inputPayload;
  const taskType = String(input.taskType ?? 'learning_review');

  if (taskType === 'metric_analysis') {
    return await handleMetricAnalysis(payload, context);
  }

  // Legacy learning review path
  const message = String(input.message ?? input.userMessage ?? '');
  const assistantResponse = String(input.assistantResponse ?? '');
  const engine = new EvolutionEngine(getDb());
  const turn = {
    sessionId: payload.sessionId,
    userMessage: message,
    assistantResponse,
  };
  const useLlm = input.useLlm === true;
  let signals = detectLearningSignals(message, assistantResponse);
  let llmUsed = false;
  if (useLlm) {
    // 13.0: 注入 mission 上下文到 learning LLM prompt
    const missionPrefix = buildMissionPrefix(context.missionPrompt);
    const llmResult = await context.llm.chat(
      [{ role: 'user', content: missionPrefix + buildLearningPrompt(message, assistantResponse) }],
      {
        agent: 'learning',
        purpose: 'learning_review',
        sessionId: payload.sessionId,
        taskId: payload.taskId,
        maxTokens: 1200,
        temperature: 0.2,
      },
    );
    const llmSignals = parseLearningSignalsFromText(llmResult.content);
    if (llmSignals.length > 0) {
      signals = llmSignals;
      llmUsed = true;
    }
  }

  const result = engine.runSignals(turn, signals);
  return {
    kind: 'learning_review',
    llmUsed,
    proposals: result.proposals.map((proposal) => ({
      id: proposal.id,
      type: proposal.type,
      targetName: proposal.targetName,
      status: proposal.status,
    })),
    applied: result.applied,
    skippedReason: result.skippedReason,
  };
});

async function handleMetricAnalysis(
  payload: AgentTaskPayload,
  context: { llm: import('../../../llm/index.js').LlmClient; missionPrompt?: string },
): Promise<Record<string, unknown>> {
  const db = getDb();

  // Run insights lifecycle cleanup (validate promoted, expire stale)
  let lifecycle = runInsightsLifecycle(db);

  const triggers = checkEvolutionTriggers();
  if (triggers.length === 0) {
    return { kind: 'metric_analysis', insights: [], lifecycle, reason: 'no triggers fired' };
  }

  // Gather recent brain decisions for context
  const recentDecisions = db.prepare(`
    SELECT decision_type, input_summary, output_json, outcome
    FROM brain_decisions
    WHERE created_at > ?
    ORDER BY created_at DESC LIMIT 20
  `).all(Date.now() - 3600_000) as Array<Record<string, unknown>>;

  // 13.0: 注入 mission 上下文到 metric analysis prompt
  const missionPrefix = buildMissionPrefix(context.missionPrompt);
  const llmResult = await context.llm.chat(
    [{ role: 'user', content: missionPrefix + buildMetricAnalysisPrompt(triggers, recentDecisions) }],
    {
      agent: 'learning',
      purpose: 'learning_review',
      sessionId: payload.sessionId,
      taskId: payload.taskId,
      maxTokens: 1500,
      temperature: 0.3,
    },
  );

  const insights = parseInsightsFromText(llmResult.content);

  // Store insights in system_insights table
  for (const insight of insights) {
    try {
      db.prepare(`
        INSERT INTO system_insights (id, category, title, content, confidence, status, source_decisions, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'tentative', ?, ?, ?)
      `).run(
        genId('ins'),
        insight.category,
        insight.insight.slice(0, 100),
        JSON.stringify({ insight: insight.insight, suggestion: insight.suggestion, evidence: insight.evidence }),
        insight.confidence,
        JSON.stringify(triggers.map(t => t.type)),
        Date.now(),
        Date.now(),
      );
    } catch {
      // table may not exist during migration
    }
  }

  // Run lifecycle again after storing new insights
  lifecycle = runInsightsLifecycle(db);

  return {
    kind: 'metric_analysis',
    triggersDetected: triggers.map(t => t.type),
    insights: insights.map(i => ({ category: i.category, insight: i.insight })),
    lifecycle,
  };
}

function buildMetricAnalysisPrompt(
  triggers: EvolutionTriggerSignal[],
  recentDecisions: Array<Record<string, unknown>>,
): string {
  const triggerSummary = triggers.map(t =>
    `- ${t.type}: 当前值 ${(t.currentRate * 100).toFixed(1)}%, 阈值 ${(t.threshold * 100).toFixed(1)}%, 样本量 ${t.sampleSize}`,
  ).join('\n');

  const decisionSummary = recentDecisions.slice(0, 10).map(d =>
    `[${d.decision_type}] ${(d.input_summary as string).slice(0, 80)} → outcome=${d.outcome ?? 'pending'}`,
  ).join('\n');

  return `你是系统进化的参谋。以下指标异常已触发分析：

触发信号：
${triggerSummary}

近期 Brain 决策样本：
${decisionSummary || '（无记录）'}

请分析原因并提出改进建议。输出 JSON 数组：
[
  {
    "category": "routing|review|permission|evolution|performance",
    "insight": "简明发现描述（一句话）",
    "evidence": ["支持此发现的证据"],
    "confidence": 0.0-1.0,
    "suggestion": "具体改进建议"
  }
]

规则：
- 只基于提供的数据分析，不编造数据。
- 建议必须具体可执行（如"路由 prompt 应增加 X 情境"）。
- confidence 低于 0.4 的不要输出。
- 没有洞察时输出 []。`;
}

function parseInsightsFromText(text: string): Array<{
  category: string;
  insight: string;
  evidence: string[];
  confidence: number;
  suggestion: string;
}> {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item: any) => item.category && item.insight && item.confidence >= 0.4)
      .map((item: any) => ({
        category: item.category,
        insight: String(item.insight).slice(0, 500),
        evidence: Array.isArray(item.evidence) ? item.evidence.slice(0, 5) : [],
        confidence: Math.min(1, Math.max(0, Number(item.confidence))),
        suggestion: String(item.suggestion ?? '').slice(0, 500),
      }));
  } catch {
    return [];
  }
}

function buildLearningPrompt(userMessage: string, assistantResponse: string): string {
  return `你是系统的 Learning Agent。请判断这轮对话是否值得沉淀为 Skill 或 Plugin。

规则：
- Skill 适合长期偏好、输出格式、工作方式、提示词策略。
- Plugin 适合可执行工具、自动化、一键处理、集成外部系统。
- 只输出 JSON 数组，不要输出其他文字。
- 每个对象字段：kind(skill|plugin), targetName, description, observations(string[]), riskLevel(low|medium|high)。
- 没有值得沉淀的内容时输出 []。

用户消息：
${userMessage}

助手回复：
${assistantResponse}
`;
}

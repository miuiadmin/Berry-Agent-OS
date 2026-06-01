import type { AgentTaskPayload } from '../../../contracts/tasks.js';
import { getDb, startModuleAgent } from '../../module-agent.js';
import { checkEvolutionTriggers } from '../../../observability/evolution-metrics.js';
import { genId } from '../../../utils/id.js';

startModuleAgent(async (payload: AgentTaskPayload, context) => {
  const input = payload.inputPayload;
  const taskType = String(input.taskType ?? 'extract_feedback');
  const db = getDb();

  switch (taskType) {
    case 'extract_feedback':
      return await handleExtractFeedback(payload, context, db);
    case 'generate_skill':
      return await handleGenerateSkill(payload, context, db);
    case 'detect_gap':
      return await handleDetectGap(payload, context, db);
    case 'analyze_metrics':
      return await handleAnalyzeMetrics(payload, context, db);
    case 'produce_insight':
      return await handleProduceInsight(payload, context, db);
    case 'plugin_review':
      return await handlePluginReview(payload, context, db);
    default:
      return { kind: taskType, error: `Unknown evolution task type: ${taskType}` };
  }
});

async function handleExtractFeedback(
  payload: AgentTaskPayload,
  context: { llm: import('../../../llm/client.js').LlmClient },
  db: import('better-sqlite3').Database,
): Promise<Record<string, unknown>> {
  const { brainDecisionId, userMessage, assistantResponse } = payload.inputPayload as {
    brainDecisionId?: string;
    userMessage: string;
    assistantResponse: string;
  };

  const result = await context.llm.chat(
    [{ role: 'user', content: buildFeedbackPrompt(userMessage, assistantResponse) }],
    {
      agent: 'evolution',
      purpose: 'learning_review',
      sessionId: payload.sessionId,
      taskId: payload.taskId,
      maxTokens: 256,
      temperature: 0.1,
    },
  );

  const feedback = parseFeedback(result.content);
  if (!feedback) return { kind: 'extract_feedback', outcome: null };

  const targetId = brainDecisionId ?? resolveLatestDecisionId(db, payload.sessionId);
  if (targetId && feedback.outcome) {
    try {
      db.prepare(`UPDATE brain_decisions SET outcome = ?, resolved_at = ? WHERE id = ?`)
        .run(feedback.outcome, Date.now(), targetId);
    } catch { /* table may not exist */ }
  }

  return { kind: 'extract_feedback', ...feedback };
}

async function handleGenerateSkill(
  payload: AgentTaskPayload,
  context: { llm: import('../../../llm/client.js').LlmClient },
  db: import('better-sqlite3').Database,
): Promise<Record<string, unknown>> {
  const { signal, existingSkills } = payload.inputPayload as {
    signal: { type: string; description: string; evidence: string[] };
    existingSkills?: string[];
  };

  const result = await context.llm.chat(
    [{ role: 'user', content: buildSkillPrompt(signal, existingSkills ?? []) }],
    {
      agent: 'evolution',
      purpose: 'skill_generation',
      sessionId: payload.sessionId,
      taskId: payload.taskId,
      maxTokens: 2048,
      temperature: 0.3,
    },
  );

  return { kind: 'generate_skill', action: parseSkillAction(result.content), content: result.content };
}

async function handleDetectGap(
  payload: AgentTaskPayload,
  context: { llm: import('../../../llm/client.js').LlmClient },
  db: import('better-sqlite3').Database,
): Promise<Record<string, unknown>> {
  const { recentToolFailures, recentPermissionDenials } = payload.inputPayload as {
    recentToolFailures?: string[];
    recentPermissionDenials?: string[];
  };

  if (!recentToolFailures?.length && !recentPermissionDenials?.length) {
    return { kind: 'detect_gap', gaps: [] };
  }

  const result = await context.llm.chat(
    [{ role: 'user', content: buildGapPrompt(recentToolFailures ?? [], recentPermissionDenials ?? []) }],
    {
      agent: 'evolution',
      purpose: 'learning_review',
      sessionId: payload.sessionId,
      taskId: payload.taskId,
      maxTokens: 512,
      temperature: 0.2,
    },
  );

  return { kind: 'detect_gap', gaps: parseGaps(result.content) };
}

async function handleAnalyzeMetrics(
  payload: AgentTaskPayload,
  context: { llm: import('../../../llm/client.js').LlmClient },
  db: import('better-sqlite3').Database,
): Promise<Record<string, unknown>> {
  const triggers = checkEvolutionTriggers();
  if (triggers.length === 0) {
    return { kind: 'analyze_metrics', triggers: [], insights: [] };
  }

  const recentDecisions = db.prepare(`
    SELECT decision_type, input_summary, output_json, outcome
    FROM brain_decisions WHERE created_at > ? ORDER BY created_at DESC LIMIT 20
  `).all(Date.now() - 3600_000) as Array<Record<string, unknown>>;

  const result = await context.llm.chat(
    [{ role: 'user', content: buildMetricsPrompt(triggers, recentDecisions) }],
    {
      agent: 'evolution',
      purpose: 'learning_review',
      sessionId: payload.sessionId,
      taskId: payload.taskId,
      maxTokens: 1024,
      temperature: 0.3,
    },
  );

  return { kind: 'analyze_metrics', triggers: triggers.map(t => t.type), analysis: result.content };
}

async function handleProduceInsight(
  payload: AgentTaskPayload,
  _context: { llm: import('../../../llm/client.js').LlmClient },
  db: import('better-sqlite3').Database,
): Promise<Record<string, unknown>> {
  const { insight, evidence } = payload.inputPayload as { insight: string; evidence: string[] };

  try {
    db.prepare(`
      INSERT INTO brain_decisions (id, session_id, decision_type, input_summary, output_json, outcome, created_at)
      VALUES (?, ?, 'aggregated_insight', ?, ?, 'good', ?)
    `).run(genId('bdec'), payload.sessionId, evidence.join('; ').slice(0, 500), JSON.stringify({ insight, evidence }), Date.now());
  } catch { /* table may not exist */ }

  return { kind: 'produce_insight', stored: true, insight };
}

function buildFeedbackPrompt(userMessage: string, response: string): string {
  return `评估 Brain 这轮决策是否正确。输出 JSON: {"outcome": "success"|"failure"|"user_correction"|null, "reason": "简短说明"}

用户没纠正 → success
用户纠正了 → user_correction
明显错误但用户没说 → failure
无法判断 → null

用户: ${userMessage.slice(0, 200)}
回复: ${response.slice(0, 200)}`;
}

function buildSkillPrompt(signal: { type: string; description: string; evidence: string[] }, existing: string[]): string {
  return `根据以下信号决定 Skill 动作。

信号: ${signal.type} — ${signal.description}
证据: ${signal.evidence.join('; ')}
现有 Skills: ${existing.join(', ') || '无'}

动作优先级:
1. patch 现有 Skill（添加小节）
2. 扩展 umbrella Skill
3. 新建（必须是类级别命名）

输出: {"action": "patch"|"extend"|"create", "target": "skill-name", "content": "SKILL.md 内容"}`;
}

function buildGapPrompt(failures: string[], denials: string[]): string {
  return `分析以下失败/拒绝是否表明能力缺口。输出 JSON 数组: [{"gap": "描述", "suggestion": "skill|plugin"}]

工具失败: ${failures.join('; ')}
权限拒绝: ${denials.join('; ')}

如果都是正常情况（用户误操作、临时网络问题），输出 []。`;
}

function buildMetricsPrompt(triggers: Array<{ type: string; currentRate: number; threshold: number }>, decisions: Array<Record<string, unknown>>): string {
  const triggerLines = triggers.map(t => `${t.type}: ${(t.currentRate * 100).toFixed(0)}% (阈值 ${(t.threshold * 100).toFixed(0)}%)`).join('\n');
  const decisionLines = decisions.slice(0, 10).map(d => `[${d.decision_type}] ${(d.input_summary as string).slice(0, 60)}`).join('\n');
  return `指标异常分析。\n\n触发: \n${triggerLines}\n\n近期决策:\n${decisionLines}\n\n输出分析和建议。`;
}

function parseFeedback(text: string): { outcome: string | null; reason: string } | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    return { outcome: parsed.outcome ?? null, reason: parsed.reason ?? '' };
  } catch { return null; }
}

function parseSkillAction(text: string): string {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return 'unknown';
    return JSON.parse(match[0]).action ?? 'unknown';
  } catch { return 'unknown'; }
}

function parseGaps(text: string): Array<{ gap: string; suggestion: string }> {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]).filter((g: any) => g.gap);
  } catch { return []; }
}

function resolveLatestDecisionId(db: import('better-sqlite3').Database, sessionId: string): string | null {
  try {
    const row = db.prepare(
      `SELECT id FROM brain_decisions WHERE session_id = ? AND decision_type IN ('route','review','permission') ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as { id: string } | undefined;
    return row?.id ?? null;
  } catch { return null; }
}

async function handlePluginReview(
  payload: AgentTaskPayload,
  context: { llm: import('../../../llm/client.js').LlmClient },
  db: import('better-sqlite3').Database,
): Promise<Record<string, unknown>> {
  const { pluginId, pluginName, manifest } = payload.inputPayload as {
    pluginId: string;
    pluginName: string;
    manifest: Record<string, unknown>;
  };

  const prompt = `审核新插件是否应该启用。输出 JSON: {"approved": true/false, "reason": "原因", "risk": "low"|"medium"|"high"}

插件名: ${pluginName}
ID: ${pluginId}
功能: ${manifest.description ?? '无描述'}
工具: ${manifest.hasTools ? '有' : '无'}
代码: ${manifest.hasCode ? '有' : '无'}
服务: ${manifest.hasService ? '有' : '无'}

规则:
- 无代码且无服务的纯提示插件 → 低风险，通常批准
- 有代码执行能力 → 中风险，检查是否有破坏性操作
- 有后台服务 → 高风险，需要更严格审查
- 如果不确定 → 拒绝并说明原因`;

  const result = await context.llm.chat(
    [{ role: 'user', content: prompt }],
    { agent: 'evolution', purpose: 'plugin_review', sessionId: payload.sessionId, taskId: payload.taskId, maxTokens: 256, temperature: 0.1 },
  );

  try {
    const match = result.content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in LLM response');
    const review = JSON.parse(match[0]);
    const status = review.approved ? 'enabled' : 'failed';
    db.prepare('UPDATE plugins_meta SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), pluginId);
    return { kind: 'plugin_review', pluginName, approved: review.approved, reason: review.reason, risk: review.risk };
  } catch (err) {
    const { getLogger } = await import('../../../utils/logger.js');
    getLogger('evolution').debug({ err, pluginName, raw: result.content.slice(0, 200) }, 'plugin review parse failed');
    return { kind: 'plugin_review', pluginName, approved: false, reason: 'Review parse failed' };
  }
}
